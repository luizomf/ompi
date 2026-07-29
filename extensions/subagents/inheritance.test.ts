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
  let thinking = "low";
  const pi = {
    registerTool: (tool: { name: string }) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: unknown) => commands.set(name, command),
    registerMessageRenderer: () => undefined,
    on: () => undefined,
    getThinkingLevel: () => thinking,
    sendMessage: () => undefined,
  } as unknown as ExtensionAPI;
  const notifications: string[] = [];
  const ctx = {
    cwd: "/repo",
    model: { provider: "provider", id: "first" },
    ui: { notify: (message: string) => notifications.push(message) },
  } as unknown as ExtensionContext;

  subagentsExtension(pi);
  return { tools, commands, ctx, notifications, setThinking: (level: string) => { thinking = level; } };
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

  it("exposes opt-in routing schemas and explicit-request guidance", () => {
    const { tools } = setup();

    for (const name of ["subagent_start", "subagent_continue"]) {
      const tool = tools.get(name);
      expect(tool.parameters.properties).not.toHaveProperty("provider");
      expect(tool.parameters.properties).not.toHaveProperty("thinking");
      expect(tool.parameters.properties.model.minLength).toBe(1);
      expect(tool.parameters.properties.reasoning.enum).toEqual([
        "off", "minimal", "low", "medium", "high", "xhigh", "max",
      ]);
      expect(tool.description).toContain("explicit user request");
      expect(tool.promptGuidelines.join(" ")).toContain("only when the user explicitly requests");
      expect(tool.promptGuidelines.join(" ")).toContain("omit every unrequested override");
    }
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

    await commands.get("sub").handler('{"prompt":"one","model":""}', ctx);
    await commands.get("sub").handler('{"prompt":"two","reasoning":"extreme"}', ctx);

    expect(rpc.invocations).toEqual([]);
    expect(notifications).toHaveLength(2);
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
