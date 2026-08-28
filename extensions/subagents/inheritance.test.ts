import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({
  invocations: [] as Array<{ args: string[] }>,
  children: [] as Array<{
    closed: boolean;
    emit(event: { type: string }): void;
  }>,
}));

vi.mock("./rpc-child.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./rpc-child.ts")>();
  return {
    ...actual,
    RpcSubprocess: class {
      closed = false;
      private listeners: Array<(event: { type: string }) => void> = [];
      private readonly sessionFile: string;

      constructor(invocation: { args: string[] }) {
        rpc.invocations.push({ args: invocation.args });
        const sessionIndex = invocation.args.indexOf("--session");
        this.sessionFile = sessionIndex >= 0
          ? invocation.args[sessionIndex + 1]
          : `/sessions/${rpc.children.length + 1}.jsonl`;
        rpc.children.push(this);
      }

      async request(command: Record<string, unknown>): Promise<unknown> {
        if (command.type === "get_state") return { sessionFile: this.sessionFile };
        if (command.type === "get_last_assistant_text") return { text: "done" };
        return undefined;
      }

      onEvent(listener: (event: { type: string }) => void): () => void {
        this.listeners.push(listener);
        return () => undefined;
      }

      onExit(): () => void {
        return () => undefined;
      }

      emit(event: { type: string }): void {
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
  let thinking = "low";
  const pi = {
    registerTool: (tool: { name: string }) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: unknown) => commands.set(name, command),
    registerMessageRenderer: () => undefined,
    on: () => undefined,
    getThinkingLevel: () => thinking,
    sendMessage: (message: unknown) => messages.push(message),
    events: {
      emit: (channel: string, data: unknown) => activityEvents.push({ channel, data }),
    },
  } as unknown as ExtensionAPI;
  const notifications: string[] = [];
  const ctx = {
    cwd: "/repo",
    model: { provider: "provider", id: "first" },
    ui: { notify: (message: string) => notifications.push(message) },
  } as unknown as ExtensionContext;

  subagentsExtension(pi);
  return {
    tools,
    commands,
    ctx,
    messages,
    notifications,
    activityEvents,
    setThinking: (level: string) => { thinking = level; },
  };
}

async function settle(index: number): Promise<void> {
  rpc.children[index].emit({ type: "agent_settled" });
  await vi.waitFor(() => expect(rpc.children[index].closed).toBe(true));
}

describe("subagent routing inheritance", () => {
  beforeEach(() => {
    rpc.invocations.length = 0;
    rpc.children.length = 0;
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
      expect(tool.promptGuidelines.join(" ")).toContain("orchestrator's active route");
      expect(tool.promptGuidelines.join(" ")).not.toContain("openai-codex/gpt-5.6-sol");
      expect(tool.promptGuidelines.join(" ")).toContain("PI_PROVIDER, PI_MODEL, and PI_REASONING_LEVEL");
      expect(tool.promptGuidelines.join(" ")).toContain("Do not inspect routing on ordinary turns");
    }
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
