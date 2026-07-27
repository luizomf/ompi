import {
  initTheme,
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext,
  type MessageRenderer,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createBackgroundToolManager } from "./background-tool.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function setup() {
  const messages: Array<{ message: any; options: any }> = [];
  const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
  const renderers = new Map<string, unknown>();
  const pi = {
    registerMessageRenderer: (customType: string, renderer: unknown) => renderers.set(customType, renderer),
    sendMessage: (message: unknown, options: unknown) => messages.push({ message, options }),
    on: (event: string, handler: (...args: any[]) => unknown) => {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    },
  } as unknown as ExtensionAPI;
  return { pi, messages, handlers, renderers };
}

const Params = Type.Object({ query: Type.String() });

describe("background tool wrapper", () => {
  it("rejects invalid concurrency limits before registering work", () => {
    const { pi } = setup();
    expect(() => createBackgroundToolManager(pi, { namespace: "test", maxActive: 0 })).toThrow("positive integer");
  });

  it("rejects tools whose custom result renderer cannot survive the async boundary", () => {
    const { pi } = setup();
    const manager = createBackgroundToolManager(pi, { namespace: "test" });
    const original = {
      name: "rendered_search",
      label: "Rendered Search",
      description: "Search with custom output",
      parameters: Params,
      async execute() {
        return { content: [{ type: "text" as const, text: "done" }], details: undefined };
      },
      renderResult: (() => undefined) as never,
    } satisfies ToolDefinition<typeof Params, undefined>;

    expect(() => manager.wrapReadOnly(original)).toThrow("custom result renderer");
  });

  it("returns immediately and delivers the original result once after completion", async () => {
    const { pi, messages } = setup();
    const completion = deferred<AgentToolResult<{ source: string }>>();
    const original: ToolDefinition<typeof Params, { source: string }> = {
      name: "slow_search",
      label: "Slow Search",
      description: "Search slowly",
      promptSnippet: "Run a slow search",
      promptGuidelines: ["Use slow_search for slow research."],
      parameters: Params,
      async execute() {
        return completion.promise;
      },
    };
    const manager = createBackgroundToolManager(pi, { namespace: "test" });
    const wrapped = manager.wrapReadOnly(original);

    const accepted = await wrapped.execute(
      "call-1",
      { query: "bash" },
      undefined,
      undefined,
      { cwd: "/repo" } as ExtensionContext,
    );

    expect(accepted.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Background task #1") });
    expect(accepted.details).toMatchObject({ id: 1, toolName: "slow_search", active: true });
    expect(messages).toEqual([]);
    expect(wrapped.parameters).toBe(original.parameters);
    expect(wrapped.promptGuidelines).toEqual(original.promptGuidelines);

    completion.resolve({
      content: [{ type: "text", text: "research complete" }],
      details: { source: "primary" },
    });
    await vi.waitFor(() => expect(messages).toHaveLength(1));

    expect(messages[0]).toMatchObject({
      message: {
        customType: "background-test",
        content: expect.stringContaining("research complete"),
        details: {
          id: 1,
          toolName: "slow_search",
          outcome: "completed",
          resultDetails: { source: "primary" },
        },
      },
      options: { deliverAs: "followUp", triggerTurn: true },
    });
  });

  it("collapses completed output behind Pi's native expansion state", () => {
    initTheme(undefined, false);
    const { pi, renderers } = setup();
    createBackgroundToolManager(pi, { namespace: "test" });
    const renderer = renderers.get("background-test") as MessageRenderer | undefined;
    expect(renderer).toBeDefined();
    if (!renderer) throw new Error("background renderer was not registered");
    const message = {
      role: "custom" as const,
      customType: "background-test",
      content: "[BACKGROUND #1 slow_search] completed\n\nFULL RESULT",
      display: true,
      details: { id: 1, toolName: "slow_search", outcome: "completed" as const },
      timestamp: 1,
    };
    const theme = {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
    };

    const collapsed = renderer(message, { expanded: false }, theme as never)?.render(120).join("\n");
    const expanded = renderer(message, { expanded: true }, theme as never)?.render(120).join("\n");

    expect(collapsed).toContain("[BACKGROUND #1 slow_search] completed");
    expect(collapsed).toContain("to expand");
    expect(collapsed).not.toContain("FULL RESULT");
    expect(expanded).toContain("FULL RESULT");
  });

  it("shows a minimal live count while background work is active", async () => {
    const { pi, handlers } = setup();
    const completion = deferred<AgentToolResult<undefined>>();
    const statuses: Array<[string, string | undefined]> = [];
    const original: ToolDefinition<typeof Params, undefined> = {
      name: "slow_search",
      label: "Slow Search",
      description: "Search slowly",
      parameters: Params,
      async execute() {
        return completion.promise;
      },
    };
    const manager = createBackgroundToolManager(pi, { namespace: "test" });
    const wrapped = manager.wrapReadOnly(original);
    const ctx = {
      cwd: "/repo",
      ui: { setStatus: (key: string, value: string | undefined) => statuses.push([key, value]) },
    } as unknown as ExtensionContext;

    for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
    await wrapped.execute("call-1", { query: "bash" }, undefined, undefined, ctx);
    expect(statuses.at(-1)).toEqual(["background-test", "test: 1"]);

    completion.resolve({ content: [{ type: "text", text: "done" }], details: undefined });
    await vi.waitFor(() => expect(statuses.at(-1)).toEqual(["background-test", undefined]));
  });

  it("refuses a pre-cancelled call but isolates accepted work from later turn cancellation", async () => {
    const { pi } = setup();
    const completion = deferred<AgentToolResult<undefined>>();
    const callSignals: AbortSignal[] = [];
    const original: ToolDefinition<typeof Params, undefined> = {
      name: "slow_search",
      label: "Slow Search",
      description: "Search slowly",
      parameters: Params,
      async execute(_id, _params, signal) {
        if (signal) callSignals.push(signal);
        return completion.promise;
      },
    };
    const manager = createBackgroundToolManager(pi, { namespace: "test" });
    const wrapped = manager.wrapReadOnly(original);
    const cancelled = new AbortController();
    cancelled.abort();

    await expect(wrapped.execute(
      "cancelled",
      { query: "nope" },
      cancelled.signal,
      undefined,
      { cwd: "/repo" } as ExtensionContext,
    )).rejects.toThrow("cancelled");
    expect(callSignals).toEqual([]);

    const turn = new AbortController();
    await wrapped.execute("accepted", { query: "bash" }, turn.signal, undefined, { cwd: "/repo" } as ExtensionContext);
    turn.abort();
    expect(callSignals[0]?.aborted).toBe(false);
    completion.resolve({ content: [{ type: "text", text: "done" }], details: undefined });
  });

  it("cancels active work and suppresses late completion during session shutdown", async () => {
    const { pi, messages, handlers } = setup();
    let taskSignal: AbortSignal | undefined;
    const original: ToolDefinition<typeof Params, undefined> = {
      name: "slow_search",
      label: "Slow Search",
      description: "Search slowly",
      parameters: Params,
      async execute(_id, _params, signal) {
        taskSignal = signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        });
      },
    };
    const manager = createBackgroundToolManager(pi, { namespace: "test" });
    const wrapped = manager.wrapReadOnly(original);

    await wrapped.execute("call-1", { query: "bash" }, undefined, undefined, { cwd: "/repo" } as ExtensionContext);
    expect(taskSignal?.aborted).toBe(false);

    await Promise.all((handlers.get("session_shutdown") ?? []).map((handler) => handler({}, {})));
    expect(taskSignal?.aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(messages).toEqual([]);
    await expect(wrapped.execute("call-2", { query: "late" }, undefined, undefined, { cwd: "/repo" } as ExtensionContext))
      .rejects.toThrow("shut down");
  });
});
