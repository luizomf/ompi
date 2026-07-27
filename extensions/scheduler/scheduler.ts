import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdtemp, rmdir, stat, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runBqProcess } from "./process.ts";

const CALLBACK_RUNNER = fileURLToPath(new URL("./callback-runner.mjs", import.meta.url));
const CALLBACK_PROTOCOL_VERSION = 1;
const MAX_CALLBACK_FRAME_BYTES = 128_000;
const MAX_REENTRY_PROMPT_BYTES = 8_000;
const MAX_PREVIEW_BYTES = 4_000;
const MAX_START_ERROR_BYTES = 2_000;
const MAX_PAYLOAD_ARGUMENTS = 128;
const MAX_ARGUMENT_BYTES = 8_000;
const MAX_TOTAL_ARGUMENT_BYTES = 64_000;
const MAX_TIMING_VALUE_BYTES = 1_024;
const SOCKET_READ_TIMEOUT_MS = 2_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BQ_ENVIRONMENT_KEYS = [
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TMPDIR",
  "TZ",
  "USER",
  "BQ_OMQUEUE",
] as const;

export interface SchedulerTiming {
  in?: string;
  at?: string;
  cron?: string;
  tz?: string;
  every?: string;
  count?: number;
}

export interface SchedulerPayload {
  executable: string;
  args?: string[];
  cwd?: string;
}

export interface SchedulerSubmitInput {
  reentryPrompt: string;
  timing?: SchedulerTiming;
  payload?: SchedulerPayload;
}

export interface BqInvocation {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface BqProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  cancelled: boolean;
}

export interface SchedulerSubmissionResult {
  acceptance: "confirmed" | "unknown";
  submissionId: string;
  bq: BqProcessResult;
}

export interface SchedulerStreamPreview {
  preview: string;
  truncated: boolean;
}

export type SchedulerPayloadOutcome =
  | { kind: "heartbeat" }
  | { kind: "exit"; code: number }
  | { kind: "signal"; signal: string }
  | { kind: "start_error"; message: string };

export interface SchedulerWake {
  submissionId: string;
  wakeId: string;
  reentryPrompt: string;
  outcome: SchedulerPayloadOutcome;
  stdout: SchedulerStreamPreview;
  stderr: SchedulerStreamPreview;
}

interface CallbackFrame extends SchedulerWake {
  version: number;
  capability: string;
}

interface SchedulerSessionOptions {
  onWake(wake: SchedulerWake): void;
  runBq?: (invocation: BqInvocation) => Promise<BqProcessResult>;
  nodeRuntimePath?: string;
  callbackRunnerPath?: string;
  environment?: NodeJS.ProcessEnv;
}

function selectedEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of BQ_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function hasExactKeys(value: object, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function byteLengthWithin(value: string, maximum: number): boolean {
  return Buffer.byteLength(value, "utf8") <= maximum;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPreview(value: unknown): value is SchedulerStreamPreview {
  return isRecord(value)
    && hasExactKeys(value, ["preview", "truncated"])
    && typeof value.preview === "string"
    && byteLengthWithin(value.preview, MAX_PREVIEW_BYTES)
    && typeof value.truncated === "boolean";
}

function isOutcome(value: unknown): value is SchedulerPayloadOutcome {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "heartbeat") return hasExactKeys(value, ["kind"]);
  if (value.kind === "exit") {
    return hasExactKeys(value, ["kind", "code"])
      && typeof value.code === "number"
      && Number.isInteger(value.code)
      && value.code >= 0
      && value.code <= 255;
  }
  if (value.kind === "signal") {
    return hasExactKeys(value, ["kind", "signal"])
      && typeof value.signal === "string"
      && /^[A-Z][A-Z0-9]{1,15}$/.test(value.signal);
  }
  if (value.kind === "start_error") {
    return hasExactKeys(value, ["kind", "message"])
      && typeof value.message === "string"
      && byteLengthWithin(value.message, MAX_START_ERROR_BYTES);
  }
  return false;
}

function parseCallbackFrame(line: string): CallbackFrame | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || !hasExactKeys(value, [
    "version",
    "capability",
    "submissionId",
    "wakeId",
    "reentryPrompt",
    "outcome",
    "stdout",
    "stderr",
  ])) return undefined;
  if (value.version !== CALLBACK_PROTOCOL_VERSION
    || typeof value.capability !== "string"
    || !CAPABILITY_PATTERN.test(value.capability)
    || typeof value.submissionId !== "string"
    || !UUID_PATTERN.test(value.submissionId)
    || typeof value.wakeId !== "string"
    || !UUID_PATTERN.test(value.wakeId)
    || typeof value.reentryPrompt !== "string"
    || !byteLengthWithin(value.reentryPrompt, MAX_REENTRY_PROMPT_BYTES)
    || !isOutcome(value.outcome)
    || !isPreview(value.stdout)
    || !isPreview(value.stderr)) return undefined;
  return value as unknown as CallbackFrame;
}

function capabilitiesMatch(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return actualBuffer.length === expectedBuffer.length
    && timingSafeEqual(actualBuffer, expectedBuffer);
}

function assertBoundedSubmitInput(input: SchedulerSubmitInput): void {
  if (!input.reentryPrompt.trim()) {
    throw new Error("scheduler_submit requires a complete reentry prompt.");
  }
  if (!byteLengthWithin(input.reentryPrompt, MAX_REENTRY_PROMPT_BYTES)) {
    throw new Error(`Scheduler reentry prompt exceeds ${MAX_REENTRY_PROMPT_BYTES} UTF-8 bytes.`);
  }

  if (input.timing) {
    for (const [name, value] of Object.entries(input.timing)) {
      if (typeof value === "string" && !byteLengthWithin(value, MAX_TIMING_VALUE_BYTES)) {
        throw new Error(`Scheduler timing value ${name} exceeds ${MAX_TIMING_VALUE_BYTES} UTF-8 bytes.`);
      }
    }
  }

  if (!input.payload) return;
  if (!input.payload.executable.trim()) {
    throw new Error("Scheduler payload executable must not be empty.");
  }
  if (!byteLengthWithin(input.payload.executable, MAX_ARGUMENT_BYTES)) {
    throw new Error(`Scheduler payload executable exceeds ${MAX_ARGUMENT_BYTES} UTF-8 bytes.`);
  }
  if (input.payload.cwd && !byteLengthWithin(input.payload.cwd, MAX_ARGUMENT_BYTES)) {
    throw new Error(`Scheduler working directory exceeds ${MAX_ARGUMENT_BYTES} UTF-8 bytes.`);
  }
  const arguments_ = input.payload.args ?? [];
  if (arguments_.length > MAX_PAYLOAD_ARGUMENTS) {
    throw new Error(`Scheduler payload accepts at most ${MAX_PAYLOAD_ARGUMENTS} literal arguments.`);
  }
  let totalBytes = 0;
  for (const argument of arguments_) {
    const bytes = Buffer.byteLength(argument, "utf8");
    if (bytes > MAX_ARGUMENT_BYTES) {
      throw new Error(`A scheduler payload argument exceeds ${MAX_ARGUMENT_BYTES} UTF-8 bytes.`);
    }
    totalBytes += bytes;
  }
  if (totalBytes > MAX_TOTAL_ARGUMENT_BYTES) {
    throw new Error(`Scheduler payload arguments exceed ${MAX_TOTAL_ARGUMENT_BYTES} total UTF-8 bytes.`);
  }
}

function timingArguments(timing: SchedulerTiming | undefined): string[] {
  if (!timing) return [];
  const arguments_: string[] = [];
  if (timing.in !== undefined) arguments_.push("--in", timing.in);
  if (timing.at !== undefined) arguments_.push("--at", timing.at);
  if (timing.cron !== undefined) arguments_.push("--cron", timing.cron);
  if (timing.tz !== undefined) arguments_.push("--tz", timing.tz);
  if (timing.every !== undefined) arguments_.push("--every", timing.every);
  if (timing.count !== undefined) arguments_.push("--count", String(timing.count));
  return arguments_;
}

async function assertDirectory(path: string): Promise<void> {
  let metadata;
  try {
    metadata = await stat(path);
    await access(path, constants.X_OK);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Scheduler working directory is unavailable: ${path}. ${message}`);
  }
  if (!metadata.isDirectory()) {
    throw new Error(`Scheduler working directory is not a directory: ${path}.`);
  }
}

async function assertExecutable(path: string, name: string): Promise<void> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new Error("not a regular file");
    await access(path, constants.X_OK);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Scheduler ${name} is unavailable: ${path}. ${message}`);
  }
}

async function listen(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolveListen, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

export class SchedulerSession {
  private readonly socketPath: string;
  private readonly capability: string;
  private readonly callbackDirectory: string;
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private readonly runBq: (invocation: BqInvocation) => Promise<BqProcessResult>;
  private readonly nodeRuntimePath: string;
  private readonly callbackRunnerPath: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly onWake: (wake: SchedulerWake) => void;
  private readonly submissions = new Map<string, string>();
  private readonly deliveredWakeIds = new Set<string>();
  private closed = false;

  private constructor(
    callbackDirectory: string,
    socketPath: string,
    capability: string,
    server: Server,
    options: SchedulerSessionOptions,
  ) {
    this.callbackDirectory = callbackDirectory;
    this.socketPath = socketPath;
    this.capability = capability;
    this.server = server;
    this.runBq = options.runBq ?? runBqProcess;
    this.nodeRuntimePath = options.nodeRuntimePath ?? process.execPath;
    this.callbackRunnerPath = options.callbackRunnerPath ?? CALLBACK_RUNNER;
    this.environment = selectedEnvironment(options.environment ?? process.env);
    this.onWake = options.onWake;
  }

  static async start(options: SchedulerSessionOptions): Promise<SchedulerSession> {
    const callbackDirectory = await mkdtemp(join(tmpdir(), "ompi-scheduler-"));
    try {
      await chmod(callbackDirectory, 0o700);
    } catch (error) {
      await rmdir(callbackDirectory).catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Scheduler callback endpoint is unavailable: ${message}`);
    }
    const socketPath = join(callbackDirectory, "wake.sock");
    const capability = randomBytes(32).toString("base64url");
    const server = createServer();
    const session = new SchedulerSession(
      callbackDirectory,
      socketPath,
      capability,
      server,
      options,
    );
    server.on("connection", (socket) => session.receive(socket));

    try {
      await listen(server, socketPath);
      await chmod(socketPath, 0o600);
      return session;
    } catch (error) {
      server.close();
      await unlink(socketPath).catch(() => undefined);
      await rmdir(callbackDirectory).catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Scheduler callback endpoint is unavailable: ${message}`);
    }
  }

  async submit(
    input: SchedulerSubmitInput,
    sessionCwd: string,
    signal?: AbortSignal,
  ): Promise<SchedulerSubmissionResult> {
    if (this.closed || !this.server.listening) {
      throw new Error("Scheduler callback endpoint is unavailable for this session.");
    }
    assertBoundedSubmitInput(input);

    const cwd = resolve(sessionCwd, input.payload?.cwd ?? ".");
    await assertDirectory(cwd);
    await assertExecutable(this.nodeRuntimePath, "Node runtime");
    await assertExecutable(this.callbackRunnerPath, "callback helper");
    const socketMetadata = await lstat(this.socketPath).catch(() => undefined);
    if (!socketMetadata?.isSocket()) {
      throw new Error(`Scheduler callback endpoint is unavailable: ${this.socketPath}.`);
    }

    const submissionId = randomUUID();
    this.submissions.set(submissionId, input.reentryPrompt);
    const runnerArguments = [
      this.callbackRunnerPath,
      "--socket", this.socketPath,
      "--capability", this.capability,
      "--submission", submissionId,
      "--prompt-base64", Buffer.from(input.reentryPrompt, "utf8").toString("base64url"),
    ];
    if (input.payload) {
      runnerArguments.push("--", input.payload.executable, ...(input.payload.args ?? []));
    }
    const args = [
      "--cwd", cwd,
      ...timingArguments(input.timing),
      "--",
      this.nodeRuntimePath,
      ...runnerArguments,
    ];
    let bq: BqProcessResult;
    try {
      bq = await this.runBq({
        command: "bq",
        args,
        cwd: isAbsolute(sessionCwd) ? sessionCwd : resolve(sessionCwd),
        env: { ...this.environment },
        signal,
      });
    } catch (error) {
      this.submissions.delete(submissionId);
      throw error;
    }

    // A nonzero finite-repeat submission may have accepted earlier occurrences
    // before a later one failed, so retain callback correlation once bq started.
    return {
      acceptance: bq.code === 0 && bq.signal === null && !bq.cancelled
        ? "confirmed"
        : "unknown",
      submissionId,
      bq,
    };
  }

  private receive(socket: Socket): void {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    socket.setTimeout(SOCKET_READ_TIMEOUT_MS, () => socket.destroy());
    let buffer = Buffer.alloc(0);
    let handled = false;

    const reject = () => {
      if (handled) return;
      handled = true;
      socket.end(`${JSON.stringify({ version: CALLBACK_PROTOCOL_VERSION, ok: false })}\n`);
    };

    socket.on("data", (chunk: Buffer) => {
      if (handled) return;
      if (buffer.length + chunk.length > MAX_CALLBACK_FRAME_BYTES) {
        reject();
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
    });
    socket.once("end", () => {
      if (handled) return;
      const newline = buffer.indexOf(0x0a);
      if (newline < 0 || newline !== buffer.length - 1) {
        reject();
        return;
      }

      const frame = parseCallbackFrame(buffer.subarray(0, newline).toString("utf8"));
      const expectedPrompt = frame ? this.submissions.get(frame.submissionId) : undefined;
      if (!frame
        || !capabilitiesMatch(frame.capability, this.capability)
        || expectedPrompt === undefined
        || frame.reentryPrompt !== expectedPrompt
        || this.deliveredWakeIds.has(frame.wakeId)) {
        reject();
        return;
      }

      handled = true;
      this.deliveredWakeIds.add(frame.wakeId);
      const { version: _version, capability: _capability, ...wake } = frame;
      try {
        this.onWake(wake);
        socket.end(`${JSON.stringify({ version: CALLBACK_PROTOCOL_VERSION, ok: true })}\n`);
      } catch {
        this.deliveredWakeIds.delete(frame.wakeId);
        socket.end(`${JSON.stringify({ version: CALLBACK_PROTOCOL_VERSION, ok: false })}\n`);
      }
    });
    socket.once("error", () => socket.destroy());
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.submissions.clear();
    this.deliveredWakeIds.clear();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (this.server.listening) {
      await new Promise<void>((resolveClose) => this.server.close(() => resolveClose()));
    }
    await unlink(this.socketPath).catch(() => undefined);
    await rmdir(this.callbackDirectory).catch(() => undefined);
  }
}
