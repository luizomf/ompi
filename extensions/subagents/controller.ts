export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type TerminalOutcome = "completed" | "failed" | "interrupted";
export type SubagentState = "handshaking" | "running" | "steering" | "interrupting" | "finalizing" | TerminalOutcome;

export interface LaunchSpec {
  cwd: string;
  model: string;
  thinking: ThinkingLevel;
  tools?: string[];
  name?: string;
  session?: string;
}

export interface RpcEvent {
  type: string;
  toolName?: string;
  assistantMessageEvent?: { type?: string; delta?: string };
  message?: { role?: string; stopReason?: string; errorMessage?: string };
}

export interface RpcChild {
  request(command: Record<string, unknown>): Promise<unknown>;
  onEvent(listener: (event: RpcEvent) => void): () => void;
  onExit(listener: (error?: Error) => void): () => void;
  close(): Promise<void>;
}

export interface StartInput extends LaunchSpec {
  prompt: string;
}

export interface ContinueInput {
  id: number;
  prompt: string;
  model?: string;
  thinking?: ThinkingLevel;
  tools?: string[];
}

export interface SubagentView {
  id: number;
  name?: string;
  state: SubagentState;
  active: boolean;
  startedAt?: number;
  sessionRef?: string;
  cwd: string;
  model: string;
  thinking: ThinkingLevel;
  tools?: string[];
  currentTool?: string;
  preview?: string;
  error?: string;
}

export interface Pong {
  id: number;
  name?: string;
  outcome: TerminalOutcome;
  sessionRef: string;
  finalText?: string;
  error?: string;
}

interface RecordState extends SubagentView {
  child?: RpcChild;
  accepted: boolean;
  finalizing: boolean;
  ponged: boolean;
  interruptRequested: boolean;
  pendingSettled: boolean;
  pendingExitError?: string;
  terminalError?: string;
}

export interface ControllerOptions {
  createChild(spec: LaunchSpec): Promise<RpcChild>;
  onPong(pong: Pong): void;
  onChange?(): void;
  handshakeMs?: number;
  now?: () => number;
}

const MAX_ACTIVE = 4;
const DEFAULT_HANDSHAKE_MS = 10_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stateData(value: unknown): { sessionFile?: string } {
  return value && typeof value === "object" ? (value as { sessionFile?: string }) : {};
}

function textData(value: unknown): { text?: string | null } {
  return value && typeof value === "object" ? (value as { text?: string | null }) : {};
}

export class SubagentController {
  private readonly records = new Map<number, RecordState>();
  private readonly options: Required<Pick<ControllerOptions, "handshakeMs" | "now">> & ControllerOptions;
  private nextId = 1;
  private shuttingDown = false;

  constructor(options: ControllerOptions) {
    this.options = {
      ...options,
      handshakeMs: options.handshakeMs ?? DEFAULT_HANDSHAKE_MS,
      now: options.now ?? Date.now,
    };
  }

  list(): SubagentView[] {
    return [...this.records.values()].map(({ child: _child, accepted: _accepted, finalizing: _finalizing, ponged: _ponged, interruptRequested: _interruptRequested, pendingSettled: _pendingSettled, pendingExitError: _pendingExitError, terminalError: _terminalError, ...view }) => ({
      ...view,
      tools: view.tools ? [...view.tools] : undefined,
    }));
  }

  async start(input: StartInput): Promise<SubagentView> {
    this.assertCanLaunch();
    const id = this.nextId++;
    const record: RecordState = {
      id,
      name: input.name,
      state: "handshaking",
      active: true,
      startedAt: this.options.now(),
      cwd: input.cwd,
      model: input.model,
      thinking: input.thinking,
      tools: input.tools ? [...input.tools] : undefined,
      accepted: false,
      finalizing: false,
      ponged: false,
      interruptRequested: false,
      pendingSettled: false,
    };
    this.records.set(id, record);
    this.changed();

    try {
      await this.launch(record, input.prompt);
      return this.view(record);
    } catch (error) {
      this.records.delete(id);
      this.changed();
      throw error;
    }
  }

  async continue(input: ContinueInput): Promise<SubagentView> {
    this.assertCanLaunch();
    const record = this.requireRecord(input.id);
    if (record.active) throw new Error(`Subagent ${input.id} is already active; use steer instead.`);
    if (!record.sessionRef) throw new Error(`Subagent ${input.id} has no native session reference.`);

    const previous = {
      state: record.state,
      error: record.error,
      model: record.model,
      thinking: record.thinking,
      tools: record.tools ? [...record.tools] : undefined,
    };
    record.model = input.model ?? record.model;
    record.thinking = input.thinking ?? record.thinking;
    if (input.tools !== undefined) record.tools = [...input.tools];
    record.state = "handshaking";
    record.active = true;
    record.startedAt = this.options.now();
    record.currentTool = undefined;
    record.preview = undefined;
    record.error = undefined;
    record.accepted = false;
    record.finalizing = false;
    record.ponged = false;
    record.interruptRequested = false;
    record.pendingSettled = false;
    record.pendingExitError = undefined;
    record.terminalError = undefined;
    this.changed();

    try {
      await this.launch(record, input.prompt);
      return this.view(record);
    } catch (error) {
      record.state = previous.state;
      record.error = previous.error;
      record.model = previous.model;
      record.thinking = previous.thinking;
      record.tools = previous.tools;
      record.active = false;
      record.startedAt = undefined;
      record.child = undefined;
      this.changed();
      throw error;
    }
  }

  async steer(id: number, message: string): Promise<SubagentView> {
    const record = this.requireActive(id);
    if (!record.accepted || !record.child) throw new Error(`Subagent ${id} has not accepted its prompt yet.`);
    record.state = "steering";
    this.changed();
    try {
      await record.child.request({ type: "steer", message });
      if (!record.finalizing && record.active) record.state = "running";
      this.changed();
      return this.view(record);
    } catch (error) {
      void this.finalize(record, "failed", errorMessage(error));
      throw error;
    }
  }

  async interrupt(id: number): Promise<SubagentView> {
    const record = this.requireActive(id);
    if (!record.accepted || !record.child) throw new Error(`Subagent ${id} has not accepted its prompt yet.`);
    record.interruptRequested = true;
    record.state = "interrupting";
    this.changed();
    try {
      await record.child.request({ type: "abort" });
      return this.view(record);
    } catch (error) {
      void this.finalize(record, "interrupted", errorMessage(error));
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const active = [...this.records.values()].filter((record) => record.active && record.child);
    await Promise.allSettled(active.map(async (record) => {
      record.interruptRequested = true;
      const child = record.child;
      if (!child) return;
      const abort = record.accepted ? child.request({ type: "abort" }) : Promise.resolve();
      await Promise.allSettled([abort, child.close()]);
    }));
    this.records.clear();
    this.changed();
  }

  private async launch(record: RecordState, prompt: string): Promise<void> {
    const spec: LaunchSpec = {
      cwd: record.cwd,
      model: record.model,
      thinking: record.thinking,
      tools: record.tools ? [...record.tools] : undefined,
      name: record.name,
      session: record.sessionRef,
    };

    let child: RpcChild | undefined;
    try {
      await this.withHandshakeTimeout(async () => {
        child = await this.options.createChild(spec);
        record.child = child;
        child.onEvent((event) => this.handleEvent(record, event));
        child.onExit((error) => this.handleExit(record, error));
        const state = stateData(await child.request({ type: "get_state" }));
        if (!state.sessionFile) throw new Error("Child did not provide a native session reference.");
        record.sessionRef = state.sessionFile;
        await child.request({ type: "prompt", message: prompt });
      });
      record.accepted = true;
      record.state = "running";
      this.changed();
      if (record.pendingExitError) {
        void this.finalize(record, record.interruptRequested ? "interrupted" : "failed", record.pendingExitError, true);
      } else if (record.pendingSettled) {
        const outcome = record.interruptRequested ? "interrupted" : record.terminalError ? "failed" : "completed";
        void this.finalize(record, outcome, record.terminalError);
      }
    } catch (error) {
      try {
        await child?.close();
      } catch {
        // Preserve the original handshake error.
      }
      throw new Error(`Subagent prompt was not accepted: ${errorMessage(error)}`);
    }
  }

  private handleEvent(record: RecordState, event: RpcEvent): void {
    if (!record.active || record.finalizing) return;
    if (event.type === "agent_settled") {
      if (!record.accepted) {
        record.pendingSettled = true;
        return;
      }
      const outcome = record.interruptRequested ? "interrupted" : record.terminalError ? "failed" : "completed";
      void this.finalize(record, outcome, record.terminalError);
      return;
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      record.terminalError = event.message.stopReason === "error" || event.message.stopReason === "aborted"
        ? event.message.errorMessage ?? `Assistant turn ended with ${event.message.stopReason}.`
        : undefined;
    }
    if (event.type === "tool_execution_start") record.currentTool = event.toolName;
    if (event.type === "tool_execution_end" && record.currentTool === event.toolName) record.currentTool = undefined;
    const delta = event.assistantMessageEvent;
    if (event.type === "message_update" && delta?.type === "text_delta" && delta.delta) {
      record.preview = `${record.preview ?? ""}${delta.delta}`.slice(-240);
    }
    this.changed();
  }

  private handleExit(record: RecordState, error?: Error): void {
    if (!record.active || record.finalizing) return;
    const message = error?.message ?? "Child process exited before settlement.";
    if (!record.accepted) {
      record.pendingExitError = message;
      return;
    }
    void this.finalize(record, record.interruptRequested ? "interrupted" : "failed", message, true);
  }

  private async finalize(record: RecordState, outcome: TerminalOutcome, error?: string, alreadyExited = false): Promise<void> {
    if (record.finalizing || record.ponged || !record.accepted) return;
    record.finalizing = true;
    record.state = "finalizing";
    record.error = error;
    this.changed();

    let finalText: string | undefined;
    if (!alreadyExited && record.child) {
      try {
        finalText = textData(await record.child.request({ type: "get_last_assistant_text" })).text ?? undefined;
      } catch (requestError) {
        if (outcome === "completed") {
          outcome = "failed";
          record.error = errorMessage(requestError);
        }
      }
      try {
        await record.child.close();
      } catch (closeError) {
        if (outcome === "completed") {
          outcome = "failed";
          record.error = errorMessage(closeError);
        }
      }
    }

    record.child = undefined;
    record.active = false;
    record.startedAt = undefined;
    record.currentTool = undefined;
    record.state = outcome;
    record.finalizing = false;
    record.error = record.error || undefined;
    this.changed();

    if (this.shuttingDown || record.ponged || !record.sessionRef) return;
    record.ponged = true;
    this.options.onPong({
      id: record.id,
      name: record.name,
      outcome,
      sessionRef: record.sessionRef,
      finalText,
      error: record.error,
    });
  }

  private assertCanLaunch(): void {
    if (this.shuttingDown) throw new Error("The orchestrator session is shutting down.");
    if ([...this.records.values()].filter((record) => record.active).length >= MAX_ACTIVE) {
      throw new Error("At most four subagents may be active; no work was queued.");
    }
  }

  private requireRecord(id: number): RecordState {
    const record = this.records.get(id);
    if (!record) throw new Error(`Unknown subagent ID: ${id}.`);
    return record;
  }

  private requireActive(id: number): RecordState {
    const record = this.requireRecord(id);
    if (!record.active) throw new Error(`Subagent ${id} is not active.`);
    return record;
  }

  private view(record: RecordState): SubagentView {
    const [view] = this.list().filter((item) => item.id === record.id);
    return view;
  }

  private changed(): void {
    this.options.onChange?.();
  }

  private async withHandshakeTimeout<T>(operation: () => Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out after ${this.options.handshakeMs}ms`)), this.options.handshakeMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
