import { describe, expect, it, vi } from "vitest";
import {
  PromptTransportError,
  SubagentController,
  type LaunchSpec,
  type RpcChild,
  type RpcEvent,
} from "./controller.ts";
import type { ManagedLineage } from "./lineage.ts";
import {
  BUILTIN_TOOL_PROVIDER,
  cloneCapabilities,
  type CapabilitySnapshot,
} from "./capabilities.ts";

const DEFAULT_CAPABILITIES: CapabilitySnapshot = {
  tools: [{ name: "read", provider: BUILTIN_TOOL_PROVIDER }],
  extensionPaths: [],
};

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
  private closeGate?: Promise<void>;
  private releaseClose?: () => void;
  private readonly reportedCapabilities?: CapabilitySnapshot;
  private readonly promptError?: Error;

  constructor(
    spec: LaunchSpec,
    sessionFile: string,
    delayedPrompt = false,
    reportedCapabilities?: CapabilitySnapshot,
    delayedClose = false,
    promptError?: Error,
  ) {
    this.spec = spec;
    this.sessionFile = sessionFile;
    this.reportedCapabilities = reportedCapabilities;
    this.promptError = promptError;
    if (delayedPrompt) {
      this.promptGate = new Promise((resolve) => {
        this.releasePrompt = resolve;
      });
    }
    if (delayedClose) {
      this.closeGate = new Promise((resolve) => {
        this.releaseClose = resolve;
      });
    }
  }

  acceptPrompt(): void {
    this.releasePrompt?.();
  }

  allowExit(): void {
    this.releaseClose?.();
  }

  async request(command: Record<string, unknown>): Promise<unknown> {
    this.requests.push(command);
    if (command.type === "get_state") return { sessionFile: this.sessionFile };
    if (command.type === "get_last_assistant_text") return { text: this.finalText };
    return undefined;
  }

  async prompt(message: string): Promise<void> {
    this.requests.push({ type: "prompt", message });
    if (this.promptError) throw this.promptError;
    await this.promptGate;
  }

  async getCapabilities(): Promise<CapabilitySnapshot> {
    return cloneCapabilities(this.reportedCapabilities ?? this.spec.capabilities);
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
    await this.closeGate;
    this.closed = true;
  }
}

function setup(options: {
  delayedPrompt?: boolean;
  handshakeMs?: number;
  reportedCapabilities?: CapabilitySnapshot;
  lineage?: ManagedLineage;
  delayedClose?: boolean;
  promptError?: Error;
  sessionFile?: string;
} = {}) {
  const children: FakeChild[] = [];
  const pongs: unknown[] = [];
  const controller = new SubagentController({
    handshakeMs: options.handshakeMs ?? 100,
    lineage: options.lineage,
    createChild: async (spec) => {
      const child = new FakeChild(
        spec,
        spec.session ?? options.sessionFile ?? `/sessions/${children.length + 1}.jsonl`,
        options.delayedPrompt,
        options.reportedCapabilities,
        options.delayedClose,
        options.promptError,
      );
      children.push(child);
      return child;
    },
    onPong: (pong) => pongs.push(pong),
  });
  return { controller, children, pongs };
}

async function settle(child: FakeChild): Promise<void> {
  if (child.finalText !== null) {
    child.emit({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
  }
  child.emit({ type: "agent_settled" });
  await vi.waitFor(() => expect(child.closed).toBe(true));
}

describe("SubagentController", () => {
  it("rolls back a new active record when pre-launch status publication fails", async () => {
    let launches = 0;
    const controller = new SubagentController({
      createChild: async (spec) => {
        launches++;
        return new FakeChild(spec, "/sessions/unexpected.jsonl");
      },
      onPong: () => undefined,
      onChange: () => {
        throw new Error("status publication failed");
      },
    });

    await expect(controller.start({
      prompt: "not launched",
      cwd: "/repo",
      model: "p/m",
      thinking: "low",
      capabilities: DEFAULT_CAPABILITIES,
    })).rejects.toThrow("status publication failed");
    expect(launches).toBe(0);
    expect(controller.list()).toEqual([]);
  });

  it("returns after prompt acceptance and before completion", async () => {
    const { controller, children, pongs } = setup({ delayedPrompt: true });
    const starting = controller.start({ prompt: "inspect", cwd: "/repo", model: "p/m", thinking: "high", capabilities: DEFAULT_CAPABILITIES });
    await vi.waitFor(() => expect(children).toHaveLength(1));
    expect(controller.list()[0]?.state).toBe("handshaking");

    children[0].acceptPrompt();
    await expect(starting).resolves.toMatchObject({ id: 1, state: "running" });
    expect(children[0].spec).toMatchObject({ model: "p/m", thinking: "high" });
    expect(pongs).toEqual([]);
  });

  it("waits for direct completion and returns the terminal result without emitting a pong", async () => {
    const { controller, children, pongs } = setup();
    let completed = false;
    const running = controller.run({
      prompt: "work",
      cwd: "/repo",
      model: "p/m",
      thinking: "medium",
      capabilities: DEFAULT_CAPABILITIES,
      name: "worker",
    }).then((pong) => {
      completed = true;
      return pong;
    });

    await vi.waitFor(() => expect(children).toHaveLength(1));
    expect(completed).toBe(false);
    children[0].finalText = "done";
    await settle(children[0]);

    await expect(running).resolves.toMatchObject({
      id: 1,
      name: "worker",
      outcome: "completed",
      sessionRef: "/sessions/1.jsonl",
      finalText: "done",
    });
    expect(pongs).toEqual([]);
  });

  it("runs direct sibling delegations concurrently and resolves each at its own terminal event", async () => {
    const { controller, children } = setup();
    let firstCompleted = false;
    let secondCompleted = false;
    const first = controller.run({ prompt: "one", cwd: "/repo", model: "p/m", thinking: "medium", capabilities: DEFAULT_CAPABILITIES })
      .then((pong) => { firstCompleted = true; return pong; });
    const second = controller.run({ prompt: "two", cwd: "/repo", model: "p/m", thinking: "medium", capabilities: DEFAULT_CAPABILITIES })
      .then((pong) => { secondCompleted = true; return pong; });

    await vi.waitFor(() => expect(children).toHaveLength(2));
    expect(firstCompleted).toBe(false);
    expect(secondCompleted).toBe(false);

    await settle(children[0]);
    await expect(first).resolves.toMatchObject({ id: 1, outcome: "completed" });
    expect(firstCompleted).toBe(true);
    expect(secondCompleted).toBe(false);

    await settle(children[1]);
    await expect(second).resolves.toMatchObject({ id: 2, outcome: "completed" });
  });

  it("interrupts a direct run when its caller is cancelled", async () => {
    const { controller, children, pongs } = setup();
    const cancellation = new AbortController();
    const running = controller.run(
      { prompt: "work", cwd: "/repo", model: "p/m", thinking: "medium", capabilities: DEFAULT_CAPABILITIES },
      cancellation.signal,
    );

    await vi.waitFor(() => expect(children).toHaveLength(1));
    cancellation.abort();
    await vi.waitFor(() => expect(children[0].requests).toContainEqual({ type: "abort" }));
    children[0].finalText = "stale text from an earlier turn";
    children[0].emit({ type: "agent_settled" });
    await vi.waitFor(() => expect(children[0].closed).toBe(true));

    const result = await running;
    expect(result).toMatchObject({
      outcome: "interrupted",
      sessionRef: "/sessions/1.jsonl",
    });
    expect(result.finalText).toBeUndefined();
    expect(pongs).toEqual([]);
  });

  it("rejects delegation beyond the inherited maximum depth before child launch", async () => {
    const { controller, children } = setup({
      lineage: { depth: 3, maxDepth: 3, maxChildren: 2 },
    });

    await expect(controller.start({
      prompt: "too deep",
      cwd: "/repo",
      model: "p/m",
      thinking: "low",
      capabilities: DEFAULT_CAPABILITIES,
    })).rejects.toThrow("maximum delegation depth 3");
    expect(children).toEqual([]);
  });

  it("passes caller-tightened depth and child ceilings to the managed child", async () => {
    const { controller, children } = setup();

    await controller.start({
      prompt: "coordinate without descendants",
      cwd: "/repo",
      model: "p/m",
      thinking: "low",
      capabilities: DEFAULT_CAPABILITIES,
      maxDepth: 2,
      maxChildren: 0,
    });

    expect(children[0].spec.lineage).toEqual({
      depth: 2,
      maxDepth: 2,
      maxChildren: 0,
    });
  });

  it("rejects a child ceiling above the nested parent's inherited ceiling before launch", async () => {
    const { controller, children } = setup({
      lineage: { depth: 2, maxDepth: 3, maxChildren: 1 },
    });

    await expect(controller.start({
      prompt: "raise ceiling",
      cwd: "/repo",
      model: "p/m",
      thinking: "low",
      capabilities: DEFAULT_CAPABILITIES,
      maxChildren: 2,
    })).rejects.toThrow("0 through 1");
    expect(children).toEqual([]);
  });

  it("keeps continuation depth stable and allows ceilings only to tighten", async () => {
    const { controller, children } = setup();
    const startInput = {
      prompt: "one",
      cwd: "/repo",
      model: "p/m",
      thinking: "low" as const,
      capabilities: DEFAULT_CAPABILITIES,
    };
    await controller.start(startInput);
    await settle(children[0]);

    await controller.continue({
      id: 1,
      prompt: "two",
      model: "p/m",
      thinking: "low",
      capabilities: DEFAULT_CAPABILITIES,
      maxDepth: 2,
      maxChildren: 1,
    });
    expect(children[1].spec.lineage).toEqual({ depth: 2, maxDepth: 2, maxChildren: 1 });
    await settle(children[1]);

    await expect(controller.continue({
      id: 1,
      prompt: "raise depth",
      model: "p/m",
      thinking: "low",
      capabilities: DEFAULT_CAPABILITIES,
      maxDepth: 3,
    })).rejects.toThrow("cannot raise");
    await expect(controller.continue({
      id: 1,
      prompt: "raise children",
      model: "p/m",
      thinking: "low",
      capabilities: DEFAULT_CAPABILITIES,
      maxChildren: 2,
    })).rejects.toThrow("cannot raise");
    expect(children).toHaveLength(2);
  });

  it("counts a handshaking child against the local ceiling", async () => {
    const { controller, children } = setup({
      lineage: { depth: 2, maxDepth: 3, maxChildren: 1 },
      delayedPrompt: true,
    });
    const input = {
      cwd: "/repo",
      model: "p/m",
      thinking: "low" as const,
      capabilities: DEFAULT_CAPABILITIES,
    };
    const starting = controller.start({ ...input, prompt: "one" });
    await vi.waitFor(() => expect(children).toHaveLength(1));

    await expect(controller.start({ ...input, prompt: "two" })).rejects.toThrow(
      "At most 1 direct subagents",
    );
    expect(children).toHaveLength(1);
    children[0].acceptPrompt();
    await starting;
  });

  it("counts a direct-wait child against the local ceiling", async () => {
    const { controller, children } = setup({
      lineage: { depth: 2, maxDepth: 3, maxChildren: 1 },
    });
    const input = {
      cwd: "/repo",
      model: "p/m",
      thinking: "low" as const,
      capabilities: DEFAULT_CAPABILITIES,
    };
    const running = controller.run({ ...input, prompt: "direct" });
    await vi.waitFor(() => expect(controller.list()[0]).toMatchObject({
      active: true,
      state: "running",
    }));

    await expect(controller.start({ ...input, prompt: "too early" })).rejects.toThrow(
      "At most 1 direct subagents",
    );
    await settle(children[0]);
    await expect(running).resolves.toMatchObject({ outcome: "completed" });
  });

  it("releases a finalizing child's slot only after owned process exit", async () => {
    const { controller, children } = setup({
      lineage: { depth: 2, maxDepth: 3, maxChildren: 1 },
      delayedClose: true,
    });
    const input = {
      cwd: "/repo",
      model: "p/m",
      thinking: "low" as const,
      capabilities: DEFAULT_CAPABILITIES,
    };
    await controller.start({ ...input, prompt: "one" });
    children[0].emit({ type: "agent_settled" });
    await vi.waitFor(() => expect(controller.list()[0]).toMatchObject({
      active: true,
      state: "finalizing",
    }));

    await expect(controller.start({ ...input, prompt: "too early" })).rejects.toThrow(
      "At most 1 direct subagents",
    );
    children[0].allowExit();
    await vi.waitFor(() => expect(controller.list()[0]?.active).toBe(false));
    await expect(controller.start({ ...input, prompt: "after exit" })).resolves.toMatchObject({
      state: "running",
    });
  });

  it("enforces a nested parent's local two-child ceiling before launch", async () => {
    const { controller, children } = setup({
      lineage: { depth: 2, maxDepth: 3, maxChildren: 2 },
    });
    const input = {
      cwd: "/repo",
      model: "p/m",
      thinking: "low" as const,
      capabilities: DEFAULT_CAPABILITIES,
    };

    await Promise.all([
      controller.start({ ...input, prompt: "one" }),
      controller.start({ ...input, prompt: "two" }),
    ]);
    await expect(controller.start({ ...input, prompt: "three" })).rejects.toThrow(
      "At most 2 direct subagents",
    );
    expect(children).toHaveLength(2);
  });

  it("runs twelve children and rejects a thirteenth without queuing", async () => {
    const { controller, children } = setup();
    await Promise.all(Array.from({ length: 12 }, (_, index) => controller.start({ prompt: `${index}`, cwd: "/repo", model: "p/m", thinking: "low", capabilities: DEFAULT_CAPABILITIES })));
    await expect(controller.start({ prompt: "thirteenth", cwd: "/repo", model: "p/m", thinking: "low", capabilities: DEFAULT_CAPABILITIES })).rejects.toThrow("12");
    expect(children).toHaveLength(12);
  });

  it("reports a known pre-write prompt failure as definite rejection", async () => {
    const cause = new Error("child stdin was not writable");
    const { controller, children, pongs } = setup({
      promptError: new PromptTransportError(false, cause),
    });
    let captured: unknown;

    try {
      await controller.start({
        prompt: "not sent",
        cwd: "/repo",
        model: "p/m",
        thinking: "low",
        capabilities: DEFAULT_CAPABILITIES,
      });
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toContain("definitely rejected before the prompt crossed");
    expect((captured as Error).message).toContain("child stdin was not writable");
    expect((captured as Error).message).not.toContain("blindly retry");
    expect(children[0].closed).toBe(true);
    expect(controller.list()).toEqual([]);
    expect(pongs).toEqual([]);
  });

  it("reports timeout after the prompt crossed as acceptance unknown without blind retry", async () => {
    const { controller, children, pongs } = setup({ delayedPrompt: true, handshakeMs: 5 });
    let captured: unknown;

    try {
      await controller.start({
        prompt: "slow",
        cwd: "/repo",
        model: "p/m",
        thinking: "low",
        capabilities: DEFAULT_CAPABILITIES,
      });
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toContain("acceptance is unknown");
    expect((captured as Error).message).toContain("Do not blindly retry");
    expect((captured as Error).message).toContain("/sessions/1.jsonl");
    expect((captured as Error).cause).toBeInstanceOf(Error);
    expect(((captured as Error).cause as Error).message).toContain("timed out after 5ms");
    expect(children[0].closed).toBe(true);
    expect(controller.list()).toMatchObject([{
      id: 1,
      active: false,
      state: "acceptance-unknown",
      sessionRef: "/sessions/1.jsonl",
    }]);
    expect(pongs).toEqual([]);
  });

  it("keeps the complete bounded session reference and a useful cause in unknown feedback", async () => {
    const sessionRef = `/sessions/${"s".repeat(1_900)}.jsonl`;
    const cause = new Error(`transport detail: ${"e".repeat(8_000)}`);
    const promptError = new PromptTransportError(true, cause);
    const { controller } = setup({ promptError, sessionFile: sessionRef });
    let captured: unknown;

    try {
      await controller.start({
        prompt: "possibly sent",
        cwd: "/repo",
        model: "p/m",
        thinking: "low",
        capabilities: DEFAULT_CAPABILITIES,
      });
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toHaveLength(4_000);
    expect((captured as Error).message).toContain(sessionRef);
    expect((captured as Error).message).toContain("Cause: transport detail:");
    expect((captured as Error).message).toContain("characters omitted");
    expect((captured as Error).cause).toBe(promptError);
    expect(((captured as Error).cause as Error).cause).toBe(cause);
  });

  it("definitely rejects a multiline session reference before prompt dispatch", async () => {
    const { controller, children } = setup({ sessionFile: "/sessions/bad\nreference.jsonl" });

    await expect(controller.start({
      prompt: "not sent",
      cwd: "/repo",
      model: "p/m",
      thinking: "low",
      capabilities: DEFAULT_CAPABILITIES,
    })).rejects.toThrow("definitely rejected before the prompt crossed");
    expect(children[0].requests).not.toContainEqual(expect.objectContaining({ type: "prompt" }));
  });

  it("preserves the original capability preflight failure as the dispatch error cause", async () => {
    const { controller } = setup({
      reportedCapabilities: { tools: [], extensionPaths: [] },
    });
    let captured: unknown;

    try {
      await controller.start({
        prompt: "inspect",
        cwd: "/repo",
        model: "p/m",
        thinking: "low",
        capabilities: DEFAULT_CAPABILITIES,
      });
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toContain(
      "definitely rejected before the prompt crossed the child process boundary",
    );
    expect((captured as Error).message).not.toContain("blindly retry");
    expect((captured as Error).cause).toBeInstanceOf(Error);
    expect(((captured as Error).cause as Error).message).toContain(
      "Child capability preflight mismatch",
    );
  });

  it.each(["completed", "interrupted"] as const)("emits exactly one %s pong after process close", async (outcome) => {
    const { controller, children, pongs } = setup();
    await controller.start({ prompt: "work", cwd: "/repo", model: "p/m", thinking: "medium", capabilities: DEFAULT_CAPABILITIES, name: "worker" });
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
    await controller.start({ prompt: "work", cwd: "/repo", model: "p/m", thinking: "medium", capabilities: DEFAULT_CAPABILITIES });
    children[0].crash("boom");
    await vi.waitFor(() => expect(pongs).toHaveLength(1));
    expect(pongs[0]).toMatchObject({ outcome: "failed", error: "boom" });
  });

  it("does not classify a spontaneous aborted assistant message as caller interruption", async () => {
    const { controller, children, pongs } = setup();
    await controller.start({ prompt: "work", cwd: "/repo", model: "p/m", thinking: "medium", capabilities: DEFAULT_CAPABILITIES });
    children[0].emit({
      type: "message_end",
      message: { role: "assistant", stopReason: "aborted", errorMessage: "provider aborted" },
    });
    await settle(children[0]);
    expect(pongs[0]).toMatchObject({
      outcome: "failed",
      sessionRef: "/sessions/1.jsonl",
      error: "provider aborted",
    });
  });

  it("reports a settled assistant error as failed", async () => {
    const { controller, children, pongs } = setup();
    await controller.start({ prompt: "work", cwd: "/repo", model: "p/m", thinking: "medium", capabilities: DEFAULT_CAPABILITIES });
    children[0].emit({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "provider failed" } });
    await settle(children[0]);
    expect(pongs[0]).toMatchObject({ outcome: "failed", error: "provider failed" });
  });

  it("returns a failed pong with the session reference for malformed terminal text metadata", async () => {
    const { controller, children, pongs } = setup();
    await controller.start({
      prompt: "work",
      cwd: "/repo",
      model: "p/m",
      thinking: "medium",
      capabilities: DEFAULT_CAPABILITIES,
    });
    children[0].finalText = {} as unknown as string;

    await settle(children[0]);

    expect(pongs).toMatchObject([{
      outcome: "failed",
      sessionRef: "/sessions/1.jsonl",
      error: "Child returned invalid last assistant text metadata.",
    }]);
  });

  it("returns a direct failed terminal result for malformed terminal text metadata", async () => {
    const { controller, children, pongs } = setup();
    const running = controller.run({
      prompt: "work",
      cwd: "/repo",
      model: "p/m",
      thinking: "medium",
      capabilities: DEFAULT_CAPABILITIES,
    });
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0].finalText = [] as unknown as string;

    await settle(children[0]);

    await expect(running).resolves.toMatchObject({
      outcome: "failed",
      sessionRef: "/sessions/1.jsonl",
      error: "Child returned invalid last assistant text metadata.",
    });
    expect(pongs).toEqual([]);
  });

  it("continues the same session with the routing values supplied for the new turn", async () => {
    const { controller, children } = setup();
    await controller.start({ prompt: "one", cwd: "/repo", model: "p/old", thinking: "low", capabilities: DEFAULT_CAPABILITIES });
    await settle(children[0]);

    await controller.continue({ id: 1, prompt: "two", model: "p/current", thinking: "high", capabilities: DEFAULT_CAPABILITIES });
    expect(children[1].spec).toMatchObject({ session: "/sessions/1.jsonl", cwd: "/repo", model: "p/current", thinking: "high", capabilities: DEFAULT_CAPABILITIES });
    await expect(controller.continue({ id: 1, prompt: "three", model: "p/current", thinking: "high", capabilities: DEFAULT_CAPABILITIES })).rejects.toThrow("active");
  });

  it("waits for a direct continuation without emitting another pong", async () => {
    const { controller, children, pongs } = setup();
    await controller.start({ prompt: "one", cwd: "/repo", model: "p/m", thinking: "low", capabilities: DEFAULT_CAPABILITIES });
    await settle(children[0]);
    expect(pongs).toHaveLength(1);

    const continuing = controller.runContinuation({
      id: 1,
      prompt: "two",
      model: "p/m",
      thinking: "high",
      capabilities: DEFAULT_CAPABILITIES,
    });
    await vi.waitFor(() => expect(children).toHaveLength(2));
    children[1].finalText = "continued";
    await settle(children[1]);

    await expect(continuing).resolves.toMatchObject({
      id: 1,
      outcome: "completed",
      finalText: "continued",
    });
    expect(pongs).toHaveLength(1);
  });

  it("classifies direct continuation cancellation during handshaking as interrupted", async () => {
    const { controller, children, pongs } = setup({ delayedPrompt: true });
    const starting = controller.start({
      prompt: "one",
      cwd: "/repo",
      model: "p/m",
      thinking: "low",
      capabilities: DEFAULT_CAPABILITIES,
    });
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0].acceptPrompt();
    await starting;
    await settle(children[0]);
    expect(pongs).toHaveLength(1);

    const cancellation = new AbortController();
    const continuing = controller.runContinuation({
      id: 1,
      prompt: "two",
      model: "p/m",
      thinking: "high",
      capabilities: DEFAULT_CAPABILITIES,
    }, cancellation.signal);
    await vi.waitFor(() => expect(children).toHaveLength(2));

    cancellation.abort();
    children[1].emit({ type: "agent_settled" });
    children[1].acceptPrompt();

    await expect(continuing).resolves.toMatchObject({
      id: 1,
      outcome: "interrupted",
      sessionRef: "/sessions/1.jsonl",
    });
    expect(pongs).toHaveLength(1);
  });

  it("allows steering only while active", async () => {
    const { controller, children } = setup();
    await controller.start({ prompt: "one", cwd: "/repo", model: "p/m", thinking: "low", capabilities: DEFAULT_CAPABILITIES });
    await controller.steer(1, "change course");
    expect(children[0].requests).toContainEqual({ type: "steer", message: "change course" });
    await settle(children[0]);
    await expect(controller.steer(1, "late")).rejects.toThrow("not active");
  });

  it("tracks tool activity and visible text without thinking", async () => {
    const { controller, children } = setup();
    await controller.start({ prompt: "one", cwd: "/repo", model: "p/m", thinking: "low", capabilities: DEFAULT_CAPABILITIES });
    children[0].emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "secret" } });
    children[0].emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "visible" } });
    children[0].emit({ type: "tool_execution_start", toolName: "read" });
    expect(controller.list()[0]).toMatchObject({ preview: "visible", currentTool: "read" });
  });

  it("ignores malformed tool metadata and bounds valid tool names from untrusted frames", async () => {
    const { controller, children } = setup();
    await controller.start({
      prompt: "one",
      cwd: "/repo",
      model: "p/m",
      thinking: "low",
      capabilities: DEFAULT_CAPABILITIES,
    });

    expect(() => children[0].emit({
      type: "tool_execution_start",
      toolName: {} as unknown as string,
    })).not.toThrow();
    expect(controller.list()[0].currentTool).toBeUndefined();

    children[0].emit({ type: "tool_execution_start", toolName: `tool-${"x".repeat(400)}` });
    expect(controller.list()[0].currentTool).toHaveLength(256);
    expect(controller.list()[0].currentTool).toContain("characters omitted");
  });

  it("reports only the active owned subtree and removes descendants on child settlement", async () => {
    const { controller, children } = setup();
    await controller.start({
      prompt: "coordinate",
      name: "coordinator",
      cwd: "/repo",
      model: "p/coordinator",
      thinking: "low",
      capabilities: DEFAULT_CAPABILITIES,
    });
    children[0].emit({
      type: "subagent_ownership",
      ownership: [{
        path: [4],
        parentPath: [],
        id: 4,
        depth: 3,
        state: "running",
        name: "leaf",
        model: "p/leaf",
        thinking: "medium",
      }],
    } as RpcEvent);

    expect(controller.activeSubtree()).toEqual([
      {
        path: [1],
        parentPath: [],
        id: 1,
        depth: 2,
        state: "running",
        name: "coordinator",
        model: "p/coordinator",
        thinking: "low",
      },
      {
        path: [1, 4],
        parentPath: [1],
        id: 4,
        depth: 3,
        state: "running",
        name: "leaf",
        model: "p/leaf",
        thinking: "medium",
      },
    ]);

    await settle(children[0]);
    expect(controller.activeSubtree()).toEqual([]);
  });

  it("prefixes each propagated subtree with its direct owner and cannot expose siblings", async () => {
    const { controller, children } = setup();
    const input = {
      cwd: "/repo",
      model: "p/owner",
      thinking: "low" as const,
      capabilities: DEFAULT_CAPABILITIES,
    };
    await Promise.all([
      controller.start({ ...input, prompt: "one" }),
      controller.start({ ...input, prompt: "two" }),
    ]);
    children[0].emit({
      type: "subagent_ownership",
      ownership: [{
        path: [2], parentPath: [], id: 2, depth: 3, state: "running",
        model: "p/leaf-one", thinking: "low",
      }],
    });
    children[1].emit({
      type: "subagent_ownership",
      ownership: [{
        path: [2], parentPath: [], id: 2, depth: 3, state: "running",
        model: "p/leaf-two", thinking: "low",
      }],
    });

    expect(controller.activeSubtree().map((runtime) => ({
      path: runtime.path,
      parentPath: runtime.parentPath,
      model: runtime.model,
    }))).toEqual([
      { path: [1], parentPath: [], model: "p/owner" },
      { path: [1, 2], parentPath: [1], model: "p/leaf-one" },
      { path: [2], parentPath: [], model: "p/owner" },
      { path: [2, 2], parentPath: [2], model: "p/leaf-two" },
    ]);
  });

  it("suppresses pongs and clears state on shutdown", async () => {
    const { controller, children, pongs } = setup();
    await Promise.all([
      controller.start({ prompt: "one", cwd: "/repo", model: "p/m", thinking: "low", capabilities: DEFAULT_CAPABILITIES }),
      controller.start({ prompt: "two", cwd: "/repo", model: "p/m", thinking: "low", capabilities: DEFAULT_CAPABILITIES }),
    ]);
    await controller.shutdown();
    expect(children.every((child) => child.closed)).toBe(true);
    expect(children.every((child) => child.requests.some((request) => request.type === "abort"))).toBe(true);
    expect(controller.list()).toEqual([]);
    expect(pongs).toEqual([]);
  });
});
