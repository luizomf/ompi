import { spawn, type ChildProcess } from "node:child_process";
import type { BqInvocation, BqProcessResult } from "./scheduler.ts";

const MAX_BQ_STDOUT_BYTES = 16_000;
const MAX_BQ_STDERR_BYTES = 8_000;
const FORCE_KILL_DELAY_MS = 500;

function decodeWithin(buffer: Buffer, maximumBytes: number): string {
  let text = buffer.toString("utf8");
  while (Buffer.byteLength(text, "utf8") > maximumBytes && text.length > 0) {
    const last = text.charCodeAt(text.length - 1);
    const remove = last >= 0xdc00 && last <= 0xdfff && text.length > 1 ? 2 : 1;
    text = text.slice(0, -remove);
  }
  return text;
}

class BoundedCapture {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  private seenBytes = 0;

  constructor(private readonly limit: number) {}

  append(chunk: Buffer): void {
    this.seenBytes += chunk.length;
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
    return decodeWithin(Buffer.concat(this.chunks, this.bytes), this.limit);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back when the process group has already exited.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The direct child has already exited.
  }
}

export function runBqProcess(invocation: BqInvocation): Promise<BqProcessResult> {
  if (invocation.signal?.aborted) {
    return Promise.resolve({
      code: null,
      signal: null,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      cancelled: true,
    });
  }

  return new Promise((resolveRun, reject) => {
    const stdout = new BoundedCapture(MAX_BQ_STDOUT_BYTES);
    const stderr = new BoundedCapture(MAX_BQ_STDERR_BYTES);
    let child: ChildProcess;
    let startupError: Error | undefined;
    let cancelled = false;
    let forceKill: NodeJS.Timeout | undefined;
    let settled = false;

    const abort = () => {
      if (settled || cancelled) return;
      cancelled = true;
      killProcessGroup(child, "SIGTERM");
      forceKill = setTimeout(() => killProcessGroup(child, "SIGKILL"), FORCE_KILL_DELAY_MS);
    };
    const cleanup = () => {
      invocation.signal?.removeEventListener("abort", abort);
      if (forceKill) clearTimeout(forceKill);
    };

    try {
      child = spawn(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        env: invocation.env,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(new Error(`Failed to start bq: ${errorMessage(error)}`));
      return;
    }

    invocation.signal?.addEventListener("abort", abort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => stdout.append(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk));
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
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      killProcessGroup(child, "SIGKILL");
      cleanup();
      if (startupError) {
        reject(new Error(`Failed to start bq: ${startupError.message}`));
        return;
      }
      resolveRun({
        code,
        signal,
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        cancelled,
      });
    });

    if (invocation.signal?.aborted) abort();
  });
}
