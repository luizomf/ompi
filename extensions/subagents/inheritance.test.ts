import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({
  invocations: [] as Array<{ args: string[]; env?: NodeJS.ProcessEnv }>,
  capabilityReports: [] as Array<{
    tools: Array<{ name: string; provider: string }>;
    extensionPaths: string[];
  }>,
  children: [] as Array<{
    closed: boolean;
    requests: Array<Record<string, unknown>>;
    onDialog?: (request: any, signal: AbortSignal) => Promise<any>;
    emit(event: any): void;
  }>,
}));

vi.mock("./rpc-child.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./rpc-child.ts")>();
  return {
    ...actual,
    RpcSubprocess: class {
      closed = false;
      requests: Array<Record<string, unknown>> = [];
      private listeners: Array<(event: any) => void> = [];
      private readonly sessionFile: string;
      private readonly capabilities: {
        tools: Array<{ name: string; provider: string }>;
        extensionPaths: string[];
      };

      readonly onDialog?: (request: any, signal: AbortSignal) => Promise<any>;

      constructor(
        invocation: { args: string[]; env?: NodeJS.ProcessEnv },
        options?: { onDialog?: (request: any, signal: AbortSignal) => Promise<any> },
      ) {
        this.onDialog = options?.onDialog;
        rpc.invocations.push({ args: invocation.args, env: invocation.env });
        const sessionIndex = invocation.args.indexOf("--session");
        this.sessionFile = sessionIndex >= 0
          ? invocation.args[sessionIndex + 1]
          : `/sessions/${rpc.children.length + 1}.jsonl`;
        const toolsIndex = invocation.args.indexOf("--tools");
        const names = toolsIndex >= 0 ? invocation.args[toolsIndex + 1].split(",") : [];
        this.capabilities = rpc.capabilityReports.shift() ?? {
          tools: names.map((name) => ({ name, provider: "builtin" })),
          extensionPaths: [],
        };
        rpc.children.push(this);
      }

      async request(command: Record<string, unknown>): Promise<unknown> {
        this.requests.push(command);
        if (command.type === "get_state") return { sessionFile: this.sessionFile };
        if (command.type === "get_last_assistant_text") return { text: "done" };
        return undefined;
      }

      async getCapabilities() {
        return this.capabilities;
      }

      onEvent(listener: (event: any) => void): () => void {
        this.listeners.push(listener);
        return () => undefined;
      }

      onExit(): () => void {
        return () => undefined;
      }

      emit(event: any): void {
        for (const listener of this.listeners) listener(event);
      }

      async close(): Promise<void> {
        this.closed = true;
      }
    },
  };
});

import subagentsExtension from "./index.ts";

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

function setup() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const messages: unknown[] = [];
  const activityEvents: Array<{ channel: string; data: unknown }> = [];
  const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
  let thinking = "low";
  let activeTools = ["read", "bash", "edit", "write"];
  let configuredTools = ["read", "bash", "edit", "write", "grep", "find", "ls"].map((name) => ({
    name,
    description: `${name} description`,
    parameters: {},
    sourceInfo: {
      source: "builtin",
      path: `<builtin:${name}>`,
      scope: "temporary",
      origin: "top-level",
    },
  }));
  const pi = {
    registerTool: (tool: { name: string }) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: unknown) => commands.set(name, command),
    registerMessageRenderer: () => undefined,
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    getThinkingLevel: () => thinking,
    getActiveTools: () => [...activeTools],
    getAllTools: () => configuredTools.map((tool) => ({ ...tool })),
    sendMessage: (message: unknown) => messages.push(message),
    events: {
      emit: (channel: string, data: unknown) => activityEvents.push({ channel, data }),
    },
  } as unknown as ExtensionAPI;
  const notifications: string[] = [];
  const statuses: Array<{ key: string; text?: string }> = [];
  const widgets: Array<{ key: string; lines?: string[] }> = [];
  const ctx = {
    cwd: "/repo",
    mode: "tui",
    model: { provider: "provider", id: "first" },
    ui: {
      notify: (message: string) => notifications.push(message),
      setWidget: (key: string, lines?: string[]) => widgets.push({ key, lines }),
      setStatus: (key: string, text?: string) => statuses.push({ key, text }),
      theme: { fg: (_color: string, text: string) => text },
    },
  } as unknown as ExtensionContext;

  subagentsExtension(pi);
  return {
    tools,
    commands,
    ctx,
    messages,
    notifications,
    statuses,
    widgets,
    activityEvents,
    startSession: async (mode: ExtensionContext["mode"] = "tui") => {
      (ctx as any).mode = mode;
      for (const handler of handlers.get("session_start") ?? []) {
        await handler({ type: "session_start", reason: "startup" }, ctx);
      }
    },
    setThinking: (level: string) => { thinking = level; },
    setCapabilities: (
      active: string[],
      configured: typeof configuredTools,
    ) => {
      activeTools = [...active];
      configuredTools = configured.map((tool) => ({ ...tool }));
    },
  };
}

async function settle(index: number): Promise<void> {
  rpc.children[index].emit({
    type: "message_end",
    message: { role: "assistant", stopReason: "stop" },
  });
  rpc.children[index].emit({ type: "agent_settled" });
  await vi.waitFor(() => expect(rpc.children[index].closed).toBe(true));
}

describe("subagent routing inheritance", () => {
  beforeEach(() => {
    delete process.env.OMPI_SUBAGENT_LINEAGE;
    rpc.invocations.length = 0;
    rpc.capabilityReports.length = 0;
    rpc.children.length = 0;
  });

  it("keeps delegation visible at maximum depth and rejects before launch", async () => {
    process.env.OMPI_SUBAGENT_LINEAGE = JSON.stringify({
      version: 1,
      depth: 3,
      maxDepth: 3,
      maxChildren: 2,
    });
    const { tools, ctx } = setup();

    expect(tools.has("subagent_start")).toBe(true);
    expect(process.env.OMPI_SUBAGENT_LINEAGE).toBeUndefined();
    await expect(tools.get("subagent_start").execute(
      "start",
      { prompt: "too deep" },
      undefined,
      undefined,
      ctx,
    )).rejects.toThrow("maximum delegation depth 3");
    expect(rpc.invocations).toEqual([]);
  });

  it("lets a nested parent opt out with a zero direct-child ceiling", async () => {
    process.env.OMPI_SUBAGENT_LINEAGE = JSON.stringify({
      version: 1,
      depth: 2,
      maxDepth: 3,
      maxChildren: 0,
    });
    const { tools, ctx } = setup();

    await expect(tools.get("subagent_start").execute(
      "start",
      { prompt: "not launched" },
      undefined,
      undefined,
      ctx,
    )).rejects.toThrow("At most 0 direct subagents");
    expect(rpc.invocations).toEqual([]);
  });

  it("publishes active turns for session-level status integrations", async () => {
    const { tools, ctx, activityEvents } = setup();

    await tools.get("subagent_start").execute(
      "start",
      { prompt: "inspect the status seam" },
      undefined,
      undefined,
      ctx,
    );

    expect(activityEvents.at(-1)).toEqual({
      channel: "ompi:async-activity",
      data: { source: "subagents", active: 1 },
    });

    await settle(0);
    expect(activityEvents.at(-1)).toEqual({
      channel: "ompi:async-activity",
      data: { source: "subagents", active: 0 },
    });
  });

  it("returns nested active state only when ownership status is requested", async () => {
    const { tools, ctx } = setup();
    await tools.get("subagent_start").execute(
      "start",
      { prompt: "coordinate", name: "coordinator" },
      undefined,
      undefined,
      ctx,
    );
    rpc.children[0].emit({
      type: "subagent_ownership",
      ownership: [{
        path: [7],
        parentPath: [],
        id: 7,
        depth: 3,
        state: "running",
        name: "leaf",
        model: "provider/leaf",
        thinking: "medium",
      }],
    });

    const result = await tools.get("subagent_status").execute();
    expect(result.details.nodes).toEqual([
      { runtimeId: "self", depth: 1, state: "current" },
      expect.objectContaining({
        runtimeId: "1",
        parentRuntimeId: "self",
        managementId: 1,
        depth: 2,
        state: "running",
        name: "coordinator",
      }),
      expect.objectContaining({
        runtimeId: "1/7",
        parentRuntimeId: "1",
        managementId: 7,
        depth: 3,
        state: "running",
        name: "leaf",
      }),
    ]);
    expect(result.content[0].text).not.toContain("coordinate");
  });

  it("relays a child dialog mechanically to the root TUI", async () => {
    const { tools, ctx, startSession, messages } = setup();
    const dialogs: unknown[] = [];
    (ctx.ui as any).confirm = async (title: string, message: string, options: unknown) => {
      dialogs.push({ title, message, options });
      return true;
    };
    await startSession("tui");
    await tools.get("subagent_start").execute(
      "start",
      { prompt: "ask the user" },
      undefined,
      undefined,
      ctx,
    );
    const relay = rpc.children[0].onDialog;
    expect(relay).toBeDefined();
    if (!relay) throw new Error("Child dialog relay was not installed.");
    const signal = new AbortController().signal;

    await expect(relay({
      id: "dialog-1",
      method: "confirm",
      title: "Approve?",
      message: "Continue with the operation?",
    }, signal)).resolves.toEqual({ confirmed: true });
    expect(dialogs).toEqual([{
      title: "Approve?",
      message: "Continue with the operation?",
      options: { signal, timeout: 30_000 },
    }]);
    expect(messages).toEqual([]);
  });

  it("fails a root headless dialog closed without invoking a parent model or UI", async () => {
    const { tools, ctx, startSession } = setup();
    (ctx.ui as any).confirm = async () => {
      throw new Error("Headless root UI must not be called.");
    };
    await startSession("rpc");
    await tools.get("subagent_start").execute(
      "start",
      { prompt: "ask without a root TUI" },
      undefined,
      undefined,
      ctx,
    );
    const relay = rpc.children[0].onDialog;
    if (!relay) throw new Error("Child dialog relay was not installed.");

    await expect(relay({
      id: "dialog-2",
      method: "confirm",
      title: "Approve?",
      message: "No TUI exists.",
    }, new AbortController().signal)).resolves.toEqual({ cancelled: true });
  });

  it("allows a nested RPC owner to forward a dialog to its parent transport", async () => {
    process.env.OMPI_SUBAGENT_LINEAGE = JSON.stringify({
      version: 1,
      depth: 2,
      maxDepth: 3,
      maxChildren: 2,
    });
    const { tools, ctx, startSession, statuses, widgets } = setup();
    const forwarded: string[] = [];
    (ctx.ui as any).input = async (title: string) => {
      forwarded.push(title);
      return "root user value";
    };
    await startSession("rpc");
    await tools.get("subagent_start").execute(
      "start",
      { prompt: "nested leaf" },
      undefined,
      undefined,
      ctx,
    );
    const ownershipStatus = statuses.findLast(
      (status) => status.key === "ompi:subagents:ownership-v1",
    );
    expect(JSON.parse(ownershipStatus?.text ?? "")).toEqual({
      version: 1,
      ownership: [{
        path: [1],
        parentPath: [],
        id: 1,
        depth: 3,
        state: "running",
        model: "provider/first",
        thinking: "low",
      }],
    });
    expect(ownershipStatus?.text).not.toContain("nested leaf");
    expect(statuses.every((status) => status.key === "ompi:subagents:ownership-v1")).toBe(true);
    expect(widgets).toEqual([]);
    const relay = rpc.children[0].onDialog;
    if (!relay) throw new Error("Nested child dialog relay was not installed.");

    await expect(relay({
      id: "dialog-3",
      method: "input",
      title: "Value from root user",
    }, new AbortController().signal)).resolves.toEqual({ value: "root user value" });
    expect(forwarded).toEqual(["Value from root user"]);

    await settle(0);
    const clearedStatus = statuses.findLast(
      (status) => status.key === "ompi:subagents:ownership-v1",
    );
    expect(JSON.parse(clearedStatus?.text ?? "")).toEqual({ version: 1, ownership: [] });
  });

  it("inherits each then-active extension tool and provider on start and continuation", async () => {
    const { tools, ctx, setCapabilities } = setup();
    const builtins = ["read", "bash"].map((name) => ({
      name,
      description: `${name} description`,
      parameters: {},
      sourceInfo: {
        source: "builtin",
        path: `<builtin:${name}>`,
        scope: "temporary",
        origin: "top-level",
      },
    }));
    const extensionTool = {
      name: "browser_fetch",
      description: "Fetch a rendered page",
      parameters: {},
      sourceInfo: {
        source: "cli",
        path: "/extensions/browser-fetch/index.ts",
        scope: "temporary",
        origin: "top-level",
      },
    };
    setCapabilities(["read", "browser_fetch"], [...builtins, extensionTool]);
    rpc.capabilityReports.push({
      tools: [
        { name: "read", provider: "builtin" },
        { name: "browser_fetch", provider: "/extensions/browser-fetch/index.ts" },
      ],
      extensionPaths: ["/extensions/browser-fetch/index.ts"],
    });

    await tools.get("subagent_start").execute(
      "start",
      { prompt: "one", name: "reviewer" },
      undefined,
      undefined,
      ctx,
    );
    expect(valueAfter(rpc.invocations[0].args, "--tools")).toBe("read,browser_fetch");
    expect(valueAfter(rpc.invocations[0].args, "--extension")).toBe(
      "/extensions/browser-fetch/index.ts",
    );
    await settle(0);

    setCapabilities(["bash", "browser_fetch"], [...builtins, extensionTool]);
    rpc.capabilityReports.push({
      tools: [
        { name: "bash", provider: "builtin" },
        { name: "browser_fetch", provider: "/extensions/browser-fetch/index.ts" },
      ],
      extensionPaths: ["/extensions/browser-fetch/index.ts"],
    });
    await tools.get("subagent_continue").execute(
      "continue",
      { id: 1, prompt: "two" },
      undefined,
      undefined,
      ctx,
    );

    expect(valueAfter(rpc.invocations[1].args, "--tools")).toBe("bash,browser_fetch");
    expect(valueAfter(rpc.invocations[1].args, "--extension")).toBe(
      "/extensions/browser-fetch/index.ts",
    );
  });

  it("treats tools as monotonic restrictions and gives names no hidden capability effect", async () => {
    const { tools, ctx, setCapabilities } = setup();
    const configured = ["read", "write"].map((name) => ({
      name,
      description: `${name} description`,
      parameters: {},
      sourceInfo: {
        source: "builtin",
        path: `<builtin:${name}>`,
        scope: "temporary",
        origin: "top-level",
      },
    }));
    setCapabilities(["read"], configured);

    await tools.get("subagent_start").execute(
      "named",
      { prompt: "one", name: "writer" },
      undefined,
      undefined,
      ctx,
    );
    expect(valueAfter(rpc.invocations[0].args, "--tools")).toBe("read");

    await expect(tools.get("subagent_start").execute(
      "escalate",
      { prompt: "two", tools: ["write"] },
      undefined,
      undefined,
      ctx,
    )).rejects.toThrow(
      "Restrictions can only keep tools active in the parent. Unavailable: write.",
    );
    expect(rpc.invocations).toHaveLength(1);

    await tools.get("subagent_start").execute(
      "empty",
      { prompt: "three", tools: [] },
      undefined,
      undefined,
      ctx,
    );
    expect(rpc.invocations[1].args).toContain("--no-tools");
  });

  it("rejects start and continuation capability mismatches before prompt acceptance", async () => {
    const { tools, ctx } = setup();
    rpc.capabilityReports.push({
      tools: [{ name: "read", provider: "builtin" }],
      extensionPaths: [],
    });

    await expect(tools.get("subagent_start").execute(
      "start",
      { prompt: "not accepted" },
      undefined,
      undefined,
      ctx,
    )).rejects.toThrow("bash (expected builtin, missing)");
    expect(rpc.children[0].requests).not.toContainEqual(
      expect.objectContaining({ type: "prompt" }),
    );
    expect(rpc.children[0].closed).toBe(true);

    rpc.capabilityReports.push({
      tools: ["read", "bash", "edit", "write"].map((name) => ({ name, provider: "builtin" })),
      extensionPaths: [],
    });
    await tools.get("subagent_start").execute(
      "accepted",
      { prompt: "one" },
      undefined,
      undefined,
      ctx,
    );
    await settle(1);

    rpc.capabilityReports.push({
      tools: [{ name: "read", provider: "builtin" }],
      extensionPaths: [],
    });
    await expect(tools.get("subagent_continue").execute(
      "continue",
      { id: 2, prompt: "not accepted either" },
      undefined,
      undefined,
      ctx,
    )).rejects.toThrow("bash (expected builtin, missing)");
    expect(rpc.children[2].requests).not.toContainEqual(
      expect.objectContaining({ type: "prompt" }),
    );
    expect(rpc.children[2].closed).toBe(true);
  });

  it("exposes opt-in routing schemas and default-routing guidance", () => {
    const { tools } = setup();

    for (const name of ["subagent_start", "subagent_continue"]) {
      const tool = tools.get(name);
      expect(tool.parameters.properties).not.toHaveProperty("provider");
      expect(tool.parameters.properties).not.toHaveProperty("thinking");
      expect(tool.parameters.properties.model.minLength).toBe(1);
      expect(tool.parameters.properties.model.description).toContain("<provider>/<model>");
      expect(tool.parameters.properties.model.description).toContain("openai-codex/gpt-5.6-luna");
      expect(tool.parameters.properties.reasoning.enum).toEqual([
        "off", "minimal", "low", "medium", "high", "xhigh", "max",
      ]);
      expect(tool.description).toContain("explicit user request");
      expect(tool.description).toContain("<provider>/<model>");
      expect(tool.promptGuidelines.join(" ")).toContain("only when the user explicitly requests");
      expect(tool.promptGuidelines.join(" ")).toContain("qualified <provider>/<model> form");
      expect(tool.promptGuidelines.join(" ")).toContain("Omit every unrequested override");
      expect(tool.promptGuidelines.join(" ")).toContain("parent's active route");
      expect(tool.promptGuidelines.join(" ")).not.toContain("openai-codex/gpt-5.6-sol");
      expect(tool.promptGuidelines.join(" ")).toContain("PI_PROVIDER, PI_MODEL, and PI_REASONING_LEVEL");
      expect(tool.promptGuidelines.join(" ")).toContain("Do not inspect routing on ordinary turns");
    }
  });

  it("exposes monotonic child ceilings and passes tightened values mechanically", async () => {
    const { tools, ctx } = setup();
    const start = tools.get("subagent_start");
    const continuation = tools.get("subagent_continue");

    for (const tool of [start, continuation]) {
      expect(tool.parameters.properties.maxDepth).toMatchObject({ minimum: 2, maximum: 3 });
      expect(tool.parameters.properties.maxChildren).toMatchObject({ minimum: 0, maximum: 2 });
    }

    await start.execute("start", {
      prompt: "one",
      maxDepth: 2,
      maxChildren: 0,
    }, undefined, undefined, ctx);
    expect(JSON.parse(rpc.invocations[0].env?.OMPI_SUBAGENT_LINEAGE ?? "")).toEqual({
      version: 1,
      depth: 2,
      maxDepth: 2,
      maxChildren: 0,
    });
    await settle(0);

    await expect(continuation.execute("continue", {
      id: 1,
      prompt: "raise",
      maxDepth: 3,
    }, undefined, undefined, ctx)).rejects.toThrow("cannot raise");
    expect(rpc.invocations).toHaveLength(1);
  });

  it("returns an explicitly direct start outside print mode exactly once without a later pong", async () => {
    const { tools, ctx, messages } = setup();
    (ctx as any).mode = "tui";
    const start = tools.get("subagent_start");
    expect(start.parameters.properties.delivery.enum).toEqual(["async", "direct"]);
    let completed = false;

    const running = start.execute(
      "start",
      { prompt: "one", delivery: "direct" },
      undefined,
      undefined,
      ctx,
    ).then((result: unknown) => {
      completed = true;
      return result;
    });

    await vi.waitFor(() => expect(rpc.children).toHaveLength(1));
    expect(completed).toBe(false);
    await settle(0);
    rpc.children[0].emit({ type: "agent_settled" });

    await expect(running).resolves.toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("done") }],
      details: {
        id: 1,
        outcome: "completed",
        sessionRef: "/sessions/1.jsonl",
        finalText: "done",
      },
    });
    expect(messages).toEqual([]);
  });

  it("returns an explicitly direct continuation outside print mode without another pong", async () => {
    const { tools, ctx, messages } = setup();
    (ctx as any).mode = "tui";
    await tools.get("subagent_start").execute(
      "start",
      { prompt: "one" },
      undefined,
      undefined,
      ctx,
    );
    await settle(0);
    expect(messages).toHaveLength(1);

    const continuing = tools.get("subagent_continue").execute(
      "continue",
      { id: 1, prompt: "two", delivery: "direct" },
      undefined,
      undefined,
      ctx,
    );
    await vi.waitFor(() => expect(rpc.children).toHaveLength(2));
    await settle(1);

    await expect(continuing).resolves.toMatchObject({
      details: {
        id: 1,
        outcome: "completed",
        sessionRef: "/sessions/1.jsonl",
      },
    });
    expect(messages).toHaveLength(1);
  });

  it("keeps independently issued direct siblings concurrent", async () => {
    const { tools, ctx, messages } = setup();
    (ctx as any).mode = "tui";
    const start = tools.get("subagent_start");
    let completed = 0;
    const first = start.execute("one", {
      prompt: "one",
      delivery: "direct",
    }, undefined, undefined, ctx).then((result: unknown) => {
      completed += 1;
      return result;
    });
    const second = start.execute("two", {
      prompt: "two",
      delivery: "direct",
    }, undefined, undefined, ctx).then((result: unknown) => {
      completed += 1;
      return result;
    });

    await vi.waitFor(() => expect(rpc.children).toHaveLength(2));
    expect(completed).toBe(0);
    await Promise.all([settle(0), settle(1)]);
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(completed).toBe(2);
    expect(messages).toEqual([]);
  });

  it("returns the terminal subagent result directly in print mode without a pong follow-up", async () => {
    const { tools, ctx, messages } = setup();
    (ctx as any).mode = "print";
    const start = tools.get("subagent_start");
    let completed = false;

    const running = start.execute("start", { prompt: "one" }, undefined, undefined, ctx)
      .then((result: unknown) => {
        completed = true;
        return result;
      });

    await vi.waitFor(() => expect(rpc.children).toHaveLength(1));
    expect(completed).toBe(false);
    await settle(0);

    await expect(running).resolves.toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("done") }],
      details: { id: 1, outcome: "completed", finalText: "done" },
    });
    expect(messages).toEqual([]);
  });

  it("returns a terminal continuation directly in print mode", async () => {
    const { tools, ctx, messages } = setup();
    (ctx as any).mode = "print";
    const start = tools.get("subagent_start");
    const continuation = tools.get("subagent_continue");

    const starting = start.execute("start", { prompt: "one" }, undefined, undefined, ctx);
    await vi.waitFor(() => expect(rpc.children).toHaveLength(1));
    await settle(0);
    await starting;

    const continuing = continuation.execute("continue", { id: 1, prompt: "two" }, undefined, undefined, ctx);
    await vi.waitFor(() => expect(rpc.children).toHaveLength(2));
    await settle(1);

    await expect(continuing).resolves.toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("done") }],
      details: { id: 1, outcome: "completed", finalText: "done" },
    });
    expect(messages).toEqual([]);
  });

  it("uses explicit routing for a registered-tool start", async () => {
    const { tools, ctx } = setup();
    const start = tools.get("subagent_start");

    await start.execute("start", {
      prompt: "one",
      model: "requested/luna",
      reasoning: "high",
    }, undefined, undefined, ctx);

    expect(valueAfter(rpc.invocations[0].args, "--model")).toBe("requested/luna");
    expect(valueAfter(rpc.invocations[0].args, "--thinking")).toBe("high");
  });

  it("rejects a bare registered-tool model override before launch", async () => {
    const { tools, ctx } = setup();
    const start = tools.get("subagent_start");

    await expect(start.execute("start", {
      prompt: "one",
      model: "gpt-5.6-luna",
    }, undefined, undefined, ctx)).rejects.toThrow(
      'Explicit subagent model overrides must use "<provider>/<model>". Example: "openai-codex/gpt-5.6-luna".',
    );
    expect(rpc.invocations).toEqual([]);
  });

  it("uses explicit routing for a registered-tool continuation", async () => {
    const { tools, ctx } = setup();
    const start = tools.get("subagent_start");
    const continuation = tools.get("subagent_continue");

    await start.execute("start", { prompt: "one" }, undefined, undefined, ctx);
    await settle(0);
    await continuation.execute("continue", {
      id: 1,
      prompt: "two",
      model: "requested/terra",
      reasoning: "max",
    }, undefined, undefined, ctx);

    expect(valueAfter(rpc.invocations[1].args, "--model")).toBe("requested/terra");
    expect(valueAfter(rpc.invocations[1].args, "--thinking")).toBe("max");
  });

  it("rejects a bare registered-tool continuation model override before launch", async () => {
    const { tools, ctx } = setup();
    const start = tools.get("subagent_start");
    const continuation = tools.get("subagent_continue");

    await start.execute("start", { prompt: "one" }, undefined, undefined, ctx);
    await settle(0);
    await expect(continuation.execute("continue", {
      id: 1,
      prompt: "two",
      model: "gpt-5.6-luna",
    }, undefined, undefined, ctx)).rejects.toThrow("<provider>/<model>");
    expect(rpc.invocations).toHaveLength(1);
  });

  it.each(["", "/luna", "provider/", "provider /luna", "provider/luna model"])(
    "rejects malformed model override %j before launch",
    async (model) => {
      const { tools, ctx } = setup();
      const start = tools.get("subagent_start");

      await expect(start.execute("start", {
        prompt: "one",
        model,
      }, undefined, undefined, ctx)).rejects.toThrow("<provider>/<model>");
      expect(rpc.invocations).toEqual([]);
    },
  );

  it("inherits each then-active routing value when overrides are omitted", async () => {
    const { tools, ctx, setThinking } = setup();
    const start = tools.get("subagent_start");
    const continuation = tools.get("subagent_continue");

    await start.execute("start", { prompt: "one" }, undefined, undefined, ctx);
    expect(valueAfter(rpc.invocations[0].args, "--model")).toBe("provider/first");
    expect(valueAfter(rpc.invocations[0].args, "--thinking")).toBe("low");
    await settle(0);

    (ctx as any).model = { provider: "provider", id: "second" };
    setThinking("high");
    await continuation.execute("continue", {
      id: 1,
      prompt: "two",
    }, undefined, undefined, ctx);
    expect(valueAfter(rpc.invocations[1].args, "--model")).toBe("provider/second");
    expect(valueAfter(rpc.invocations[1].args, "--thinking")).toBe("high");
  });

  it("honors explicit direct delivery in JSON slash commands without a pong", async () => {
    const { commands, ctx, messages, notifications } = setup();
    const starting = commands.get("sub").handler(
      '{"prompt":"one","delivery":"direct"}',
      ctx,
    );
    await vi.waitFor(() => expect(rpc.children).toHaveLength(1));
    expect(notifications).toEqual([]);
    await settle(0);
    await starting;

    expect(messages).toEqual([]);
    expect(notifications).toEqual([
      expect.stringContaining("[SUBAGENT #1] completed"),
    ]);
  });

  it("applies JSON slash-command overrides independently per dispatch", async () => {
    const { commands, ctx, setThinking } = setup();

    await commands.get("sub").handler(
      '{"prompt":"one","model":"requested/luna"}',
      ctx,
    );
    expect(valueAfter(rpc.invocations[0].args, "--model")).toBe("requested/luna");
    expect(valueAfter(rpc.invocations[0].args, "--thinking")).toBe("low");
    await settle(0);

    (ctx as any).model = { provider: "provider", id: "second" };
    setThinking("high");
    await commands.get("subcont").handler(
      '{"id":1,"prompt":"two","reasoning":"off"}',
      ctx,
    );
    expect(valueAfter(rpc.invocations[1].args, "--model")).toBe("provider/second");
    expect(valueAfter(rpc.invocations[1].args, "--thinking")).toBe("off");
  });

  it("rejects invalid JSON slash-command routing before launch", async () => {
    const { commands, ctx, notifications } = setup();

    await commands.get("sub").handler('{"prompt":"one","model":"gpt-5.6-luna"}', ctx);
    await commands.get("sub").handler('{"prompt":"two","model":""}', ctx);
    await commands.get("sub").handler('{"prompt":"three","reasoning":"extreme"}', ctx);

    expect(rpc.invocations).toEqual([]);
    expect(notifications).toEqual([
      expect.stringContaining("<provider>/<model>"),
      expect.stringContaining("<provider>/<model>"),
      expect.stringContaining("Reasoning override must be one of"),
    ]);
  });

  it("inherits routing for JSON slash-command options when overrides are omitted", async () => {
    const { commands, ctx, setThinking } = setup();

    await commands.get("sub").handler('{"prompt":"one"}', ctx);
    expect(valueAfter(rpc.invocations[0].args, "--model")).toBe("provider/first");
    expect(valueAfter(rpc.invocations[0].args, "--thinking")).toBe("low");
    await settle(0);

    (ctx as any).model = { provider: "provider", id: "third" };
    setThinking("xhigh");
    await commands.get("subcont").handler('{"id":1,"prompt":"two"}', ctx);
    expect(valueAfter(rpc.invocations[1].args, "--model")).toBe("provider/third");
    expect(valueAfter(rpc.invocations[1].args, "--thinking")).toBe("xhigh");
  });
});
