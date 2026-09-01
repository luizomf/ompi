import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerManagedProcessExtension } from "./index.ts";

interface RegisteredTool {
  name: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  execute(
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ): Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>;
}

describe("managed-process extension", () => {
  it("discovers its explicit lifecycle without implying an automatic completion wake", () => {
    const tools: RegisteredTool[] = [];
    const pi = {
      registerTool: (tool: RegisteredTool) => tools.push(tool),
      on: () => {},
    } as unknown as ExtensionAPI;

    registerManagedProcessExtension(pi);

    const discovery = tools.flatMap((tool) => [
      tool.description,
      tool.promptSnippet ?? "",
      ...(tool.promptGuidelines ?? []),
    ]).join(" ");
    expect(discovery).toContain("does not send a completion wake or trigger a turn when the process exits");
    expect(discovery).toContain("scheduler_submit");
    expect(discovery).toContain("run through OMQueue and wake Pi after its outcome");
    expect(discovery).toContain("finite work that should complete synchronously in the current turn");
    expect(discovery).not.toContain("use ordinary bash for finite commands");
  });

  it("keeps every active process visible while bounding terminal history and JSON-expanded detail fields", async () => {
    const tools: RegisteredTool[] = [];
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const pi = {
      registerTool: (tool: RegisteredTool) => tools.push(tool),
      on: (event: string, handler: (...args: unknown[]) => unknown) => handlers.set(event, handler),
    } as unknown as ExtensionAPI;
    const ctx = { cwd: process.cwd() } as ExtensionContext;

    registerManagedProcessExtension(pi, { now: () => 0 });

    try {
      for (let index = 0; index < 50; index += 1) {
        const result = await tools[0].execute(`terminal-${index}`, {
          executable: process.execPath,
          args: [
            "--input-type=module",
            "--eval",
            "process.exit(0)",
            ...Array.from({ length: 8 }, () => "x".repeat(4_000)),
          ],
        }, undefined, undefined, ctx);
        const id = (result.details as { id: number }).id;
        await expect.poll(async () => {
          const snapshot = await tools[1].execute("list-terminal", {}, undefined, undefined, ctx);
          const processes = (snapshot.details as { processes: Array<{ id: number; active: boolean }> }).processes;
          return processes.find((process) => process.id === id)?.active;
        }).toBe(false);
      }

      const activeIds: number[] = [];
      const controlHeavyArgument = "\u0001".repeat(7_900);
      for (let index = 0; index < 8; index += 1) {
        const result = await tools[0].execute(`active-${index}`, {
          executable: process.execPath,
          args: [
            "--eval=setInterval(() => {}, 1000)",
            ...Array.from({ length: 7 }, () => controlHeavyArgument),
          ],
        }, undefined, undefined, ctx);
        activeIds.push((result.details as { id: number }).id);
      }

      const snapshot = await tools[1].execute("list", {}, undefined, undefined, ctx);
      const text = snapshot.content[0].text;
      const details = snapshot.details as {
        processes: Array<{ id: number; active: boolean; omittedArguments: number; truncatedFields: string[] }>;
        terminalHistory: { retained: number; included: number; omitted: number };
      };

      expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(48_000);
      expect(text).toContain("Command, cwd, and diagnostic text omitted");
      expect(text).toMatch(/\[\d+ terminal process records omitted/);
      expect(Buffer.byteLength(JSON.stringify(details), "utf8")).toBeLessThanOrEqual(48_000);
      for (const activeId of activeIds) {
        expect(text).toContain(`#${activeId} running`);
        expect(details.processes).toContainEqual(expect.objectContaining({ id: activeId, active: true }));
      }
      expect(details.processes.some((process) => process.truncatedFields.includes("args"))).toBe(true);
      expect(details.processes.some((process) => process.omittedArguments === 3)).toBe(true);
      expect(details.terminalHistory).toEqual({ retained: 50, included: expect.any(Number), omitted: expect.any(Number) });
      expect(details.terminalHistory.omitted).toBeGreaterThan(0);
    } finally {
      await handlers.get("session_shutdown")?.({}, ctx);
    }
  });

  it("reports signaling failures and possible leftovers in stop content and details", async () => {
    const tools: RegisteredTool[] = [];
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const pi = {
      registerTool: (tool: RegisteredTool) => tools.push(tool),
      on: (event: string, handler: (...args: unknown[]) => unknown) => handlers.set(event, handler),
    } as unknown as ExtensionAPI;
    const ctx = { cwd: process.cwd() } as ExtensionContext;
    registerManagedProcessExtension(pi, { stopGraceMs: 20 });

    const started = await tools[0].execute("start", {
      executable: process.execPath,
      args: [
        "--input-type=module",
        "--eval",
        "process.stdout.write('ready\\n'); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
      ],
    }, undefined, undefined, ctx);
    const processView = started.details as { id: number; pgid: number };
    await expect.poll(async () => (
      await tools[2].execute("output", { id: processView.id }, undefined, undefined, ctx)
    ).content[0].text).toContain("ready");

    const originalKill = process.kill.bind(process);
    const denied = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === -processView.pgid) throw denied;
      return originalKill(pid, signal as NodeJS.Signals);
    }) as typeof process.kill);

    try {
      const stopped = await tools[3].execute("stop", { id: processView.id }, undefined, undefined, ctx);
      expect(stopped.content[0].text).toContain("cleanup failed");
      expect(stopped.content[0].text).toContain("SIGTERM: failed");
      expect(stopped.content[0].text).toContain("SIGKILL: failed");
      expect(stopped.content[0].text).toContain("group: unknown");
      expect(stopped.content[0].text).toContain("leader: missing");
      expect(stopped.content[0].text).toContain("EPERM");
      expect(stopped.content[0].text).toContain("escaped descendants may remain");
      expect(stopped.details).toMatchObject({
        id: processView.id,
        state: "cleanup_failed",
        cleanup: {
          status: "failed",
          sigterm: "failed",
          sigkill: "failed",
          group: "unknown",
          leader: "missing",
          possibleEscapedDescendants: true,
        },
      });
      expect(Buffer.byteLength(JSON.stringify(stopped.details), "utf8")).toBeLessThanOrEqual(4_000);
    } finally {
      killSpy.mockRestore();
      try { originalKill(-processView.pgid, "SIGKILL"); } catch { /* already gone */ }
      await handlers.get("session_shutdown")?.({}, ctx);
    }
  });

  it("exposes explicit session-scoped lifecycle tools and cleans up on shutdown", async () => {
    const tools: RegisteredTool[] = [];
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const statuses: Array<string | undefined> = [];
    const pi = {
      registerTool: (tool: RegisteredTool) => tools.push(tool),
      on: (event: string, handler: (...args: unknown[]) => unknown) => handlers.set(event, handler),
    } as unknown as ExtensionAPI;
    const ctx = {
      cwd: process.cwd(),
      ui: {
        theme: { fg: (_color: string, text: string) => text },
        setStatus: (_key: string, value: string | undefined) => statuses.push(value),
      },
    } as unknown as ExtensionContext;

    registerManagedProcessExtension(pi);
    expect(tools.map((tool) => tool.name)).toEqual([
      "managed_process_start",
      "managed_process_list",
      "managed_process_output",
      "managed_process_stop",
    ]);
    const discovery = tools.flatMap((tool) => [tool.description, ...(tool.promptGuidelines ?? [])]).join(" ");
    for (const boundary of ["without a shell", "inherits", "credentials", "loopback", "stdin", "TTY", "session-scoped", "process group"]) {
      expect(discovery).toContain(boundary);
    }
    for (const intent of [
      "whenever the current task genuinely requires",
      "No separate confirmation is required",
      "Expected lifecycle, not elapsed seconds",
      "direct helpers",
      "One concrete bounded output/list snapshot or readiness probe",
      "later snapshots",
      "no longer needed",
      "fallback",
    ]) {
      expect(discovery).toContain(intent);
    }

    await handlers.get("session_start")?.({}, ctx);
    const start = await tools[0].execute("start-1", {
      executable: process.execPath,
      args: ["--input-type=module", "--eval", "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);"],
    }, undefined, undefined, ctx);
    expect(start.content[0].text).toContain("The operating system accepted the spawn");
    expect(start.content[0].text).toContain("does not confirm application readiness, successful binding, eventual completion, or automatic wake delivery");
    expect(start.content[0].text).not.toContain("started and is");
    expect(statuses).toContain("managed processes: 1");

    const list = await tools[1].execute("list-1", {}, undefined, undefined, ctx);
    expect(list.content[0].text).toContain("#1 running");
    expect(list.content[0].text).toContain("started:");
    await expect.poll(async () => (await tools[2].execute("output-1", { id: 1 }, undefined, undefined, ctx)).content[0].text).toContain("ready");

    const stop = await tools[3].execute("stop-1", { id: 1 }, undefined, undefined, ctx);
    expect(stop.content[0].text).toMatch(/#1 (exited|signaled)/);
    expect(stop.content[0].text).toContain("cleanup completed");
    expect(stop.content[0].text).toContain("SIGTERM:");
    expect(stop.content[0].text).toContain("escaped descendants may remain");
    expect(stop.details).toMatchObject({
      id: 1,
      cleanup: {
        status: "completed",
        reason: "explicit",
        group: "gone",
        possibleEscapedDescendants: true,
      },
    });
    await handlers.get("session_shutdown")?.({}, ctx);
    expect(statuses.at(-1)).toBeUndefined();
  });
});
