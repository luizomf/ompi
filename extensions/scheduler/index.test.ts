import { spawn } from "node:child_process";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { formatSchedulerSubmission, registerSchedulerExtension } from "./index.ts";
import type { BqInvocation } from "./scheduler.ts";

interface RegisteredTool {
  name: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  execute(
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ): Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>;
}

async function runQueuedInvocation(invocation: BqInvocation): Promise<void> {
  const separator = invocation.args.indexOf("--");
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(invocation.args[separator + 1], invocation.args.slice(separator + 2), {
      cwd: invocation.args[invocation.args.indexOf("--cwd") + 1],
      env: invocation.env,
      shell: false,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0 && signal === null) resolveRun();
      else reject(new Error(`callback runner failed: code=${code}, signal=${signal}`));
    });
  });
}

describe("scheduler extension", () => {
  it("warns that nonzero bq completion may have partially accepted durable work", () => {
    const text = formatSchedulerSubmission({
      acceptance: "unknown",
      submissionId: "submission-1",
      bq: {
        code: 2,
        signal: null,
        stdout: "bq: scheduled 1/4 at=... schedule-1\n",
        stderr: "later schedule failed\n",
        stdoutTruncated: false,
        stderrTruncated: false,
        cancelled: false,
      },
    });

    expect(text).toContain("acceptance is unknown");
    expect(text).toContain("durable work may already have been created");
    expect(text).toContain("Do not blindly retry");
    expect(text).not.toContain("was not accepted");
  });

  it("submits through the Pi tool and injects the callback as a visible follow-up wake", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ompi-scheduler-index-"));
    const tools: RegisteredTool[] = [];
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const messages: Array<{ message: Record<string, unknown>; options: Record<string, unknown> }> = [];
    let invocation: BqInvocation | undefined;
    const pi = {
      registerTool: (tool: RegisteredTool) => tools.push(tool),
      on: (event: string, handler: (...args: unknown[]) => unknown) => handlers.set(event, handler),
      sendMessage: (message: Record<string, unknown>, options: Record<string, unknown>) => {
        messages.push({ message, options });
      },
    } as unknown as ExtensionAPI;
    const ctx = { cwd } as ExtensionContext;

    registerSchedulerExtension(pi, {
      runBq: async (candidate) => {
        invocation = candidate;
        return {
          code: 0,
          signal: null,
          stdout: "bq: accepted Job tool-1 (queued)\n",
          stderr: "warning\n",
          stdoutTruncated: false,
          stderrTruncated: false,
          cancelled: false,
        };
      },
    });

    try {
      expect(tools.map((tool) => tool.name)).toEqual(["scheduler_submit"]);
      const discovery = [
        tools[0].description,
        tools[0].promptSnippet ?? "",
        ...(tools[0].promptGuidelines ?? []),
      ].join(" ");
      for (const term of ["cron", "scheduler", "heartbeat", "reminder", "delayed command", "deferred recheck"]) {
        expect(discovery).toContain(term);
      }
      expect(discovery).toContain("complete self-contained reentryPrompt");
      expect(discovery).toContain("10m/2h/1d rather than prose or seconds");
      expect(discovery).toContain("finite repeats require in or at plus both every and count");
      expect(discovery).toContain("one-minute precision");
      expect(discovery).toContain("never wait, sleep, poll");
      expect(discovery).toContain("ordinary bash");
      await handlers.get("session_start")?.({}, ctx);
      const result = await tools[0].execute("call-1", {
        reentryPrompt: "Recheck the service health, compare it with the incident criteria, and report the next action.",
      }, undefined, undefined, ctx);
      if (!invocation) throw new Error("bq invocation was not captured");
      const socketPath = invocation.args[invocation.args.indexOf("--socket") + 1];

      expect(result.content[0].text).toContain("exit code: 0");
      expect(result.content[0].text).toContain("bq: accepted Job tool-1 (queued)\n");
      expect(result.content[0].text).toContain("warning\n");
      expect(result.content[0].text).toContain("Never wait, poll, or watch Queue completion");
      await runQueuedInvocation(invocation);

      expect(messages).toHaveLength(1);
      expect(messages[0].options).toEqual({ deliverAs: "followUp", triggerTurn: true });
      expect(messages[0].message).toMatchObject({ customType: "scheduler-wake", display: true });
      expect(messages[0].message.content).toContain("[SCHEDULER WAKE]");
      expect(messages[0].message.content).toContain(
        "Recheck the service health, compare it with the incident criteria, and report the next action.",
      );
      expect(messages[0].message.content).toContain("not an official OMQueue Job state");

      await handlers.get("session_shutdown")?.({}, ctx);
      await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
