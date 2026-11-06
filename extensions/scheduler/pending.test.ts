import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SchedulerSession, type BqInvocation, type BqProcessResult } from "./scheduler.ts";

const sessions: SchedulerSession[] = [];
const ok = (overrides: Partial<BqProcessResult> = {}): BqProcessResult => ({
  code: 0, signal: null, stdout: "", stderr: "", cancelled: false,
  stdoutTruncated: false, stderrTruncated: false, ...overrides,
});
const value = (call: BqInvocation, key: string) => call.args[call.args.indexOf(key) + 1];
const frame = (call: BqInvocation, wakeId = randomUUID()) => ({
  version: 1, capability: value(call, "--capability"), submissionId: value(call, "--submission"), wakeId,
  reentryPrompt: Buffer.from(value(call, "--prompt-base64"), "base64url").toString(),
  outcome: { kind: "heartbeat" }, stdout: { preview: "", truncated: false }, stderr: { preview: "", truncated: false },
});
async function callback(call: BqInvocation, data = frame(call)): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(value(call, "--socket"));
    let response = "";
    socket.once("connect", () => socket.end(`${JSON.stringify(data)}\n`));
    socket.on("data", (chunk) => { response += chunk.toString(); });
    socket.once("end", () => resolve(JSON.parse(response).ok));
    socket.once("error", reject);
  });
}
async function start(options: Parameters<typeof SchedulerSession.start>[0]) {
  const session = await SchedulerSession.start(options);
  sessions.push(session);
  return session;
}
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  vi.restoreAllMocks();
});

describe("local pending callback lifecycle", () => {
  it("holds before bq acceptance, through wake delivery, then resolves without deleting history", async () => {
    let release!: (result: BqProcessResult) => void;
    let invoked!: () => void;
    const started = new Promise<void>((resolve) => { invoked = resolve; });
    let call!: BqInvocation;
    const changes: number[] = [];
    const session = await start({
      onWake: () => { expect(session.pending().count).toBe(1); },
      onChange: () => changes.push(session.pending().count),
      runBq: async (invocation) => {
        call = invocation;
        invoked();
        return new Promise((resolve) => { release = resolve; });
      },
    });
    expect(session.pending()).toEqual({ count: 0, pendingIds: [], omitted: 0 });
    const submission = session.submit({ reentryPrompt: "private instructions" }, tmpdir());
    await started;
    expect(session.pending()).toEqual({ count: 1, oldestPendingAt: expect.any(Number), pendingIds: [value(call, "--submission")], omitted: 0 });
    expect(changes).toEqual([1]);
    // Callback may beat bq's acceptance receipt.
    expect(await callback(call)).toBe(true);
    expect(session.pending()).toEqual({ count: 0, pendingIds: [], omitted: 0 });
    release(ok());
    await submission;
    expect(session.pending().count).toBe(0);
    expect(session.list()[0]).toMatchObject({ acceptance: "confirmed", callbacks: 1 });
    expect(changes).toEqual([1, 0, 0]);
  });

  it.each(["nonzero", "aborted", "thrown"])("retains unknown acceptance and callback correlation after %s", async (failure) => {
    let call!: BqInvocation;
    const session = await start({ onWake: () => {}, runBq: async (invocation) => {
      call = invocation;
      if (failure === "thrown") throw new Error("acceptance transport failed");
      return ok(failure === "aborted" ? { code: null, signal: "SIGTERM", cancelled: true } : { code: 1 });
    } });
    const submission = session.submit({ reentryPrompt: "Check once" }, tmpdir());
    if (failure === "thrown") await expect(submission).rejects.toThrow("transport failed");
    else expect((await submission).acceptance).toBe("unknown");
    expect(session.pending().count).toBe(1);
    expect(await callback(call)).toBe(true);
    expect(session.pending().count).toBe(0);
  });

  it("does not acquire pending obligations for failures before bq is invoked", async () => {
    const runBq = vi.fn();
    const session = await start({ onWake: () => {}, runBq });
    await expect(session.submit({ reentryPrompt: " " }, tmpdir())).rejects.toThrow();
    await expect(session.submit({ reentryPrompt: "Check", payload: { executable: "test", cwd: "/nonexistent-scheduler-test-directory" } }, tmpdir())).rejects.toThrow();
    expect(runBq).not.toHaveBeenCalled();
    expect(session.pending().count).toBe(0);
  });

  it("decrements finite occurrences only after successful, distinct wake delivery", async () => {
    let call!: BqInvocation;
    const onWake = vi.fn().mockImplementationOnce(() => { throw new Error("delivery failed"); });
    const session = await start({ onWake, runBq: async (invocation) => { call = invocation; return ok(); } });
    await session.submit({ reentryPrompt: "Check each occurrence", timing: { in: "1m", every: "1m", count: 3 } }, tmpdir());
    expect(session.pending().count).toBe(3);
    const first = frame(call);
    expect(await callback(call, first)).toBe(false);
    expect(session.pending().count).toBe(3);
    expect(await callback(call, first)).toBe(true);
    expect(session.pending().count).toBe(2);
    expect(await callback(call, first)).toBe(false);
    expect(session.pending().count).toBe(2);
    expect(await callback(call, { ...frame(call), capability: "x".repeat(43) })).toBe(false);
    expect(session.pending().count).toBe(2);
    expect(await callback(call)).toBe(true);
    expect(session.pending().count).toBe(1);
    expect(await callback(call)).toBe(true);
    expect(session.pending().count).toBe(0);
  });

  it("retains partial cancellation but releases keepalive after full confirmed cancellation", async () => {
    let call!: BqInvocation;
    const disabled: string[] = [];
    const session = await start({ onWake: () => {}, runBq: async (invocation) => {
      if (invocation.command === "bq") {
        call = invocation;
        return ok({ stdout: "bq: scheduled 1/2 at=... one\nbq: scheduled 2/2 at=... two\n" });
      }
      disabled.push(invocation.args[2]);
      return ok(invocation.args[2] === "two" && disabled.length === 2 ? { code: 1 } : {});
    } });
    const result = await session.submit({ reentryPrompt: "Check", timing: { in: "1m", every: "1m", count: 2 } }, tmpdir());
    expect(await session.cancel(result.submissionId, tmpdir())).toMatchObject({ confirmed: false, disabled: 1, pendingCallbacksUnknown: true });
    expect(session.pending().count).toBe(2);
    expect(await session.cancel(result.submissionId, tmpdir())).toMatchObject({ confirmed: true, disabled: 1, pendingCallbacksUnknown: true });
    expect(disabled).toEqual(["one", "two", "two"]);
    expect(session.pending().count).toBe(0);
    const late = frame(call);
    expect(await callback(call, late)).toBe(true);
    expect(await callback(call, late)).toBe(false);
    await callback(call);
    expect(session.pending().count).toBe(0);
    expect(await session.cancel(result.submissionId, tmpdir())).toMatchObject({ confirmed: true, pendingCallbacksUnknown: false });
  });

  it("keeps cron pending across callbacks but stops waiting after full disable", async () => {
    let call!: BqInvocation;
    const session = await start({ onWake: () => {}, runBq: async (invocation) => {
      if (invocation.command === "bq") call = invocation;
      return ok({ stdout: "bq: scheduled cron-id cron='* * * * *'\n" });
    } });
    const result = await session.submit({ reentryPrompt: "Check cron", timing: { cron: "* * * * *" } }, tmpdir());
    await callback(call);
    await callback(call);
    expect(session.pending().count).toBe(1);
    expect(await session.cancel(result.submissionId, tmpdir())).toMatchObject({ confirmed: true, pendingCallbacksUnknown: true });
    expect(session.pending().count).toBe(0);
    await callback(call);
    expect(session.pending().count).toBe(0);
    await session.close();
    expect(session.pending()).toEqual({ count: 0, pendingIds: [], omitted: 0 });
  });

  it("bounds IDs, snapshots independently, and advances the oldest pending timestamp", async () => {
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now++);
    const calls: BqInvocation[] = [];
    const session = await start({ onWake: () => {}, runBq: async (call) => { calls.push(call); return ok(); } });
    for (let i = 0; i < 12; i++) await session.submit({ reentryPrompt: "never publish this" }, tmpdir());
    const pending = session.pending();
    expect(pending).toMatchObject({ count: 12, omitted: 2, oldestPendingAt: 1000 });
    expect(pending.pendingIds).toHaveLength(10);
    expect(JSON.stringify(pending)).not.toMatch(/never publish|capability|wake.sock/);
    pending.pendingIds.length = 0;
    expect(session.pending().pendingIds).toHaveLength(10);
    await callback(calls[0]);
    expect(session.pending()).toMatchObject({ count: 11, omitted: 1, oldestPendingAt: 1001 });
  });
});
