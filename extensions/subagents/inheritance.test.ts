import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({
  invocations: [] as Array<{ args: string[]; env?: NodeJS.ProcessEnv }>,
  capabilityReports: [] as Array<{
    tools: Array<{ name: string; provider: string }>;
    extensionPaths: string[];
  }>,
  promptFailures: [] as Error[],
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
      private readonly promptFailure: Error | undefined;

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
        this.promptFailure = rpc.promptFailures.shift();
        rpc.children.push(this);
      }

      async request(command: Record<string, unknown>): Promise<unknown> {
        this.requests.push(command);
        if (command.type === "get_state") return { sessionFile: this.sessionFile };
        if (command.type === "get_last_assistant_text") return { text: "done" };
        return undefined;
      }

      async prompt(message: string): Promise<void> {
        this.requests.push({ type: "prompt", message });
        if (this.promptFailure) throw this.promptFailure;
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
    rpc.promptFailures.length = 0;
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

  it("forces nested starts and continuations direct when delivery is omitted or conflicts", async () => {
    process.env.OMPI_SUBAGENT_LINEAGE = JSON.stringify({
      version: 1,
      depth: 2,
      maxDepth: 3,
      maxChildren: 2,
    });
    const { tools, ctx, messages } = setup();
    (ctx as any).mode = "rpc";

    let startCompleted = false;
    const starting = tools.get("subagent_start").execute(
      "start",
      { prompt: "one" },
      undefined,
      undefined,
      ctx,
    ).then((result: unknown) => {
      startCompleted = true;
      return result;
    });
    await vi.waitFor(() => expect(rpc.children).toHaveLength(1));
    expect(startCompleted).toBe(false);
    await settle(0);
    await expect(starting).resolves.toMatchObject({
      details: { id: 1, outcome: "completed", sessionRef: "/sessions/1.jsonl" },
    });

    let continueCompleted = false;
    const continuing = tools.get("subagent_continue").execute(
      "continue",
      { id: 1, prompt: "two", delivery: "async" },
      undefined,
      undefined,
      ctx,
    ).then((result: unknown) => {
      continueCompleted = true;
      return result;
    });
    await vi.waitFor(() => expect(rpc.children).toHaveLength(2));
    expect(continueCompleted).toBe(false);
    await settle(1);
    await expect(continuing).resolves.toMatchObject({
      details: { id: 1, outcome: "completed", sessionRef: "/sessions/1.jsonl" },
    });

    const omittedContinuation = tools.get("subagent_continue").execute(
      "continue-omitted",
      { id: 1, prompt: "three" },
      undefined,
      undefined,
      ctx,
    );
    await vi.waitFor(() => expect(rpc.children).toHaveLength(3));
    await settle(2);
    await expect(omittedContinuation).resolves.toMatchObject({
      details: { id: 1, outcome: "completed", sessionRef: "/sessions/1.jsonl" },
    });
    expect(messages).toEqual([]);
  });

  it("forces a conflicting async nested start to remain direct", async () => {
    process.env.OMPI_SUBAGENT_LINEAGE = JSON.stringify({
      version: 1,
      depth: 2,
      maxDepth: 3,
      maxChildren: 2,
    });
    const { tools, ctx, messages } = setup();
    (ctx as any).mode = "rpc";

    const starting = tools.get("subagent_start").execute(
      "start",
      { prompt: "one", delivery: "async" },
      undefined,
      undefined,
      ctx,
    );
    await vi.waitFor(() => expect(rpc.children).toHaveLength(1));
    await settle(0);
    await expect(starting).resolves.toMatchObject({
      details: { id: 1, outcome: "completed", sessionRef: "/sessions/1.jsonl" },
    });
    expect(messages).toEqual([]);
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

  it("preserves compact direct-child activity for a root RPC client", async () => {
    const { tools, ctx, startSession, statuses, widgets } = setup();
    await startSession("rpc");

    await tools.get("subagent_start").execute(
      "start",
      { prompt: "root RPC child", name: "worker" },
      undefined,
      undefined,
      ctx,
    );

    expect(statuses.at(-1)).toEqual({
      key: "subagents",
      text: "direct: 1 • nested: 0 • total: 1",
    });
    expect(widgets.at(-1)).toMatchObject({
      key: "subagents",
      lines: [expect.stringContaining("#1 worker · running")],
    });
    expect(statuses.some((status) => status.key === "ompi:subagents:ownership-v1")).toBe(false);
  });

  it("refreshes and clears root footer counts from nested ownership", async () => {
    const { tools, ctx, startSession, statuses, widgets } = setup();
    await startSession("rpc");
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

    expect(statuses.findLast((status) => status.key === "subagents")).toEqual({
      key: "subagents",
      text: "direct: 1 • nested: 1 • total: 2",
    });
    expect(widgets.at(-1)).toMatchObject({
      key: "subagents",
      lines: [expect.stringContaining("#1 coordinator · running")],
    });
    expect(widgets.at(-1)?.lines?.join(" ")).not.toContain("leaf");

    await settle(0);

    expect(statuses.findLast((status) => status.key === "subagents")).toEqual({
      key: "subagents",
      text: undefined,
    });
    expect(widgets.at(-1)).toEqual({ key: "subagents", lines: undefined });
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

  it("keeps tool and command direct-conversation inventories identically bounded", async () => {
    const { tools, commands, ctx, notifications } = setup();
    const start = tools.get("subagent_start");

    for (let index = 0; index < 25; index += 1) {
      await start.execute(
        `start-${index}`,
        { prompt: `turn ${index}`, name: `worker-${index}-${"n".repeat(300)}` },
        undefined,
        undefined,
        ctx,
      );
      await settle(index);
    }

    const toolList = await tools.get("subagent_list").execute();
    await commands.get("sublist").handler("", ctx);

    expect(toolList.details).toMatchObject({ total: 25, omitted: 5 });
    expect(toolList.details.subagents).toHaveLength(20);
    expect(toolList.content[0].text).toContain(
      "[5 known conversations omitted; all active entries shown]",
    );
    expect(toolList.content[0].text.length).toBeLessThanOrEqual(16_000);
    expect(notifications.at(-1)).toBe(toolList.content[0].text);
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
    const running = tools.get("subagent_start").execute(
      "start",
      { prompt: "nested leaf" },
      undefined,
      undefined,
      ctx,
    );
    await vi.waitFor(() => expect(rpc.children).toHaveLength(1));
    await vi.waitFor(() => {
      const status = statuses.findLast(
        (candidate) => candidate.key === "ompi:subagents:ownership-v1",
      );
      expect(JSON.parse(status?.text ?? "").ownership[0]?.state).toBe("running");
    });
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
    await running;
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

    const rejectedStart = tools.get("subagent_start").execute(
      "start",
      { prompt: "not accepted" },
      undefined,
      undefined,
      ctx,
    );
    await expect(rejectedStart).rejects.toThrow("definitely rejected before the prompt crossed");
    await expect(rejectedStart).rejects.toThrow("bash (expected builtin, missing)");
    await expect(rejectedStart).rejects.not.toThrow("blindly retry");
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
    const rejectedContinuation = tools.get("subagent_continue").execute(
      "continue",
      { id: 2, prompt: "not accepted either" },
      undefined,
      undefined,
      ctx,
    );
    await expect(rejectedContinuation).rejects.toThrow("definitely rejected before the prompt crossed");
    await expect(rejectedContinuation).rejects.toThrow("bash (expected builtin, missing)");
    await expect(rejectedContinuation).rejects.not.toThrow("blindly retry");
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
      expect(tool.parameters.properties.delivery.enum).toEqual(["async", "direct"]);
      expect(tool.parameters.properties.delivery.description).toContain("root TUI is always async");
      expect(tool.description).toContain("root TUI is async");
      expect(tool.description).toContain("managed nested lineage are direct");
      expect(tool.description).toContain("root RPC defaults async while honoring explicit direct");
      expect(tool.description).toContain("explicit user request");
      expect(tool.description).toContain("<provider>/<model>");
      expect(tool.promptGuidelines.join(" ")).toContain("only when the user explicitly requests");
      expect(tool.promptGuidelines.join(" ")).toContain("qualified <provider>/<model> form");
      expect(tool.promptGuidelines.join(" ")).toContain("Omit every unrequested override");
      expect(tool.promptGuidelines.join(" ")).toContain("parent's active route");
      expect(tool.promptGuidelines.join(" ")).not.toContain("openai-codex/gpt-5.6-sol");
      expect(tool.promptGuidelines.join(" ")).toContain("PI_PROVIDER, PI_MODEL, and PI_REASONING_LEVEL");
      expect(tool.promptGuidelines.join(" ")).toContain("Do not inspect routing on ordinary turns");
      expect(tool.promptGuidelines.join(" ")).toContain("selected mechanically from runtime mode and managed lineage");
      expect(tool.promptGuidelines.join(" ")).toContain("root TUI ignores conflicting direct input");
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

  it.each([
    ["async root TUI", "tui", undefined],
    ["direct print", "print", "async"],
  ] as const)("reports post-boundary clean-start failure as unknown in %s delivery", async (_label, mode, delivery) => {
    const { tools, ctx, messages } = setup();
    (ctx as any).mode = mode;
    rpc.promptFailures.push(new Error("fixture transport failed after write"));

    const dispatch = tools.get("subagent_start").execute(
      "uncertain-start",
      { prompt: "perform one effect", ...(delivery ? { delivery } : {}) },
      undefined,
      undefined,
      ctx,
    );

    await expect(dispatch).rejects.toThrow("acceptance is unknown");
    await expect(dispatch).rejects.toThrow("Do not blindly retry");
    await expect(dispatch).rejects.toThrow("fixture transport failed after write");
    await expect(dispatch).rejects.toThrow("/sessions/1.jsonl");
    const list = await tools.get("subagent_list").execute();
    expect(list.details.subagents).toMatchObject([{
      id: 1,
      state: "acceptance-unknown",
      active: false,
      sessionRef: "/sessions/1.jsonl",
    }]);
    expect(messages).toEqual([]);
  });

  it("bounds unknown-acceptance errors while preserving the original cause", async () => {
    const { tools, ctx } = setup();
    const original = new Error(`transport detail: ${"e".repeat(8_000)}`);
    rpc.promptFailures.push(original);
    let captured: unknown;

    try {
      await tools.get("subagent_start").execute(
        "bounded-uncertainty",
        { prompt: "perform one effect" },
        undefined,
        undefined,
        ctx,
      );
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toHaveLength(4_000);
    expect((captured as Error).message).toContain("Do not blindly retry");
    expect((captured as Error).message).toContain("/sessions/1.jsonl");
    expect((captured as Error).message).toContain("characters omitted");
    expect((captured as Error).cause).toBe(original);
  });

  it.each([
    ["async root TUI", "tui", undefined],
    ["direct print", "print", "async"],
  ] as const)("reports post-boundary continuation failure as unknown in %s delivery", async (_label, mode, delivery) => {
    const { tools, ctx, messages } = setup();
    (ctx as any).mode = mode;
    const start = tools.get("subagent_start");
    const continuation = tools.get("subagent_continue");

    const starting = start.execute("seed", { prompt: "seed", delivery: "direct" }, undefined, undefined, ctx);
    if (mode === "print") {
      await vi.waitFor(() => expect(rpc.children).toHaveLength(1));
      await settle(0);
      await starting;
    } else {
      await starting;
      await settle(0);
    }
    rpc.promptFailures.push(new Error("fixture continuation transport failed after write"));

    const dispatch = continuation.execute(
      "uncertain-continuation",
      { id: 1, prompt: "perform another effect", ...(delivery ? { delivery } : {}) },
      undefined,
      undefined,
      ctx,
    );

    await expect(dispatch).rejects.toThrow("acceptance is unknown");
    await expect(dispatch).rejects.toThrow("Do not blindly retry");
    await expect(dispatch).rejects.toThrow("fixture continuation transport failed after write");
    await expect(dispatch).rejects.toThrow("/sessions/1.jsonl");
    const list = await tools.get("subagent_list").execute();
    expect(list.details.subagents).toMatchObject([{
      id: 1,
      state: "acceptance-unknown",
      active: false,
      sessionRef: "/sessions/1.jsonl",
    }]);
    expect(messages).toHaveLength(mode === "tui" ? 1 : 0);
  });

  it("forces a conflicting direct root TUI start to return after acceptance and pong exactly once", async () => {
    const { tools, ctx, messages } = setup();
    const start = tools.get("subagent_start");
    expect(start.parameters.properties.delivery.enum).toEqual(["async", "direct"]);

    await expect(start.execute(
      "start",
      { prompt: "one", delivery: "direct" },
      undefined,
      undefined,
      ctx,
    )).resolves.toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("accepted the prompt") }],
    });
    expect(messages).toEqual([]);

    await settle(0);
    expect(messages).toHaveLength(1);
    rpc.children[0].emit({ type: "agent_settled" });
    expect(messages).toHaveLength(1);
  });

  it("forces a conflicting direct root TUI continuation to return after acceptance and pong once", async () => {
    const { tools, ctx, messages } = setup();
    await tools.get("subagent_start").execute(
      "start",
      { prompt: "one" },
      undefined,
      undefined,
      ctx,
    );
    await settle(0);
    expect(messages).toHaveLength(1);

    await expect(tools.get("subagent_continue").execute(
      "continue",
      { id: 1, prompt: "two", delivery: "direct" },
      undefined,
      undefined,
      ctx,
    )).resolves.toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("accepted the continuation") }],
    });
    expect(messages).toHaveLength(1);

    await settle(1);
    expect(messages).toHaveLength(2);
  });

  it("keeps accepted root TUI async siblings alive when a later turn is cancelled", async () => {
    const { tools, ctx, messages } = setup();
    const start = tools.get("subagent_start");
    const laterTurn = new AbortController();

    await start.execute("one", { prompt: "one" }, undefined, undefined, ctx);
    await start.execute(
      "two",
      { prompt: "two", delivery: "direct" },
      laterTurn.signal,
      undefined,
      ctx,
    );
    expect(rpc.children).toHaveLength(2);

    laterTurn.abort();
    expect(rpc.children.every((child) => !child.closed)).toBe(true);
    await Promise.all([settle(0), settle(1)]);
    expect(messages).toHaveLength(2);
  });

  it("preserves root RPC defaults and explicit direct delivery for start and continuation", async () => {
    const { tools, ctx, messages } = setup();
    (ctx as any).mode = "rpc";
    const start = tools.get("subagent_start");
    const continuation = tools.get("subagent_continue");

    await expect(start.execute(
      "async-start",
      { prompt: "one" },
      undefined,
      undefined,
      ctx,
    )).resolves.toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("accepted the prompt") }],
    });
    await settle(0);

    await expect(continuation.execute(
      "async-continuation",
      { id: 1, prompt: "two" },
      undefined,
      undefined,
      ctx,
    )).resolves.toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("accepted the continuation") }],
    });
    await settle(1);
    expect(messages).toHaveLength(2);

    const directContinuation = continuation.execute(
      "direct-continuation",
      { id: 1, prompt: "three", delivery: "direct" },
      undefined,
      undefined,
      ctx,
    );
    await vi.waitFor(() => expect(rpc.children).toHaveLength(3));
    await settle(2);
    await expect(directContinuation).resolves.toMatchObject({
      details: { id: 1, outcome: "completed", sessionRef: "/sessions/1.jsonl" },
    });

    const directStart = start.execute(
      "direct-start",
      { prompt: "four", delivery: "direct" },
      undefined,
      undefined,
      ctx,
    );
    await vi.waitFor(() => expect(rpc.children).toHaveLength(4));
    await settle(3);
    await expect(directStart).resolves.toMatchObject({
      details: { id: 2, outcome: "completed", sessionRef: "/sessions/4.jsonl" },
    });
    expect(messages).toHaveLength(2);
  });

  it("preserves root JSON default async and explicit direct delivery", async () => {
    const { tools, ctx, messages } = setup();
    (ctx as any).mode = "json";
    const start = tools.get("subagent_start");
    const continuation = tools.get("subagent_continue");

    await expect(start.execute(
      "json-async-start",
      { prompt: "one" },
      undefined,
      undefined,
      ctx,
    )).resolves.toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("accepted the prompt") }],
    });
    await settle(0);
    expect(messages).toHaveLength(1);

    const directContinuation = continuation.execute(
      "json-direct-continuation",
      { id: 1, prompt: "two", delivery: "direct" },
      undefined,
      undefined,
      ctx,
    );
    await vi.waitFor(() => expect(rpc.children).toHaveLength(2));
    await settle(1);
    await expect(directContinuation).resolves.toMatchObject({
      details: { id: 1, outcome: "completed", sessionRef: "/sessions/1.jsonl" },
    });
    expect(messages).toHaveLength(1);
  });

  it("returns the terminal subagent result directly in print mode without a pong follow-up", async () => {
    const { tools, ctx, messages } = setup();
    (ctx as any).mode = "print";
    const start = tools.get("subagent_start");
    let completed = false;

    const running = start.execute(
      "start",
      { prompt: "one", delivery: "async" },
      undefined,
      undefined,
      ctx,
    )
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

    const continuing = continuation.execute(
      "continue",
      { id: 1, prompt: "two", delivery: "async" },
      undefined,
      undefined,
      ctx,
    );
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

  it("forces conflicting direct JSON slash commands in the root TUI to stay async", async () => {
    const { commands, ctx, messages, notifications } = setup();

    await commands.get("sub").handler(
      '{"prompt":"one","delivery":"direct"}',
      ctx,
    );
    expect(notifications).toEqual(["Subagent #1 started."]);
    expect(messages).toEqual([]);
    await settle(0);

    await commands.get("subcont").handler(
      '{"id":1,"prompt":"two","delivery":"direct"}',
      ctx,
    );
    expect(notifications).toEqual([
      "Subagent #1 started.",
      "Subagent #1 continued.",
    ]);
    await settle(1);
    expect(messages).toHaveLength(2);
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
