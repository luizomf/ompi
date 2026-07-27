import { spawn } from "node:child_process";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SchedulerSession,
  type BqInvocation,
  type BqProcessResult,
  type SchedulerWake,
} from "./scheduler.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ompi-scheduler-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function valueAfter(invocation: BqInvocation, option: string): string {
  const index = invocation.args.indexOf(option);
  const value = invocation.args[index + 1];
  if (index < 0 || value === undefined) throw new Error(`Missing invocation option: ${option}`);
  return value;
}

async function sendCallbackChunks(socketPath: string, chunks: string[]): Promise<string> {
  return new Promise((resolveSend, reject) => {
    const socket = createConnection(socketPath);
    let response = "";
    socket.setEncoding("utf8");
    socket.once("connect", async () => {
      for (const chunk of chunks) {
        await new Promise<void>((resolveWrite, rejectWrite) => {
          socket.write(chunk, "utf8", (error) => error ? rejectWrite(error) : resolveWrite());
        });
      }
      socket.end();
    });
    socket.on("data", (chunk: string) => { response += chunk; });
    socket.once("end", () => resolveSend(response));
    socket.once("error", reject);
  });
}

async function sendRawCallback(socketPath: string, frame: unknown): Promise<string> {
  return sendCallbackChunks(socketPath, [`${JSON.stringify(frame)}\n`]);
}

async function runQueuedInvocation(invocation: BqInvocation): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}> {
  const separator = invocation.args.indexOf("--");
  const command = invocation.args[separator + 1];
  const args = invocation.args.slice(separator + 2);
  const cwdIndex = invocation.args.indexOf("--cwd");
  const cwd = invocation.args[cwdIndex + 1];

  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: invocation.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code, signal) => resolveRun({ code, signal, stdout, stderr }));
  });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("scheduler submission", () => {
  it("submits an exact literal bq invocation and returns its immediate acceptance result", async () => {
    const cwd = await temporaryDirectory();
    const invocations: BqInvocation[] = [];
    const bqResult: BqProcessResult = {
      code: 0,
      signal: null,
      stdout: "bq: accepted Job job-1 (queued)\n",
      stderr: "notice\n",
      stdoutTruncated: false,
      stderrTruncated: false,
      cancelled: false,
    };
    const session = await SchedulerSession.start({
      onWake: () => undefined,
      runBq: async (invocation) => {
        invocations.push(invocation);
        return bqResult;
      },
    });

    try {
      const result = await session.submit({
        reentryPrompt: "Recheck the deployment and report whether it is healthy.",
        timing: { in: "10m", every: "30m", count: 4 },
        payload: {
          executable: "/usr/bin/printf",
          args: ["%s", "literal; $(not a shell)"],
          cwd,
        },
      }, cwd);

      expect(result).toMatchObject({ accepted: true, bq: bqResult });
      expect(invocations).toHaveLength(1);
      const invocation = invocations[0];
      expect(invocation.command).toBe("bq");
      expect(invocation.cwd).toBe(cwd);
      expect(invocation).not.toHaveProperty("shell");
      expect(invocation.args.slice(0, 9)).toEqual([
        "--cwd", cwd,
        "--in", "10m",
        "--every", "30m",
        "--count", "4",
        "--",
      ]);
      expect(invocation.args[9]).toMatch(/\/extensions\/scheduler\/callback-runner\.mjs$/);
      const socketPath = valueAfter(invocation, "--socket");
      const capability = valueAfter(invocation, "--capability");
      expect(socketPath).toMatch(/\/ompi-scheduler-[^/]+\/wake\.sock$/);
      expect(capability).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(invocation.args.slice(10, 16)).toEqual([
        "--socket", socketPath,
        "--capability", capability,
        "--submission", result.submissionId,
      ]);
      expect(invocation.args[16]).toBe("--prompt-base64");
      expect(Buffer.from(invocation.args[17], "base64url").toString("utf8")).toBe(
        "Recheck the deployment and report whether it is healthy.",
      );
      expect(invocation.args.slice(18)).toEqual([
        "--",
        "/usr/bin/printf",
        "%s",
        "literal; $(not a shell)",
      ]);
      expect(invocation.env).toHaveProperty("PATH", process.env.PATH);
      expect(invocation.env).not.toHaveProperty("OPENAI_API_KEY");
    } finally {
      await session.close();
    }
  });

  it("returns a failed bq acceptance result without reporting it as accepted", async () => {
    const cwd = await temporaryDirectory();
    const session = await SchedulerSession.start({
      onWake: () => undefined,
      runBq: async () => ({
        code: 2,
        signal: null,
        stdout: "partial acceptance output\n",
        stderr: "bq: invalid timing\n",
        stdoutTruncated: false,
        stderrTruncated: false,
        cancelled: false,
      }),
    });

    try {
      const result = await session.submit({
        reentryPrompt: "Correct the rejected scheduler request using the diagnostics.",
        timing: { in: "invalid" },
      }, cwd);

      expect(result).toMatchObject({
        accepted: false,
        bq: {
          code: 2,
          signal: null,
          stdout: "partial acceptance output\n",
          stderr: "bq: invalid timing\n",
        },
      });
    } finally {
      await session.close();
    }
  });

  it("delivers a heartbeat wake through the real private Unix socket", async () => {
    const cwd = await temporaryDirectory();
    let invocation: BqInvocation | undefined;
    const wakes: SchedulerWake[] = [];
    const session = await SchedulerSession.start({
      onWake: (wake) => wakes.push(wake),
      runBq: async (candidate) => {
        invocation = candidate;
        return {
          code: 0,
          signal: null,
          stdout: "bq: accepted Job heartbeat (queued)\n",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          cancelled: false,
        };
      },
    });

    try {
      const submission = await session.submit({
        reentryPrompt: "Review the current incident state and decide the next safe action.",
      }, cwd);
      if (!invocation) throw new Error("bq invocation was not captured");

      const runner = await runQueuedInvocation(invocation);

      expect(runner).toMatchObject({ code: 0, signal: null, stdout: "", stderr: "" });
      expect(wakes).toHaveLength(1);
      expect(wakes[0]).toMatchObject({
        submissionId: submission.submissionId,
        reentryPrompt: "Review the current incident state and decide the next safe action.",
        outcome: { kind: "heartbeat" },
        stdout: { preview: "", truncated: false },
        stderr: { preview: "", truncated: false },
      });
    } finally {
      await session.close();
    }
  });

  it("forwards payload streams while waking with bounded previews after success", async () => {
    const cwd = await temporaryDirectory();
    let invocation: BqInvocation | undefined;
    const wakes: SchedulerWake[] = [];
    const session = await SchedulerSession.start({
      onWake: (wake) => wakes.push(wake),
      runBq: async (candidate) => {
        invocation = candidate;
        return {
          code: 0,
          signal: null,
          stdout: "accepted\n",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          cancelled: false,
        };
      },
    });

    try {
      await session.submit({
        reentryPrompt: "Inspect the command result and continue the maintenance check.",
        payload: {
          executable: process.execPath,
          args: [
            "--input-type=module",
            "--eval",
            "process.stdout.write('o'.repeat(6000)); process.stderr.write('e'.repeat(6000));",
          ],
        },
      }, cwd);
      if (!invocation) throw new Error("bq invocation was not captured");

      const runner = await runQueuedInvocation(invocation);

      expect(runner).toMatchObject({
        code: 0,
        signal: null,
        stdout: "o".repeat(6_000),
        stderr: "e".repeat(6_000),
      });
      expect(wakes).toHaveLength(1);
      expect(wakes[0]).toMatchObject({
        outcome: { kind: "exit", code: 0 },
        stdout: { preview: "o".repeat(4_000), truncated: true },
        stderr: { preview: "e".repeat(4_000), truncated: true },
      });
    } finally {
      await session.close();
    }
  });

  it("keeps multibyte payload previews within the callback byte limit", async () => {
    const cwd = await temporaryDirectory();
    let invocation: BqInvocation | undefined;
    const wakes: SchedulerWake[] = [];
    const session = await SchedulerSession.start({
      onWake: (wake) => wakes.push(wake),
      runBq: async (candidate) => {
        invocation = candidate;
        return {
          code: 0,
          signal: null,
          stdout: "accepted\n",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          cancelled: false,
        };
      },
    });

    try {
      await session.submit({
        reentryPrompt: "Use the bounded Unicode preview to continue the deferred check.",
        payload: {
          executable: process.execPath,
          args: ["--input-type=module", "--eval", "process.stdout.write('€'.repeat(2000));"],
        },
      }, cwd);
      if (!invocation) throw new Error("bq invocation was not captured");

      const runner = await runQueuedInvocation(invocation);

      expect(runner.code).toBe(0);
      expect(wakes).toHaveLength(1);
      expect(Buffer.byteLength(wakes[0].stdout.preview, "utf8")).toBeLessThanOrEqual(4_000);
      expect(wakes[0].stdout.truncated).toBe(true);
    } finally {
      await session.close();
    }
  });

  it("accepts maximum escaped prompt and preview content within the bounded protocol", async () => {
    const cwd = await temporaryDirectory();
    let invocation: BqInvocation | undefined;
    const wakes: SchedulerWake[] = [];
    const session = await SchedulerSession.start({
      onWake: (wake) => wakes.push(wake),
      runBq: async (candidate) => {
        invocation = candidate;
        return {
          code: 0,
          signal: null,
          stdout: "accepted\n",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          cancelled: false,
        };
      },
    });
    const prompt = `Continue ${"\n".repeat(7_980)}now`;

    try {
      await session.submit({
        reentryPrompt: prompt,
        payload: {
          executable: process.execPath,
          args: [
            "--input-type=module",
            "--eval",
            "process.stdout.write('\\n'.repeat(5000)); process.stderr.write('\\n'.repeat(5000));",
          ],
        },
      }, cwd);
      if (!invocation) throw new Error("bq invocation was not captured");

      const runner = await runQueuedInvocation(invocation);

      expect(runner.code).toBe(0);
      expect(wakes).toHaveLength(1);
      expect(wakes[0].reentryPrompt).toBe(prompt);
      expect(wakes[0].stdout).toEqual({ preview: "\n".repeat(4_000), truncated: true });
      expect(wakes[0].stderr).toEqual({ preview: "\n".repeat(4_000), truncated: true });
    } finally {
      await session.close();
    }
  });

  it("preserves a nonzero payload exit and delivers exactly one mechanical outcome", async () => {
    const cwd = await temporaryDirectory();
    let invocation: BqInvocation | undefined;
    const wakes: SchedulerWake[] = [];
    const session = await SchedulerSession.start({
      onWake: (wake) => wakes.push(wake),
      runBq: async (candidate) => {
        invocation = candidate;
        return {
          code: 0,
          signal: null,
          stdout: "accepted\n",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          cancelled: false,
        };
      },
    });

    try {
      await session.submit({
        reentryPrompt: "Use the failed check to diagnose the next action without assuming Queue state.",
        payload: {
          executable: process.execPath,
          args: ["--input-type=module", "--eval", "process.stderr.write('failed check'); process.exitCode = 7;"],
        },
      }, cwd);
      if (!invocation) throw new Error("bq invocation was not captured");

      const runner = await runQueuedInvocation(invocation);

      expect(runner).toMatchObject({ code: 7, signal: null, stderr: "failed check" });
      expect(wakes).toHaveLength(1);
      expect(wakes[0]).toMatchObject({
        outcome: { kind: "exit", code: 7 },
        stderr: { preview: "failed check", truncated: false },
      });
    } finally {
      await session.close();
    }
  });

  it("preserves payload signal termination after delivering its wake", async () => {
    const cwd = await temporaryDirectory();
    let invocation: BqInvocation | undefined;
    const wakes: SchedulerWake[] = [];
    const session = await SchedulerSession.start({
      onWake: (wake) => wakes.push(wake),
      runBq: async (candidate) => {
        invocation = candidate;
        return {
          code: 0,
          signal: null,
          stdout: "accepted\n",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          cancelled: false,
        };
      },
    });

    try {
      await session.submit({
        reentryPrompt: "Handle the terminated check and choose whether a safer retry is appropriate.",
        payload: {
          executable: process.execPath,
          args: ["--input-type=module", "--eval", "process.kill(process.pid, 'SIGTERM');"],
        },
      }, cwd);
      if (!invocation) throw new Error("bq invocation was not captured");

      const runner = await runQueuedInvocation(invocation);

      expect(runner).toMatchObject({ code: null, signal: "SIGTERM" });
      expect(wakes).toHaveLength(1);
      expect(wakes[0]).toMatchObject({ outcome: { kind: "signal", signal: "SIGTERM" } });
    } finally {
      await session.close();
    }
  });

  it("reports a command-start failure in the wake and runner diagnostics", async () => {
    const cwd = await temporaryDirectory();
    let invocation: BqInvocation | undefined;
    const wakes: SchedulerWake[] = [];
    const missingExecutable = join(cwd, "missing-payload");
    const session = await SchedulerSession.start({
      onWake: (wake) => wakes.push(wake),
      runBq: async (candidate) => {
        invocation = candidate;
        return {
          code: 0,
          signal: null,
          stdout: "accepted\n",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          cancelled: false,
        };
      },
    });

    try {
      await session.submit({
        reentryPrompt: "Diagnose why the deferred command could not start and propose a corrected executable.",
        payload: { executable: missingExecutable },
      }, cwd);
      if (!invocation) throw new Error("bq invocation was not captured");

      const runner = await runQueuedInvocation(invocation);

      expect(runner.code).toBe(127);
      expect(runner.stderr).toContain("scheduler callback runner: payload start failed:");
      expect(wakes).toHaveLength(1);
      expect(wakes[0].outcome).toMatchObject({
        kind: "start_error",
        message: expect.stringContaining("ENOENT"),
      });
    } finally {
      await session.close();
    }
  });

  it("reports when a heartbeat can no longer reach its live session endpoint", async () => {
    const cwd = await temporaryDirectory();
    let invocation: BqInvocation | undefined;
    const session = await SchedulerSession.start({
      onWake: () => undefined,
      runBq: async (candidate) => {
        invocation = candidate;
        return {
          code: 0,
          signal: null,
          stdout: "accepted\n",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          cancelled: false,
        };
      },
    });
    await session.submit({
      reentryPrompt: "This wake cannot be delivered after its owning session closes.",
    }, cwd);
    if (!invocation) throw new Error("bq invocation was not captured");
    await session.close();

    const runner = await runQueuedInvocation(invocation);

    expect(runner.code).toBe(1);
    expect(runner.stderr).toContain("scheduler callback runner: callback unavailable:");
  });

  it("fails a successful payload when its wake can no longer be delivered", async () => {
    const cwd = await temporaryDirectory();
    let invocation: BqInvocation | undefined;
    const session = await SchedulerSession.start({
      onWake: () => undefined,
      runBq: async (candidate) => {
        invocation = candidate;
        return {
          code: 0,
          signal: null,
          stdout: "accepted\n",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          cancelled: false,
        };
      },
    });
    await session.submit({
      reentryPrompt: "A successful payload must not hide failure to deliver its scheduler wake.",
      payload: { executable: process.execPath, args: ["--eval", "process.exitCode = 0"] },
    }, cwd);
    if (!invocation) throw new Error("bq invocation was not captured");
    await session.close();

    const runner = await runQueuedInvocation(invocation);

    expect(runner.code).toBe(1);
    expect(runner.stderr).toContain("scheduler callback runner: callback unavailable:");
  });

  it("rejects unauthorized and malformed callback frames without a wake", async () => {
    const cwd = await temporaryDirectory();
    const wakes: SchedulerWake[] = [];
    const prompt = "Reenter only from the authorized scheduler callback.";
    let invocation: BqInvocation | undefined;
    const session = await SchedulerSession.start({
      onWake: (wake) => wakes.push(wake),
      runBq: async (candidate) => {
        invocation = candidate;
        return {
          code: 0,
          signal: null,
          stdout: "accepted\n",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          cancelled: false,
        };
      },
    });

    try {
      const submission = await session.submit({ reentryPrompt: prompt }, cwd);
      if (!invocation) throw new Error("bq invocation was not captured");
      const socketPath = valueAfter(invocation, "--socket");
      const baseFrame = {
        version: 1,
        capability: valueAfter(invocation, "--capability"),
        submissionId: submission.submissionId,
        wakeId: "4d88e8de-bdd3-49bf-ad4f-ff4841c309c6",
        reentryPrompt: prompt,
        outcome: { kind: "heartbeat" },
        stdout: { preview: "", truncated: false },
        stderr: { preview: "", truncated: false },
      };

      const unauthorized = await sendRawCallback(socketPath, {
        ...baseFrame,
        capability: "not-the-session-capability",
      });
      const malformed = await sendRawCallback(socketPath, {
        ...baseFrame,
        unexpected: true,
      });
      const extraFrame = await sendCallbackChunks(socketPath, [
        `${JSON.stringify(baseFrame)}\n`,
        `${JSON.stringify(baseFrame)}\n`,
      ]);

      expect(JSON.parse(unauthorized)).toEqual({ version: 1, ok: false });
      expect(JSON.parse(malformed)).toEqual({ version: 1, ok: false });
      expect(JSON.parse(extraFrame)).toEqual({ version: 1, ok: false });
      expect(wakes).toEqual([]);
    } finally {
      await session.close();
    }
  });

  it("delivers a correlated wake ID only once", async () => {
    const cwd = await temporaryDirectory();
    const wakes: SchedulerWake[] = [];
    const prompt = "Continue this one scheduler occurrence exactly once.";
    let invocation: BqInvocation | undefined;
    const session = await SchedulerSession.start({
      onWake: (wake) => wakes.push(wake),
      runBq: async (candidate) => {
        invocation = candidate;
        return {
          code: 0,
          signal: null,
          stdout: "accepted\n",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          cancelled: false,
        };
      },
    });

    try {
      const submission = await session.submit({ reentryPrompt: prompt }, cwd);
      if (!invocation) throw new Error("bq invocation was not captured");
      const socketPath = valueAfter(invocation, "--socket");
      const frame = {
        version: 1,
        capability: valueAfter(invocation, "--capability"),
        submissionId: submission.submissionId,
        wakeId: "5123f981-9f2b-48a8-a779-664319b2f6f1",
        reentryPrompt: prompt,
        outcome: { kind: "heartbeat" },
        stdout: { preview: "", truncated: false },
        stderr: { preview: "", truncated: false },
      };

      expect(JSON.parse(await sendRawCallback(socketPath, frame))).toEqual({ version: 1, ok: true });
      expect(JSON.parse(await sendRawCallback(socketPath, frame))).toEqual({ version: 1, ok: false });
      expect(wakes).toHaveLength(1);
    } finally {
      await session.close();
    }
  });

  it("bounds the queued literal argument vector before invoking bq", async () => {
    const cwd = await temporaryDirectory();
    let bqCalls = 0;
    const session = await SchedulerSession.start({
      onWake: () => undefined,
      runBq: async () => {
        bqCalls++;
        return {
          code: 0,
          signal: null,
          stdout: "accepted\n",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          cancelled: false,
        };
      },
    });

    try {
      await expect(session.submit({
        reentryPrompt: "Correct the oversized command request before resubmitting it.",
        payload: { executable: "/usr/bin/true", args: Array(129).fill("argument") },
      }, cwd)).rejects.toThrow("at most 128 literal arguments");
      expect(bqCalls).toBe(0);
    } finally {
      await session.close();
    }
  });

  it("rejects unavailable working directories and callback helpers before invoking bq", async () => {
    const cwd = await temporaryDirectory();
    let bqCalls = 0;
    const bq = async (): Promise<BqProcessResult> => {
      bqCalls++;
      return {
        code: 0,
        signal: null,
        stdout: "accepted\n",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        cancelled: false,
      };
    };
    const missingHelper = join(cwd, "missing-callback-runner.mjs");
    const missingDirectory = join(cwd, "missing-directory");
    const normal = await SchedulerSession.start({ onWake: () => undefined, runBq: bq });
    const noHelper = await SchedulerSession.start({
      onWake: () => undefined,
      runBq: bq,
      callbackRunnerPath: missingHelper,
    });

    try {
      await expect(normal.submit({
        reentryPrompt: "Retry only after correcting the working directory.",
        payload: { executable: "/usr/bin/true", cwd: missingDirectory },
      }, cwd)).rejects.toThrow("working directory is unavailable");
      await expect(noHelper.submit({
        reentryPrompt: "Retry only after restoring the callback helper.",
      }, cwd)).rejects.toThrow("callback helper is unavailable");
      expect(bqCalls).toBe(0);
    } finally {
      await normal.close();
      await noHelper.close();
    }
  });

  it("closes the session endpoint idempotently and removes its private runtime directory", async () => {
    const cwd = await temporaryDirectory();
    let invocation: BqInvocation | undefined;
    const session = await SchedulerSession.start({
      onWake: () => undefined,
      runBq: async (candidate) => {
        invocation = candidate;
        return {
          code: 0,
          signal: null,
          stdout: "accepted\n",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          cancelled: false,
        };
      },
    });
    await session.submit({ reentryPrompt: "Capture the endpoint for shutdown cleanup." }, cwd);
    if (!invocation) throw new Error("bq invocation was not captured");
    const socketPath = valueAfter(invocation, "--socket");
    const runtimeDirectory = join(socketPath, "..");

    const socketMetadata = await lstat(socketPath);
    const directoryMetadata = await lstat(runtimeDirectory);
    expect(socketMetadata.isSocket()).toBe(true);
    expect(socketMetadata.mode & 0o777).toBe(0o600);
    expect(directoryMetadata.mode & 0o777).toBe(0o700);
    await session.close();
    await session.close();

    await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(runtimeDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(session.submit({ reentryPrompt: "too late" }, cwd)).rejects.toThrow(
      "callback endpoint is unavailable",
    );
  });
});
