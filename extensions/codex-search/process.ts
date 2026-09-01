import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";

const CODEX_SEARCH_TIMEOUT_MS = 600_000;
const CODEX_SEARCH_STDOUT_BYTES = 48_000;
const CODEX_SEARCH_STDERR_BYTES = 2_000;
const FORCE_KILL_DELAY_MS = 500;

export type CodexSearchIntent = "exact_url" | "research" | "image";

export interface ProcessRequest {
  command: string;
  args: string[];
  input: string;
  cwd: string;
  signal?: AbortSignal;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
}

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

class BoundedCapture {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private seenBytes = 0;

  constructor(
    private readonly limit: number,
    private readonly keepTail = false,
  ) {}

  append(chunk: Buffer): void {
    this.seenBytes += chunk.length;
    if (this.keepTail) {
      const combined = Buffer.concat([...this.chunks, chunk]);
      const retained = combined.subarray(Math.max(0, combined.length - this.limit));
      this.chunks = retained.length ? [retained] : [];
      this.bytes = retained.length;
      return;
    }

    const remaining = this.limit - this.bytes;
    if (remaining <= 0) return;
    const retained = chunk.subarray(0, remaining);
    this.chunks.push(retained);
    this.bytes += retained.length;
  }

  get truncated(): boolean {
    return this.seenBytes > this.limit;
  }

  text(): string {
    return Buffer.concat(this.chunks, this.bytes).toString("utf8");
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invocationContext(request: ProcessRequest): string {
  const command = [request.command, ...request.args]
    .map((part) => JSON.stringify(part))
    .join(" ");
  const executable = request.command.split(/[\\/]/).at(-1);
  return [
    `Command: ${command}`,
    `Working directory: ${JSON.stringify(request.cwd)}`,
    executable === "codex_search"
      ? "Hint: Ensure codex_search is installed, executable, and available on PATH, and that Codex authentication is configured. For timeout or nonzero failures, inspect the bounded diagnostics, narrow the request when appropriate, and verify that the fixed route is available."
      : "",
    "Hint: codex_search runs from the Pi session cwd. Verify directory access (existence plus traversal/read permissions), or start Pi from an accessible working directory.",
  ].filter(Boolean).join("\n");
}

function processError(message: string, request: ProcessRequest, cause?: unknown): Error {
  const fullMessage = `${message}\n\n${invocationContext(request)}`;
  return cause === undefined ? new Error(fullMessage) : new Error(fullMessage, { cause });
}

function killProcessGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child if its process group is already unavailable.
    }
  }

  try {
    child.kill(signal);
  } catch {
    // The process has already exited.
  }
}

function truncationNotice(stream: "stdout" | "stderr", truncated: boolean, limit: number): string {
  return truncated ? `\n[${stream} truncated to ${limit} bytes]` : "";
}

export function buildCodexSearchRequest(
  query: string,
  cwd: string,
  intent: CodexSearchIntent,
  destination?: string,
  signal?: AbortSignal,
): ProcessRequest {
  const args = intent === "exact_url"
    ? [
        "--profile",
        "quick",
        "--yolo",
        "--model",
        "gpt-5.6-luna",
        "--config",
        "model_reasoning_effort=high",
      ]
    : [
        "--profile",
        "research",
        "--yolo",
        "--model",
        "gpt-5.6-sol",
        "--config",
        "model_reasoning_effort=high",
      ];
  args.push("--skip-git-repo-check", "--cd", cwd, "-");

  const input = destination === undefined
    ? query
    : [
        query,
        "",
        `Final output location (JSON string): ${JSON.stringify(destination)}`,
        "Create the final image artifact at that location.",
      ].join("\n");

  return {
    command: "codex_search",
    args,
    input,
    cwd,
    signal,
    timeoutMs: CODEX_SEARCH_TIMEOUT_MS,
    maxStdoutBytes: CODEX_SEARCH_STDOUT_BYTES,
    maxStderrBytes: CODEX_SEARCH_STDERR_BYTES,
  };
}

export async function runCodexSearch(
  query: string,
  cwd: string,
  intent: CodexSearchIntent,
  destination?: string,
  signal?: AbortSignal,
): Promise<ProcessResult> {
  if (!query.trim()) throw new Error("codex_search requires a non-empty query.");
  return runProcess(buildCodexSearchRequest(query, cwd, intent, destination, signal));
}

export function runProcess(request: ProcessRequest): Promise<ProcessResult> {
  if (request.signal?.aborted) {
    return Promise.reject(processError("codex_search was cancelled.", request));
  }

  return new Promise((resolve, reject) => {
    const stdout = new BoundedCapture(request.maxStdoutBytes);
    const stderr = new BoundedCapture(request.maxStderrBytes, true);
    let child: ChildProcessWithoutNullStreams;
    let startupError: Error | undefined;
    let inputError: Error | undefined;
    let termination: "cancelled" | "timed out" | "input error" | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let forceKill: NodeJS.Timeout | undefined;
    let settled = false;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      request.signal?.removeEventListener("abort", abort);
    };

    const terminate = (reason: typeof termination) => {
      if (settled || termination) return;
      termination = reason;
      killProcessGroup(child, "SIGTERM");
      forceKill = setTimeout(() => killProcessGroup(child, "SIGKILL"), FORCE_KILL_DELAY_MS);
    };

    const abort = () => terminate("cancelled");

    try {
      child = spawn(request.command, request.args, {
        cwd: request.cwd,
        env: process.env,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(processError(`Failed to start ${request.command}: ${errorText(error)}`, request, error));
      return;
    }

    request.signal?.addEventListener("abort", abort, { once: true });
    timeout = setTimeout(() => terminate("timed out"), request.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdout.append(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));
    child.stdin.once("error", (error) => {
      inputError = error;
      terminate("input error");
    });
    child.once("error", (error) => {
      startupError = error;
    });
    child.once("exit", () => {
      killProcessGroup(child, "SIGTERM");
      forceKill ??= setTimeout(
        () => killProcessGroup(child, "SIGKILL"),
        FORCE_KILL_DELAY_MS,
      );
    });
    child.once("close", (code, exitSignal) => {
      if (settled) return;
      settled = true;
      killProcessGroup(child, "SIGKILL");
      cleanup();

      const result: ProcessResult = {
        code: code ?? -1,
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      };

      if (startupError) {
        reject(processError(`Failed to start ${request.command}: ${startupError.message}`, request, startupError));
        return;
      }
      if (termination === "cancelled") {
        reject(processError(`${request.command} was cancelled.`, request));
        return;
      }
      if (termination === "timed out") {
        reject(processError(`${request.command} timed out after ${request.timeoutMs}ms.`, request));
        return;
      }
      if (inputError) {
        reject(processError(`Failed to send the query to ${request.command}: ${inputError.message}`, request, inputError));
        return;
      }
      if (code !== 0) {
        const status = code === null ? `signal ${exitSignal ?? "unknown"}` : `code ${code}`;
        const diagnostics = [
          result.stdout ? `stdout:\n${result.stdout}${truncationNotice("stdout", result.stdoutTruncated, request.maxStdoutBytes)}` : "",
          result.stderr ? `stderr:\n${result.stderr}${truncationNotice("stderr", result.stderrTruncated, request.maxStderrBytes)}` : "",
        ].filter(Boolean).join("\n\n");
        reject(processError(
          `${request.command} exited with ${status}.${diagnostics ? `\n\n${diagnostics}` : ""}`,
          request,
        ));
        return;
      }

      resolve(result);
    });

    if (request.signal?.aborted) abort();
    else child.stdin.end(request.input, "utf8");
  });
}
