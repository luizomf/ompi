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
        rpc.invocations.push(invocation);
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

  it("removes model and thinking from both agent-facing schemas", () => {
    const { tools } = setup();
    for (const name of ["subagent_start", "subagent_continue"]) {
      const properties = tools.get(name).parameters.properties;
      expect(properties).not.toHaveProperty("model");
      expect(properties).not.toHaveProperty("thinking");
    }
  });

  it("re-reads active routing for every tool dispatch and ignores extra override fields", async () => {
    const { tools, ctx, setThinking } = setup();
    const start = tools.get("subagent_start");
    const continuation = tools.get("subagent_continue");

    await start.execute("start", {
      prompt: "one",
      model: "attacker/start",
      thinking: "max",
    }, undefined, undefined, ctx);
    expect(valueAfter(rpc.invocations[0].args, "--model")).toBe("provider/first");
    expect(valueAfter(rpc.invocations[0].args, "--thinking")).toBe("low");
    await settle(0);

    (ctx as any).model = { provider: "provider", id: "second" };
    setThinking("high");
    await continuation.execute("continue", {
      id: 1,
      prompt: "two",
      model: "attacker/continue",
      thinking: "off",
    }, undefined, undefined, ctx);
    expect(valueAfter(rpc.invocations[1].args, "--model")).toBe("provider/second");
    expect(valueAfter(rpc.invocations[1].args, "--thinking")).toBe("high");
  });

  it("ignores routing overrides in /sub and /subcont JSON", async () => {
    const { commands, ctx, notifications, setThinking } = setup();

    await commands.get("sub").handler(
      '{"prompt":"one","model":"attacker/start","thinking":"max"}',
      ctx,
    );
    expect(valueAfter(rpc.invocations[0].args, "--model")).toBe("provider/first");
    expect(valueAfter(rpc.invocations[0].args, "--thinking")).toBe("low");
    await settle(0);

    (ctx as any).model = { provider: "provider", id: "third" };
    setThinking("xhigh");
    await commands.get("subcont").handler(
      '{"id":1,"prompt":"two","model":"attacker/continue","thinking":"off"}',
      ctx,
    );
    expect(valueAfter(rpc.invocations[1].args, "--model")).toBe("provider/third");
    expect(valueAfter(rpc.invocations[1].args, "--thinking")).toBe("xhigh");
    expect(notifications.every((message) => !message.includes("attacker"))).toBe(true);
  });
});
