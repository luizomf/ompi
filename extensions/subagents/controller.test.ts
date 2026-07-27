import { describe, expect, it, vi } from "vitest";
import {
  SubagentController,
  type LaunchSpec,
  type RpcChild,
  type RpcEvent,
} from "./controller.ts";

class FakeChild implements RpcChild {
  readonly requests: Array<Record<string, unknown>> = [];
  readonly spec: LaunchSpec;
  sessionFile: string;
  finalText: string | null = null;
  closed = false;
  private eventListeners: Array<(event: RpcEvent) => void> = [];
  private exitListeners: Array<(error?: Error) => void> = [];
  private promptGate?: Promise<void>;
  private releasePrompt?: () => void;

  constructor(spec: LaunchSpec, sessionFile: string, delayedPrompt = false) {
    this.spec = spec;
    this.sessionFile = sessionFile;
    if (delayedPrompt) {
      this.promptGate = new Promise((resolve) => {
        this.releasePrompt = resolve;
      });
    }
  }

  acceptPrompt(): void {
    this.releasePrompt?.();
  }

  async request(command: Record<string, unknown>): Promise<unknown> {
    this.requests.push(command);
    if (command.type === "get_state") return { sessionFile: this.sessionFile };
    if (command.type === "prompt") await this.promptGate;
    if (command.type === "get_last_assistant_text") return { text: this.finalText };
    return undefined;
  }

  onEvent(listener: (event: RpcEvent) => void): () => void {
    this.eventListeners.push(listener);
    return () => {
      this.eventListeners = this.eventListeners.filter((item) => item !== listener);
    };
  }

  onExit(listener: (error?: Error) => void): () => void {
    this.exitListeners.push(listener);
    return () => {
      this.exitListeners = this.exitListeners.filter((item) => item !== listener);
    };
  }

  emit(event: RpcEvent): void {
    for (const listener of this.eventListeners) listener(event);
  }

  crash(message = "child crashed"): void {
    for (const listener of this.exitListeners) listener(new Error(message));
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function setup(options: { delayedPrompt?: boolean; handshakeMs?: number } = {}) {
  const children: FakeChild[] = [];
  const pongs: unknown[] = [];
  const controller = new SubagentController({
    handshakeMs: options.handshakeMs ?? 100,
    createChild: async (spec) => {
      const child = new FakeChild(spec, `/sessions/${children.length + 1}.jsonl`, options.delayedPrompt);
      children.push(child);
      return child;
    },
    onPong: (pong) => pongs.push(pong),
  });
  return { controller, children, pongs };
}

async function settle(child: FakeChild): Promise<void> {
  child.emit({ type: "agent_settled" });
  await vi.waitFor(() => expect(child.closed).toBe(true));
}

describe("SubagentController", () => {
  it("returns after prompt acceptance and before completion", async () => {
    const { controller, children, pongs } = setup({ delayedPrompt: true });
    const starting = controller.start({ prompt: "inspect", cwd: "/repo", model: "p/m", thinking: "high" });
    await vi.waitFor(() => expect(children).toHaveLength(1));
    expect(controller.list()[0]?.state).toBe("handshaking");

    children[0].acceptPrompt();
    await expect(starting).resolves.toMatchObject({ id: 1, state: "running" });
    expect(children[0].spec).toMatchObject({ model: "p/m", thinking: "high" });
    expect(pongs).toEqual([]);
  });

  it("runs twelve children and rejects a thirteenth without queuing", async () => {
    const { controller, children } = setup();
    await Promise.all(Array.from({ length: 12 }, (_, index) => controller.start({ prompt: `${index}`, cwd: "/repo", model: "p/m", thinking: "low" })));
    await expect(controller.start({ prompt: "thirteenth", cwd: "/repo", model: "p/m", thinking: "low" })).rejects.toThrow("12");
    expect(children).toHaveLength(12);
  });

  it("times out pre-acceptance without a pong", async () => {
    const { controller, children, pongs } = setup({ delayedPrompt: true, handshakeMs: 5 });
    await expect(controller.start({ prompt: "slow", cwd: "/repo", model: "p/m", thinking: "low" })).rejects.toThrow("accept");
    expect(children[0].closed).toBe(true);
    expect(controller.list()).toEqual([]);
    expect(pongs).toEqual([]);
  });

  it.each(["completed", "interrupted"] as const)("emits exactly one %s pong after process close", async (outcome) => {
    const { controller, children, pongs } = setup();
    await controller.start({ prompt: "work", cwd: "/repo", model: "p/m", thinking: "medium", name: "worker" });
    children[0].finalText = "done";
    if (outcome === "interrupted") await controller.interrupt(1);
    await settle(children[0]);
    children[0].emit({ type: "agent_settled" });
    children[0].crash("late");

    expect(pongs).toHaveLength(1);
    expect(pongs[0]).toMatchObject({ id: 1, name: "worker", outcome, sessionRef: "/sessions/1.jsonl", finalText: "done" });
  });

  it("emits one failed pong when an accepted child crashes", async () => {
    const { controller, children, pongs } = setup();
    await controller.start({ prompt: "work", cwd: "/repo", model: "p/m", thinking: "medium" });
    children[0].crash("boom");
    await vi.waitFor(() => expect(pongs).toHaveLength(1));
    expect(pongs[0]).toMatchObject({ outcome: "failed", error: "boom" });
  });

  it("reports a settled assistant error as failed", async () => {
    const { controller, children, pongs } = setup();
    await controller.start({ prompt: "work", cwd: "/repo", model: "p/m", thinking: "medium" });
    children[0].emit({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "provider failed" } });
    await settle(children[0]);
    expect(pongs[0]).toMatchObject({ outcome: "failed", error: "provider failed" });
  });

  it("continues the same session with the routing values supplied for the new turn", async () => {
    const { controller, children } = setup();
    await controller.start({ prompt: "one", cwd: "/repo", model: "p/old", thinking: "low", tools: ["read"] });
    await settle(children[0]);

    await controller.continue({ id: 1, prompt: "two", model: "p/current", thinking: "high" });
    expect(children[1].spec).toMatchObject({ session: "/sessions/1.jsonl", cwd: "/repo", model: "p/current", thinking: "high", tools: ["read"] });
    await expect(controller.continue({ id: 1, prompt: "three", model: "p/current", thinking: "high" })).rejects.toThrow("active");
  });

  it("allows steering only while active", async () => {
    const { controller, children } = setup();
    await controller.start({ prompt: "one", cwd: "/repo", model: "p/m", thinking: "low" });
    await controller.steer(1, "change course");
    expect(children[0].requests).toContainEqual({ type: "steer", message: "change course" });
    await settle(children[0]);
    await expect(controller.steer(1, "late")).rejects.toThrow("not active");
  });

  it("tracks tool activity and visible text without thinking", async () => {
    const { controller, children } = setup();
    await controller.start({ prompt: "one", cwd: "/repo", model: "p/m", thinking: "low" });
    children[0].emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "secret" } });
    children[0].emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "visible" } });
    children[0].emit({ type: "tool_execution_start", toolName: "read" });
    expect(controller.list()[0]).toMatchObject({ preview: "visible", currentTool: "read" });
  });

  it("suppresses pongs and clears state on shutdown", async () => {
    const { controller, children, pongs } = setup();
    await Promise.all([
      controller.start({ prompt: "one", cwd: "/repo", model: "p/m", thinking: "low" }),
      controller.start({ prompt: "two", cwd: "/repo", model: "p/m", thinking: "low" }),
    ]);
    await controller.shutdown();
    expect(children.every((child) => child.closed)).toBe(true);
    expect(children.every((child) => child.requests.some((request) => request.type === "abort"))).toBe(true);
    expect(controller.list()).toEqual([]);
    expect(pongs).toEqual([]);
  });
});
