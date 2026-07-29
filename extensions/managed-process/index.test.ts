import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { registerManagedProcessExtension } from "./index.ts";

interface RegisteredTool {
  name: string;
  description: string;
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

    await handlers.get("session_start")?.({}, ctx);
    const start = await tools[0].execute("start-1", {
      executable: process.execPath,
      args: ["--input-type=module", "--eval", "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);"],
    }, undefined, undefined, ctx);
    expect(start.content[0].text).toContain("started");
    expect(statuses).toContain("managed processes: 1");

    const list = await tools[1].execute("list-1", {}, undefined, undefined, ctx);
    expect(list.content[0].text).toContain("#1 running");
    expect(list.content[0].text).toContain("started:");
    await expect.poll(async () => (await tools[2].execute("output-1", { id: 1 }, undefined, undefined, ctx)).content[0].text).toContain("ready");

    const stop = await tools[3].execute("stop-1", { id: 1 }, undefined, undefined, ctx);
    expect(stop.content[0].text).toMatch(/#1 (exited|signaled)/);
    await handlers.get("session_shutdown")?.({}, ctx);
    expect(statuses.at(-1)).toBeUndefined();
  });
});
