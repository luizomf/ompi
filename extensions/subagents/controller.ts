import {
  assertCapabilityMatch,
  cloneCapabilities,
  type CapabilitySnapshot,
} from "./capabilities.ts";
import {
  ROOT_LINEAGE,
  createChildLineage,
  tightenLineage,
  type ManagedLineage,
} from "./lineage.ts";
import {
  PARENT_ERROR_LIMIT,
  SESSION_REFERENCE_LIMIT,
  boundText,
  errorText,
} from "./feedback.ts";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type TerminalOutcome = "completed" | "failed" | "interrupted";
export type ActiveSubagentState = "handshaking" | "running" | "steering" | "interrupting" | "finalizing";
export type SubagentState = ActiveSubagentState | TerminalOutcome | "acceptance-unknown";
export type DispatchAcceptance = "rejected" | "unknown";

export interface OwnershipRuntime {
  path: number[];
  parentPath: number[];
  id: number;
  depth: number;
  state: ActiveSubagentState;
  name?: string;
  model: string;
  thinking: ThinkingLevel;
}

export interface LaunchSpec {
  cwd: string;
  model: string;
  thinking: ThinkingLevel;
  capabilities: CapabilitySnapshot;
  lineage: ManagedLineage;
  name?: string;
  session?: string;
}

export interface RpcEvent {
  type: string;
  toolName?: string;
  assistantMessageEvent?: { type?: string; delta?: string };
  message?: { role?: string; stopReason?: string; errorMessage?: string };
  ownership?: OwnershipRuntime[];
}

export interface RpcChild {
  request(command: Record<string, unknown>): Promise<unknown>;
  prompt(message: string): Promise<void>;
  getCapabilities(): Promise<CapabilitySnapshot>;
  onEvent(listener: (event: RpcEvent) => void): () => void;
  onExit(listener: (error?: Error) => void): () => void;
  close(): Promise<void>;
}

export interface StartInput extends Omit<LaunchSpec, "lineage" | "session"> {
  prompt: string;
  maxDepth?: number;
  maxChildren?: number;
}

export interface ContinueInput {
  id: number;
  prompt: string;
  model: string;
  thinking: ThinkingLevel;
  capabilities: CapabilitySnapshot;
  maxDepth?: number;
  maxChildren?: number;
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

export interface TerminalResult {
  id: number;
  name?: string;
  outcome: TerminalOutcome;
  sessionRef: string;
  finalText?: string;
  error?: string;
}

interface RecordState extends SubagentView {
  capabilities: CapabilitySnapshot;
  lineage: ManagedLineage;
  child?: RpcChild;
  accepted: boolean;
  finalizing: boolean;
  delivered: boolean;
  interruptRequested: boolean;
  pendingSettled: boolean;
  pendingExitError?: string;
  terminalError?: string;
  assistantMessageEnded: boolean;
  ownership: OwnershipRuntime[];
  directResolve?: (result: TerminalResult) => void;
}

export interface ControllerOptions {
  createChild(spec: LaunchSpec): Promise<RpcChild>;
  onPong(result: TerminalResult): void;
  onChange?(): void;
  handshakeMs?: number;
  now?: () => number;
  lineage?: ManagedLineage;
}

const DEFAULT_HANDSHAKE_MS = 10_000;

export class PromptTransportError extends Error {
  constructor(readonly mayHaveCrossed: boolean, cause: unknown) {
    super(errorMessage(cause), { cause });
    this.name = "PromptTransportError";
  }
}

export class DispatchError extends Error {
  constructor(
    readonly acceptance: DispatchAcceptance,
    message: string,
    readonly sessionRef: string | undefined,
    cause: unknown,
  ) {
    super(errorText(message), { cause });
    this.name = "DispatchError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unknownAcceptanceMessage(sessionRef: string | undefined, error: unknown): string {
  const warning = "Subagent dispatch acceptance is unknown because the prompt may have crossed the child process boundary. Do not blindly retry; retrying could duplicate effects.";
  const session = sessionRef ? ` Native session: ${sessionRef}.` : "";
  const causePrefix = " Cause: ";
  const causeLimit = Math.max(
    32,
    PARENT_ERROR_LIMIT - warning.length - session.length - causePrefix.length,
  );
  const cause = boundText(errorMessage(error), causeLimit).text;
  return `${warning}${session}${causePrefix}${cause}`;
}

function sessionFile(value: unknown): string {
  const candidate = value && typeof value === "object"
    ? (value as { sessionFile?: unknown }).sessionFile
    : undefined;
  if (
    typeof candidate !== "string"
    || candidate.length === 0
    || candidate.length > SESSION_REFERENCE_LIMIT
    || /[\u0000\r\n]/.test(candidate)
  ) {
    throw new Error(
      `Child did not provide a one-line native session reference of at most ${SESSION_REFERENCE_LIMIT} characters.`,
    );
  }
  return candidate;
}

function textData(value: unknown): { text?: string | null } {
  return value && typeof value === "object" ? (value as { text?: string | null }) : {};
}

export class SubagentController {
  private readonly records = new Map<number, RecordState>();
  private readonly options: Required<Pick<ControllerOptions, "handshakeMs" | "now">> & ControllerOptions;
  private nextId = 1;
  private shuttingDown = false;
  private readonly lineage: ManagedLineage;

  constructor(options: ControllerOptions) {
    this.lineage = options.lineage ?? ROOT_LINEAGE;
    this.options = {
      ...options,
      handshakeMs: options.handshakeMs ?? DEFAULT_HANDSHAKE_MS,
      now: options.now ?? Date.now,
    };
  }

  list(): SubagentView[] {
    return [...this.records.values()].map(({ capabilities, lineage: _lineage, child: _child, accepted: _accepted, finalizing: _finalizing, delivered: _delivered, interruptRequested: _interruptRequested, pendingSettled: _pendingSettled, pendingExitError: _pendingExitError, terminalError: _terminalError, assistantMessageEnded: _assistantMessageEnded, ownership: _ownership, directResolve: _directResolve, ...view }) => ({
      ...view,
      tools: capabilities.tools.map((tool) => tool.name),
    }));
  }

  activeSubtree(): OwnershipRuntime[] {
    return [...this.records.values()].flatMap((record) => {
      if (!record.active) return [];
      const direct: OwnershipRuntime = {
        path: [record.id],
        parentPath: [],
        id: record.id,
        depth: record.lineage.depth,
        state: record.state as ActiveSubagentState,
        name: record.name,
        model: record.model,
        thinking: record.thinking,
      };
      const descendants = record.ownership.map((runtime) => ({
        ...runtime,
        path: [record.id, ...runtime.path],
        parentPath: [record.id, ...runtime.parentPath],
      }));
      return [direct, ...descendants];
    });
  }

  async start(input: StartInput): Promise<SubagentView> {
    const record = this.createStartRecord(input);
    try {
      await this.launch(record, input.prompt);
      return this.view(record);
    } catch (error) {
      if (error instanceof DispatchError && error.acceptance === "unknown") {
        this.markAcceptanceUnknown(record, error);
      } else {
        this.records.delete(record.id);
        this.changed();
      }
      throw error;
    }
  }

  async run(input: StartInput, signal?: AbortSignal): Promise<TerminalResult> {
    if (signal?.aborted) throw new Error("Subagent run was cancelled before launch.");
    let resolveCompletion!: (result: TerminalResult) => void;
    const completion = new Promise<TerminalResult>((resolve) => {
      resolveCompletion = resolve;
    });
    const record = this.createStartRecord(input, resolveCompletion);
    let launched = false;
    const abort = () => {
      record.interruptRequested = true;
      if (launched && record.active) void this.interrupt(record.id).catch(() => undefined);
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await this.launch(record, input.prompt);
      launched = true;
      if (signal?.aborted && record.active) await this.interrupt(record.id);
      return await completion;
    } catch (error) {
      if (error instanceof DispatchError && error.acceptance === "unknown") {
        this.markAcceptanceUnknown(record, error);
      } else {
        this.records.delete(record.id);
        this.changed();
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  async continue(input: ContinueInput): Promise<SubagentView> {
    return this.continueWithDelivery(input);
  }

  async runContinuation(input: ContinueInput, signal?: AbortSignal): Promise<TerminalResult> {
    if (signal?.aborted) throw new Error("Subagent continuation was cancelled before launch.");
    let resolveCompletion!: (result: TerminalResult) => void;
    const completion = new Promise<TerminalResult>((resolve) => {
      resolveCompletion = resolve;
    });
    let cancelled = false;
    const abort = () => {
      cancelled = true;
      const record = this.records.get(input.id);
      if (!record?.active) return;
      record.interruptRequested = true;
      if (record.accepted && !record.finalizing && record.state !== "interrupting") {
        void this.interrupt(input.id).catch(() => undefined);
      }
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await this.continueWithDelivery(input, resolveCompletion, () => cancelled);
      const record = this.records.get(input.id);
      if (
        cancelled
        && record?.active
        && record.accepted
        && !record.finalizing
        && record.state !== "interrupting"
      ) {
        await this.interrupt(input.id);
      }
      return await completion;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  private async continueWithDelivery(
    input: ContinueInput,
    directResolve?: (result: TerminalResult) => void,
    isCancelled?: () => boolean,
  ): Promise<SubagentView> {
    this.assertCanLaunch();
    const record = this.requireRecord(input.id);
    if (record.active) throw new Error(`Subagent ${input.id} is already active; use steer instead.`);
    if (!record.sessionRef) throw new Error(`Subagent ${input.id} has no native session reference.`);

    const lineage = tightenLineage(record.lineage, input);
    const previous = {
      state: record.state,
      error: record.error,
      model: record.model,
      thinking: record.thinking,
      capabilities: cloneCapabilities(record.capabilities),
      lineage: record.lineage,
      directResolve: record.directResolve,
    };
    record.model = input.model;
    record.thinking = input.thinking;
    record.capabilities = cloneCapabilities(input.capabilities);
    record.lineage = lineage;
    record.state = "handshaking";
    record.active = true;
    record.startedAt = this.options.now();
    record.currentTool = undefined;
    record.preview = undefined;
    record.error = undefined;
    record.accepted = false;
    record.finalizing = false;
    record.delivered = false;
    record.interruptRequested = isCancelled?.() ?? false;
    record.pendingSettled = false;
    record.pendingExitError = undefined;
    record.terminalError = undefined;
    record.assistantMessageEnded = false;
    record.ownership = [];
    record.directResolve = directResolve;

    try {
      this.changed();
      await this.launch(record, input.prompt);
      return this.view(record);
    } catch (error) {
      if (error instanceof DispatchError && error.acceptance === "unknown") {
        this.markAcceptanceUnknown(record, error);
      } else {
        record.state = previous.state;
        record.error = previous.error;
        record.model = previous.model;
        record.thinking = previous.thinking;
        record.capabilities = previous.capabilities;
        record.lineage = previous.lineage;
        record.directResolve = previous.directResolve;
        record.active = false;
        record.startedAt = undefined;
        record.child = undefined;
        this.changed();
      }
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
      capabilities: cloneCapabilities(record.capabilities),
      lineage: record.lineage,
      name: record.name,
      session: record.sessionRef,
    };

    let child: RpcChild | undefined;
    let promptAttempted = false;
    try {
      await this.withHandshakeTimeout(async () => {
        child = await this.options.createChild(spec);
        record.child = child;
        child.onEvent((event) => this.handleEvent(record, event));
        child.onExit((error) => this.handleExit(record, error));
        assertCapabilityMatch(spec.capabilities, await child.getCapabilities());
        record.sessionRef = sessionFile(await child.request({ type: "get_state" }));
        promptAttempted = true;
        await child.prompt(prompt);
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
      const promptMayHaveCrossed = promptAttempted
        && (!(error instanceof PromptTransportError) || error.mayHaveCrossed);
      if (promptMayHaveCrossed) {
        throw new DispatchError(
          "unknown",
          unknownAcceptanceMessage(record.sessionRef, error),
          record.sessionRef,
          error,
        );
      }
      throw new DispatchError(
        "rejected",
        `Subagent dispatch was definitely rejected before the prompt crossed the child process boundary: ${errorMessage(error)}`,
        record.sessionRef,
        error,
      );
    }
  }

  private markAcceptanceUnknown(record: RecordState, error: DispatchError): void {
    record.state = "acceptance-unknown";
    record.active = false;
    record.startedAt = undefined;
    record.child = undefined;
    record.currentTool = undefined;
    record.preview = undefined;
    record.error = error.message;
    record.accepted = false;
    record.finalizing = false;
    record.delivered = false;
    record.pendingSettled = false;
    record.pendingExitError = undefined;
    record.terminalError = undefined;
    record.ownership = [];
    record.directResolve = undefined;
    this.changed();
  }

  private handleEvent(record: RecordState, event: RpcEvent): void {
    if (!record.active || record.finalizing) return;
    if (event.type === "subagent_ownership") {
      record.ownership = (event.ownership ?? []).filter((runtime) => (
        runtime.depth === record.lineage.depth + runtime.path.length
        && runtime.depth <= record.lineage.maxDepth
      ));
      this.changed();
      return;
    }
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
      record.assistantMessageEnded = true;
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
    if (record.finalizing || record.delivered || !record.accepted) return;
    record.finalizing = true;
    record.state = "finalizing";
    record.error = error;
    this.changed();

    let finalText: string | undefined;
    if (!alreadyExited && record.child) {
      if (record.assistantMessageEnded) {
        try {
          finalText = textData(await record.child.request({ type: "get_last_assistant_text" })).text ?? undefined;
        } catch (requestError) {
          if (outcome === "completed") {
            outcome = "failed";
            record.error = errorMessage(requestError);
          }
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
    record.ownership = [];
    record.state = outcome;
    record.finalizing = false;
    record.error = record.error || undefined;
    this.changed();

    if (this.shuttingDown || record.delivered || !record.sessionRef) return;
    record.delivered = true;
    const result: TerminalResult = {
      id: record.id,
      name: record.name,
      outcome,
      sessionRef: record.sessionRef,
      finalText,
      error: record.error,
    };
    const directResolve = record.directResolve;
    record.directResolve = undefined;
    if (directResolve) directResolve(result);
    else this.options.onPong(result);
  }

  private createStartRecord(input: StartInput, directResolve?: (result: TerminalResult) => void): RecordState {
    this.assertCanLaunch();
    const lineage = createChildLineage(this.lineage, input);
    const record: RecordState = {
      id: this.nextId++,
      name: input.name,
      state: "handshaking",
      active: true,
      startedAt: this.options.now(),
      cwd: input.cwd,
      model: input.model,
      thinking: input.thinking,
      capabilities: cloneCapabilities(input.capabilities),
      lineage,
      accepted: false,
      finalizing: false,
      delivered: false,
      interruptRequested: false,
      pendingSettled: false,
      assistantMessageEnded: false,
      ownership: [],
      directResolve,
    };
    this.records.set(record.id, record);
    try {
      this.changed();
      return record;
    } catch (error) {
      this.records.delete(record.id);
      throw error;
    }
  }

  private assertCanLaunch(): void {
    if (this.shuttingDown) throw new Error("The orchestrator session is shutting down.");
    if ([...this.records.values()].filter((record) => record.active).length >= this.lineage.maxChildren) {
      throw new Error(
        `At most ${this.lineage.maxChildren} direct subagents may be active; no child process was launched.`,
      );
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
