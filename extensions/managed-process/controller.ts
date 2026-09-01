import {
  spawn,
  type ChildProcessByStdio,
} from "node:child_process";
import type { Readable } from "node:stream";

const DEFAULT_MAX_ACTIVE = 8;
const DEFAULT_STREAM_BYTES = 64 * 1024;
const DEFAULT_OUTPUT_BYTES = 20 * 1024;
const DEFAULT_MAX_RECORDS = 64;
const DEFAULT_STOP_GRACE_MS = 750;
const MAX_ARGUMENTS = 128;
const MAX_ARGUMENT_BYTES = 8_000;
const MAX_ARGUMENT_VECTOR_BYTES = 64 * 1024;
const MAX_PATH_BYTES = 8_000;
const MAX_CLEANUP_ERRORS = 4;
const MAX_CLEANUP_ERROR_CHARACTERS = 256;

type ManagedChild = ChildProcessByStdio<null, Readable, Readable>;

export type ManagedProcessState =
  | "starting"
  | "running"
  | "stopping"
  | "exited"
  | "signaled"
  | "start_failed"
  | "cleanup_failed";

export type ManagedProcessStopReason =
  | "explicit"
  | "session_shutdown"
  | "leader_exit_cleanup"
  | "startup_cancelled"
  | "process_error";

export interface StartProcessInput {
  executable: string;
  args?: string[];
  cwd: string;
  signal?: AbortSignal;
}

export type ManagedProcessCleanupStatus = "not_attempted" | "pending" | "completed" | "failed";
export type ManagedProcessSignalOutcome = "not_attempted" | "sent" | "group_gone" | "failed";
export type ManagedProcessGroupOutcome = "not_checked" | "present" | "gone" | "survived" | "unknown";
export type ManagedProcessLeaderOutcome = "pending" | "exited" | "signaled" | "missing";

export interface ManagedProcessCleanup {
  status: ManagedProcessCleanupStatus;
  reason?: ManagedProcessStopReason;
  sigterm: ManagedProcessSignalOutcome;
  sigkill: ManagedProcessSignalOutcome;
  group: ManagedProcessGroupOutcome;
  leader: ManagedProcessLeaderOutcome;
  errors: string[];
  errorsOmitted: number;
  possibleEscapedDescendants: boolean;
}

export interface ManagedProcessView {
  id: number;
  executable: string;
  args: string[];
  cwd: string;
  pid?: number;
  pgid?: number;
  state: ManagedProcessState;
  active: boolean;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  exitSignal?: NodeJS.Signals;
  stopReason?: ManagedProcessStopReason;
  error?: string;
  cleanup: ManagedProcessCleanup;
}

export interface StreamOutput {
  text: string;
  retainedBytes: number;
  observedBytes: number;
  truncated: boolean;
}

export interface ManagedProcessOutput {
  id: number;
  state: ManagedProcessState;
  stdout: StreamOutput;
  stderr: StreamOutput;
}

export interface ManagedProcessShutdownReport {
  processes: Array<Pick<ManagedProcessView,
    "id" | "state" | "active" | "exitCode" | "exitSignal" | "stopReason" | "error" | "cleanup"
  >>;
}

export interface ManagedProcessControllerOptions {
  maxActive?: number;
  maxStreamBytes?: number;
  maxOutputBytes?: number;
  maxRecords?: number;
  stopGraceMs?: number;
  now?: () => number;
  onChange?: () => void;
}

function decodeTailWithin(buffer: Buffer, maximumBytes: number): string {
  const decoded = buffer.toString("utf8");
  let start = decoded.length;
  let bytes = 0;
  while (start > 0) {
    let next = start - 1;
    const code = decoded.charCodeAt(next);
    if (code >= 0xdc00 && code <= 0xdfff && next > 0) next -= 1;
    const characterBytes = Buffer.byteLength(decoded.slice(next, start), "utf8");
    if (bytes + characterBytes > maximumBytes) break;
    bytes += characterBytes;
    start = next;
  }
  return decoded.slice(start);
}

class TailBuffer {
  private value = Buffer.alloc(0);
  private observed = 0;

  constructor(private readonly limit: number) {}

  append(chunk: Buffer): void {
    this.observed += chunk.length;
    if (chunk.length >= this.limit) {
      this.value = Buffer.from(chunk.subarray(chunk.length - this.limit));
      return;
    }
    const keepFromCurrent = Math.max(0, this.value.length + chunk.length - this.limit);
    this.value = Buffer.concat([this.value.subarray(keepFromCurrent), chunk]);
  }

  snapshot(maxBytes = this.limit): StreamOutput {
    const retained = this.value.subarray(Math.max(0, this.value.length - maxBytes));
    const text = decodeTailWithin(retained, maxBytes);
    const returnedBytes = Buffer.byteLength(text, "utf8");
    return {
      text,
      retainedBytes: returnedBytes,
      observedBytes: this.observed,
      truncated: this.observed > returnedBytes,
    };
  }
}

interface ProcessRecord extends ManagedProcessView {
  child: ManagedChild;
  stdoutBuffer: TailBuffer;
  stderrBuffer: TailBuffer;
  startFailed: boolean;
  cleanupErrors: string[];
  cleanupErrorsOmitted: number;
  forceKill?: NodeJS.Timeout;
  forceClose?: NodeJS.Timeout;
  pendingExitCode?: number | null;
  pendingExitSignal?: NodeJS.Signals | null;
  closed: Promise<void>;
  resolveClosed: () => void;
}

type GroupProbe =
  | { kind: "present" }
  | { kind: "gone" }
  | { kind: "failed"; error: string };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compactError(error: string): string {
  if (error.length <= MAX_CLEANUP_ERROR_CHARACTERS) return error;
  const suffix = `…[truncated from ${error.length} characters]`;
  return `${error.slice(0, Math.max(0, MAX_CLEANUP_ERROR_CHARACTERS - suffix.length))}${suffix}`;
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "unknown")
    : "unknown";
}

function requirePositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Managed process ${name} must be a positive integer.`);
  }
}

function requireAtMost(name: string, value: number, maximum: number): void {
  if (value > maximum) {
    throw new Error(`Managed process ${name} must not exceed ${maximum}.`);
  }
}

function validateStart(input: StartProcessInput): void {
  if (!input.executable.trim()) throw new Error("Executable must be a non-empty string.");
  if (Buffer.byteLength(input.executable, "utf8") > MAX_PATH_BYTES) {
    throw new Error(`Executable must not exceed ${MAX_PATH_BYTES} UTF-8 bytes.`);
  }
  if (Buffer.byteLength(input.cwd, "utf8") > MAX_PATH_BYTES) {
    throw new Error(`Working directory must not exceed ${MAX_PATH_BYTES} UTF-8 bytes.`);
  }
  const args = input.args ?? [];
  if (args.length > MAX_ARGUMENTS) {
    throw new Error(`Managed process argument vector must contain at most ${MAX_ARGUMENTS} items.`);
  }
  let total = 0;
  for (const arg of args) {
    const bytes = Buffer.byteLength(arg, "utf8");
    if (bytes > MAX_ARGUMENT_BYTES) {
      throw new Error(`Managed process argument vector items must not exceed ${MAX_ARGUMENT_BYTES} UTF-8 bytes.`);
    }
    total += bytes;
  }
  if (total > MAX_ARGUMENT_VECTOR_BYTES) {
    throw new Error(`Managed process argument vector must not exceed ${MAX_ARGUMENT_VECTOR_BYTES} UTF-8 bytes in total.`);
  }
}

function probeGroup(pgid: number | undefined): GroupProbe {
  if (!pgid) return { kind: "gone" };
  try {
    process.kill(-pgid, 0);
    return { kind: "present" };
  } catch (error) {
    if (errorCode(error) === "ESRCH") return { kind: "gone" };
    return {
      kind: "failed",
      error: `Process-group probe failed (${errorCode(error)}): ${message(error)}`,
    };
  }
}

function signalGroup(pgid: number | undefined, signal: NodeJS.Signals): GroupProbe {
  if (!pgid) return { kind: "gone" };
  try {
    process.kill(-pgid, signal);
    return { kind: "present" };
  } catch (error) {
    if (errorCode(error) === "ESRCH") return { kind: "gone" };
    return {
      kind: "failed",
      error: `Process-group ${signal} failed (${errorCode(error)}): ${message(error)}`,
    };
  }
}

export class ManagedProcessController {
  private readonly records = new Map<number, ProcessRecord>();
  private readonly maxActive: number;
  private readonly maxStreamBytes: number;
  private readonly maxOutputBytes: number;
  private readonly maxRecords: number;
  private readonly stopGraceMs: number;
  private readonly now: () => number;
  private readonly onChange?: () => void;
  private nextId = 1;
  private shuttingDown = false;
  private shutdownPromise?: Promise<ManagedProcessShutdownReport>;

  constructor(options: ManagedProcessControllerOptions = {}) {
    this.maxActive = options.maxActive ?? DEFAULT_MAX_ACTIVE;
    this.maxStreamBytes = options.maxStreamBytes ?? DEFAULT_STREAM_BYTES;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES;
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    this.stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
    requirePositiveInteger("maxActive", this.maxActive);
    requirePositiveInteger("maxStreamBytes", this.maxStreamBytes);
    requirePositiveInteger("maxOutputBytes", this.maxOutputBytes);
    requirePositiveInteger("maxRecords", this.maxRecords);
    requirePositiveInteger("stopGraceMs", this.stopGraceMs);
    requireAtMost("maxActive", this.maxActive, DEFAULT_MAX_ACTIVE);
    requireAtMost("maxStreamBytes", this.maxStreamBytes, DEFAULT_STREAM_BYTES);
    requireAtMost("maxOutputBytes", this.maxOutputBytes, DEFAULT_OUTPUT_BYTES);
    requireAtMost("maxRecords", this.maxRecords, DEFAULT_MAX_RECORDS);
    if (this.maxOutputBytes > this.maxStreamBytes) {
      throw new Error("Managed process maxOutputBytes must not exceed maxStreamBytes.");
    }
    this.now = options.now ?? Date.now;
    this.onChange = options.onChange;
  }

  list(): ManagedProcessView[] {
    return [...this.records.values()].map((record) => this.view(record));
  }

  output(id: number, maxBytes = this.maxOutputBytes): ManagedProcessOutput {
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > this.maxOutputBytes) {
      throw new Error(`Managed process output maxBytes must be an integer from 1 through ${this.maxOutputBytes}.`);
    }
    const record = this.require(id);
    return {
      id,
      state: record.state,
      stdout: record.stdoutBuffer.snapshot(maxBytes),
      stderr: record.stderrBuffer.snapshot(maxBytes),
    };
  }

  async start(input: StartProcessInput): Promise<ManagedProcessView> {
    if (this.shuttingDown) throw new Error("The managed-process session is shutting down.");
    if (process.platform === "win32") {
      throw new Error("Managed processes require Unix process-group signaling and are not supported on Windows.");
    }
    validateStart(input);
    if (input.signal?.aborted) throw new Error("Managed process start was cancelled before spawn acceptance.");
    if ([...this.records.values()].filter((record) => record.active).length >= this.maxActive) {
      throw new Error(`At most ${this.maxActive} managed processes may be active; no process was started.`);
    }

    const child = spawn(input.executable, input.args ?? [], {
      cwd: input.cwd,
      env: process.env,
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const id = this.nextId++;
    let resolveClosed = () => {};
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const record: ProcessRecord = {
      id,
      executable: input.executable,
      args: [...(input.args ?? [])],
      cwd: input.cwd,
      pid: child.pid,
      pgid: child.pid,
      state: "starting",
      active: true,
      startedAt: this.now(),
      child,
      stdoutBuffer: new TailBuffer(this.maxStreamBytes),
      stderrBuffer: new TailBuffer(this.maxStreamBytes),
      startFailed: false,
      cleanupErrors: [],
      cleanupErrorsOmitted: 0,
      cleanup: {
        status: "not_attempted",
        sigterm: "not_attempted",
        sigkill: "not_attempted",
        group: "not_checked",
        leader: "pending",
        errors: [],
        errorsOmitted: 0,
        possibleEscapedDescendants: false,
      },
      closed,
      resolveClosed,
    };
    this.records.set(id, record);
    this.trimHistory();
    this.changed();

    child.stdout.on("data", (chunk: Buffer) => record.stdoutBuffer.append(chunk));
    child.stderr.on("data", (chunk: Buffer) => record.stderrBuffer.append(chunk));
    child.once("exit", (code, signal) => {
      record.pendingExitCode = code;
      record.pendingExitSignal = signal;
      if (!record.stopReason) this.beginTermination(record, "leader_exit_cleanup");
    });
    child.once("close", (code, signal) => {
      record.pendingExitCode = code ?? record.pendingExitCode ?? null;
      record.pendingExitSignal = signal ?? record.pendingExitSignal ?? null;
      this.finishIfGroupGone(record);
    });

    return new Promise<ManagedProcessView>((resolve, reject) => {
      let settledStart = false;
      const cleanup = () => input.signal?.removeEventListener("abort", abort);
      const abort = () => {
        if (settledStart || !record.active) return;
        settledStart = true;
        record.startFailed = true;
        record.error = "Managed process start was cancelled before spawn acceptance.";
        cleanup();
        this.beginTermination(record, "startup_cancelled");
        reject(new Error(record.error));
      };

      input.signal?.addEventListener("abort", abort, { once: true });
      child.once("spawn", () => {
        if (settledStart) return;
        settledStart = true;
        cleanup();
        if (this.shuttingDown || record.stopReason === "session_shutdown") {
          record.startFailed = true;
          record.error = "Managed process start was cancelled because session shutdown began before spawn acceptance.";
          reject(new Error(record.error));
          return;
        }
        record.state = "running";
        this.changed();
        resolve(this.view(record));
      });
      child.once("error", (error) => {
        const text = `Failed to start ${input.executable}: ${message(error)}`;
        if (!settledStart) {
          settledStart = true;
          record.startFailed = true;
          record.error = text;
          cleanup();
          reject(new Error(text));
          return;
        }
        this.addCleanupError(record, `Managed child process error: ${message(error)}`);
        this.beginTermination(record, "process_error");
      });
      if (input.signal?.aborted) abort();
    });
  }

  async stop(id: number): Promise<ManagedProcessView> {
    const record = this.require(id);
    if (!record.active) return this.view(record);
    this.beginTermination(record, "explicit");
    await record.closed;
    return this.view(record);
  }

  shutdown(): Promise<ManagedProcessShutdownReport> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.shutdownPromise = (async () => {
      const active = [...this.records.values()].filter((record) => record.active);
      for (const record of active) this.beginTermination(record, "session_shutdown");
      await Promise.allSettled(active.map((record) => record.closed));
      const report: ManagedProcessShutdownReport = {
        processes: active.map((record) => {
          const view = this.view(record);
          return {
            id: view.id,
            state: view.state,
            active: view.active,
            exitCode: view.exitCode,
            exitSignal: view.exitSignal,
            stopReason: view.stopReason,
            error: view.error,
            cleanup: view.cleanup,
          };
        }),
      };
      this.records.clear();
      this.changed();
      return report;
    })();
    return this.shutdownPromise;
  }

  private beginTermination(record: ProcessRecord, reason: ManagedProcessStopReason): void {
    if (!record.active) return;
    record.stopReason ??= reason;
    record.cleanup.status = "pending";
    record.cleanup.reason = record.stopReason;
    record.cleanup.possibleEscapedDescendants = true;
    if (record.state !== "starting") record.state = "stopping";
    this.captureSignalOutcome(record, "sigterm", signalGroup(record.pgid, "SIGTERM"));
    record.forceKill ??= setTimeout(() => {
      this.captureSignalOutcome(record, "sigkill", signalGroup(record.pgid, "SIGKILL"));
      record.child.stdout.destroy();
      record.child.stderr.destroy();
      this.awaitGroupCleanup(record, Date.now() + Math.max(500, this.stopGraceMs));
    }, this.stopGraceMs);
    this.changed();
  }

  private awaitGroupCleanup(record: ProcessRecord, deadline: number): void {
    if (!record.active) return;
    const probe = probeGroup(record.pgid);
    const hasOutcome = record.pendingExitCode !== undefined || record.pendingExitSignal !== undefined;
    if (probe.kind === "gone" && hasOutcome) {
      this.captureGroupOutcome(record, probe, false);
      this.finish(record);
      return;
    }
    if (Date.now() >= deadline) {
      this.captureGroupOutcome(record, probe, true);
      if (probe.kind === "present") {
        this.addCleanupError(record, "Managed process group remained alive after SIGKILL escalation.");
      }
      if (!hasOutcome) {
        this.addCleanupError(record, "Managed process leader did not report a terminal outcome before the cleanup deadline.");
      }
      this.finish(record);
      return;
    }
    this.captureGroupOutcome(record, probe, false);
    record.forceClose = setTimeout(() => this.awaitGroupCleanup(record, deadline), 25);
  }

  private finishIfGroupGone(record: ProcessRecord): void {
    if (!record.active) return;
    const probe = probeGroup(record.pgid);
    this.captureGroupOutcome(record, probe, false);
    if (probe.kind === "gone") {
      this.finish(record);
    }
  }

  private captureSignalOutcome(
    record: ProcessRecord,
    signal: "sigterm" | "sigkill",
    probe: GroupProbe,
  ): void {
    if (probe.kind === "present") {
      record.cleanup[signal] = "sent";
      return;
    }
    if (probe.kind === "gone") {
      record.cleanup[signal] = "group_gone";
      record.cleanup.group = "gone";
      return;
    }
    record.cleanup[signal] = "failed";
    record.cleanup.group = "unknown";
    this.addCleanupError(record, probe.error);
  }

  private captureGroupOutcome(record: ProcessRecord, probe: GroupProbe, final: boolean): void {
    if (probe.kind === "gone") {
      record.cleanup.group = "gone";
      return;
    }
    if (probe.kind === "present") {
      record.cleanup.group = final ? "survived" : "present";
      return;
    }
    record.cleanup.group = "unknown";
    if (final) this.addCleanupError(record, probe.error);
  }

  private addCleanupError(record: ProcessRecord, error: string): void {
    const bounded = compactError(error);
    if (record.cleanupErrors.includes(bounded)) return;
    if (record.cleanupErrors.length < MAX_CLEANUP_ERRORS) {
      record.cleanupErrors.push(bounded);
    } else {
      record.cleanupErrorsOmitted += 1;
    }
    record.cleanup.errors = [...record.cleanupErrors];
    record.cleanup.errorsOmitted = record.cleanupErrorsOmitted;
  }

  private finish(record: ProcessRecord): void {
    if (!record.active) return;
    if (record.forceKill) clearTimeout(record.forceKill);
    if (record.forceClose) clearTimeout(record.forceClose);
    record.active = false;
    record.endedAt = this.now();
    if (record.cleanup.status !== "not_attempted") {
      if (record.pendingExitSignal) {
        record.cleanup.leader = "signaled";
      } else if (record.pendingExitCode !== undefined && record.pendingExitCode !== null) {
        record.cleanup.leader = "exited";
      } else {
        record.cleanup.leader = "missing";
        this.addCleanupError(record, "Managed process leader has no reported exit code or signal.");
      }
      record.cleanup.status = record.cleanupErrors.length > 0 || record.cleanupErrorsOmitted > 0
        ? "failed"
        : "completed";
      record.cleanup.errors = [...record.cleanupErrors];
      record.cleanup.errorsOmitted = record.cleanupErrorsOmitted;
    }
    if (record.cleanupErrors.length > 0) {
      record.state = "cleanup_failed";
      const omitted = record.cleanupErrorsOmitted > 0
        ? ` [${record.cleanupErrorsOmitted} additional cleanup errors omitted.]`
        : "";
      record.error = `${record.cleanupErrors.join(" ")}${omitted}`;
    } else if (record.startFailed) {
      record.state = "start_failed";
    } else if (record.pendingExitSignal) {
      record.state = "signaled";
      record.exitSignal = record.pendingExitSignal;
    } else {
      record.state = "exited";
      record.exitCode = record.pendingExitCode ?? undefined;
    }
    record.resolveClosed();
    this.trimHistory();
    this.changed();
  }

  private trimHistory(): void {
    while (this.records.size > this.maxRecords) {
      const oldestTerminal = [...this.records.values()].find((record) => !record.active);
      if (!oldestTerminal) return;
      this.records.delete(oldestTerminal.id);
    }
  }

  private require(id: number): ProcessRecord {
    const record = this.records.get(id);
    if (!record) throw new Error(`Unknown managed process ID: ${id}.`);
    return record;
  }

  private view(record: ProcessRecord): ManagedProcessView {
    return {
      id: record.id,
      executable: record.executable,
      args: [...record.args],
      cwd: record.cwd,
      pid: record.pid,
      pgid: record.pgid,
      state: record.state,
      active: record.active,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      exitCode: record.exitCode,
      exitSignal: record.exitSignal,
      stopReason: record.stopReason,
      error: record.error,
      cleanup: {
        ...record.cleanup,
        errors: [...record.cleanup.errors],
      },
    };
  }

  private changed(): void {
    this.onChange?.();
  }
}
