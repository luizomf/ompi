import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SchedulerSession, type BqInvocation, type BqProcessResult } from "./scheduler.ts";

const sessions: SchedulerSession[] = [];
const homes: string[] = [];
const ok = (stdout = "", overrides: Partial<BqProcessResult> = {}): BqProcessResult => ({
  code: 0, signal: null, stdout, stderr: "", stdoutTruncated: false,
  stderrTruncated: false, cancelled: false, ...overrides,
});
async function setup(runBq: (invocation: BqInvocation) => Promise<BqProcessResult>, configured = true) {
  const home = await mkdtemp(join(tmpdir(), "ompi-reminders-"));
  homes.push(home);
  if (configured) {
    await mkdir(join(home, ".config/bq"), { recursive: true });
    await writeFile(join(home, ".config/bq/config.json"), "{}");
  }
  const session = await SchedulerSession.start({
    onWake: () => {}, runBq,
    environment: { HOME: home, BQ_OMQUEUE: "/synthetic/omqueue", XDG_STATE_HOME: "/synthetic/state" },
  });
  sessions.push(session);
  return { session, home };
}
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("human reminders and session-owned cancellation", () => {
  it("creates exactly 24 anchored hourly reminders preserving the prompt and one cancellation handle", async () => {
    const calls: BqInvocation[] = [];
    const { session, home } = await setup(async (call) => {
      calls.push(call);
      return ok(`bq: scheduled schedule-${calls.length} at=2030-01-01T00:00:00Z\n`);
    });
    const prompt = '  literal $(echo nope)\n/schedule "ação"  ';
    const before = Date.now();
    const result = await session.scheduleReminders(prompt, home);
    expect(result).toMatchObject({ complete: true, accepted: 24 });
    expect(calls).toHaveLength(24);
    const at = calls.map((call) => Date.parse(call.args[call.args.indexOf("--at") + 1]));
    expect(at[0]).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(at[0]).toBeLessThanOrEqual(Date.now() + 3_660_000);
    calls.forEach((call, index) => {
      expect(at[index]).toBe(at[0] + index * 3_600_000);
      const text = Buffer.from(call.args[call.args.indexOf("--prompt-base64") + 1], "base64url").toString();
      expect(text).toBe(`${prompt}\n\n[Reminder ${index + 1}/24] If you think the task is complete, cancel this schedule using scheduler_cancel({ id: "${result.id}" }). If cancellation is unavailable or fails, reply only OK.`);
      expect(call.command).toBe("bq");
      expect(call.args).not.toContain("--every");
    });
    calls.length = 0;
    expect(await session.cancel(result.id, home)).toMatchObject({ confirmed: true, disabled: 24, remaining: 0 });
    expect(calls).toHaveLength(24);
    expect(session.list()).toEqual([expect.objectContaining({
      id: result.id,
      cancellation: { knownNotDisabled: 0, disabled: 24, coverageComplete: true, creating: false, lastAttemptConfirmed: true },
    })]);
    calls.forEach((call, index) => {
      expect(call.command).toBe("/synthetic/omqueue");
      expect(call.args).toEqual(["schedule", "disable", `schedule-${index + 1}`, "--json"]);
      expect(call.env.XDG_STATE_HOME).toBe("/synthetic/state");
    });
    calls.length = 0;
    expect(await session.cancel(result.id, home)).toMatchObject({ confirmed: true, disabled: 0 });
    expect(calls).toEqual([]);
  });

  it("lists local submission facts without consulting Queue or exposing callback credentials", async () => {
    let calls = 0;
    const { session, home } = await setup(async () => {
      calls++;
      return ok("bq: scheduled cron-id cron='0 9 * * 1-5'\n");
    });
    expect(session.list()).toEqual([]);
    const timing = { cron: "0 9 * * 1-5", tz: "America/Sao_Paulo" };
    const result = await session.submit({ reentryPrompt: "Check the report", timing }, home);
    timing.cron = "changed";
    expect(session.list()).toEqual([expect.objectContaining({
      id: result.submissionId, kind: "heartbeat", promptPreview: "Check the report",
      timing: { cron: "0 9 * * 1-5", tz: "America/Sao_Paulo" },
      acceptance: "confirmed", acceptedSubmissions: 1,
    })]);
    session.list()[0].timing!.cron = "mutated snapshot";
    expect(session.list()[0].timing?.cron).toBe("0 9 * * 1-5");
    expect(JSON.stringify(session.list())).not.toMatch(/capability|wake.sock|prompt-base64/);
    expect(calls).toBe(1);
    await session.close();
    expect(session.list()).toEqual([]);
  });

  it("shows in-flight and unknown acceptance without inventing cancellation coverage", async () => {
    let release!: (result: BqProcessResult) => void;
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    const { session, home } = await setup(async () => {
      started();
      return new Promise<BqProcessResult>((resolve) => { release = resolve; });
    });
    const submission = session.submit({ reentryPrompt: "Check later", timing: { in: "2h" } }, home);
    await running;
    expect(session.list()[0]).toMatchObject({ acceptance: "submitting", acceptedSubmissions: 0, callbacks: 0 });
    release(ok("", { code: 1 }));
    await submission;
    expect(session.list()[0]).toMatchObject({
      acceptance: "unknown", acceptedSubmissions: 0,
      cancellation: { knownNotDisabled: 0, coverageComplete: false },
    });
    const failed = await setup(async () => { throw new Error("synthetic start error"); });
    await expect(failed.session.submit({ reentryPrompt: "Check" }, failed.home)).rejects.toThrow("synthetic start error");
    expect(failed.session.list()[0]).toMatchObject({ acceptance: "unknown", acceptedSubmissions: 0 });
    expect(failed.session.list()[0].cancellation).toBeUndefined();
  });

  it("keeps reminders grouped with anchored recurrence and partial cancellation facts", async () => {
    let submitted = 0;
    let commands = 0;
    let first: BqInvocation | undefined;
    const { session, home } = await setup(async (call) => {
      commands++;
      if (call.command !== "bq") return call.args[2] === "schedule-2" ? ok("", { code: 1 }) : ok();
      first ??= call;
      return ok(`bq: scheduled schedule-${++submitted} at=...\n`);
    });
    const result = await session.scheduleReminders("Review progress", home);
    expect(session.list()).toEqual([expect.objectContaining({
      id: result.id, kind: "reminders", acceptance: "confirmed", acceptedSubmissions: 24,
      timing: { at: expect.any(String), every: "1h", count: 24 },
      cancellation: { knownNotDisabled: 24, disabled: 0, coverageComplete: true, creating: false },
    })]);
    const separator = first!.args.indexOf("--");
    await promisify(execFile)(first!.args[separator + 1], first!.args.slice(separator + 2), { env: first!.env });
    expect(session.list()).toEqual([expect.objectContaining({
      id: result.id, callbacks: 1, lastOutcome: { kind: "heartbeat" },
      cancellation: expect.objectContaining({ knownNotDisabled: 24 }),
    })]);
    await session.cancel(result.id, home);
    expect(session.list()[0].cancellation).toEqual({
      knownNotDisabled: 1, disabled: 23, coverageComplete: true, creating: false,
      lastAttemptConfirmed: false,
    });
    expect(commands).toBe(48);
  });

  it.each([
    ["bq: scheduled one at=2030-01-01T00:00:00Z\n", { in: "1h" }, ["one"]],
    ["bq: scheduled 1/2 at=... one\nbq: scheduled 2/2 at=... two\nbq: scheduled all 2 one-time runs\n", { in: "1h", every: "1h", count: 2 }, ["one", "two"]],
    ["bq: scheduled cron-id cron='0 * * * *' timeZone=UTC\n", { cron: "0 * * * *" }, ["cron-id"]],
  ] as const)("cancels scheduler_submit receipts: %s", async (stdout, timing, ids) => {
    const calls: BqInvocation[] = [];
    const { session, home } = await setup(async (call) => { calls.push(call); return ok(stdout); });
    const result = await session.submit({ reentryPrompt: "Check", timing }, home);
    expect(result.cancellation).toMatchObject({ id: result.submissionId, complete: true });
    expect(session.list()[0].timing).toEqual(timing);
    calls.length = 0;
    expect(await session.cancel(result.submissionId, home)).toMatchObject({ confirmed: true, disabled: ids.length });
    expect(calls.map((call) => call.args[2])).toEqual(ids);
  });

  it("retains partial creation IDs including enable failure and never claims complete coverage", async () => {
    let created = 0;
    const disabled: string[] = [];
    const { session, home } = await setup(async (call) => {
      if (call.command !== "bq") { disabled.push(call.args[2]); return ok(); }
      created++;
      return created === 1 ? ok("bq: scheduled first at=...\n") : ok("", {
        code: 1, stderr: "bq: Schedule second was created but could not be enabled\n",
      });
    });
    const result = await session.scheduleReminders("check", home);
    expect(result).toMatchObject({ complete: false, accepted: 1 });
    expect(session.list()).toEqual([expect.objectContaining({
      id: result.id, kind: "reminders", acceptance: "unknown", acceptedSubmissions: 1,
      cancellation: { knownNotDisabled: 2, disabled: 0, coverageComplete: false, creating: false },
    })]);
    expect(created).toBe(2);
    expect(await session.cancel(result.id, home)).toMatchObject({ confirmed: false, disabled: 2, coverageComplete: false });
    expect(disabled).toEqual(["first", "second"]);
  });

  it("reports disable failures, retains only failed IDs, and does not automatically retry", async () => {
    const calls: string[] = [];
    const { session, home } = await setup(async (call) => {
      if (call.command === "bq") return ok("bq: scheduled 1/2 at=... one\nbq: scheduled 2/2 at=... two\n");
      calls.push(call.args[2]);
      return call.args[2] === "one" ? ok() : ok("", { code: 1, stderr: "disable rejected" });
    });
    const result = await session.submit({ reentryPrompt: "check", timing: { in: "1h", every: "1h", count: 2 } }, home);
    const cancellation = await session.cancel(result.submissionId, home);
    expect(cancellation).toMatchObject({ confirmed: false, disabled: 1, remaining: 1 });
    expect(cancellation.errors.join()).toContain("disable rejected");
    expect(calls).toEqual(["one", "two"]);
    expect(session.list()[0].cancellation).toMatchObject({ disabled: 1, knownNotDisabled: 1, lastAttemptConfirmed: false });
  });

  it("rejects foreign IDs and closed sessions without Queue operations", async () => {
    let calls = 0;
    const { session, home } = await setup(async () => { calls++; return ok("bq: scheduled one at=...\n"); });
    const result = await session.submit({ reentryPrompt: "check", timing: { in: "1h" } }, home);
    const other = await setup(async () => { throw new Error("must not run"); });
    await expect(other.session.cancel(result.submissionId, home)).rejects.toThrow("Unknown cancellation ID");
    await session.close();
    await expect(session.cancel(result.submissionId, home)).rejects.toThrow("closed");
    expect(calls).toBe(1);
  });

  it("rejects empty, oversized and local-fallback reminders before any submission", async () => {
    const { session, home } = await setup(async () => { throw new Error("must not run"); }, false);
    await expect(session.scheduleReminders(" ", home)).rejects.toThrow("Usage");
    await expect(session.scheduleReminders("x".repeat(8000), home)).rejects.toThrow("8000 UTF-8 bytes");
    await expect(session.scheduleReminders("check", home)).rejects.toThrow("configured OMQueue");
  });

  it("stops creation on a thrown submission failure and preserves earlier cancellation IDs", async () => {
    let attempts = 0;
    const disabled: string[] = [];
    const { session, home } = await setup(async (call) => {
      if (call.command !== "bq") { disabled.push(call.args[2]); return ok(); }
      if (++attempts === 2) throw new Error("synthetic spawn failure");
      return ok("bq: scheduled first at=...\n");
    });
    const result = await session.scheduleReminders("check", home);
    expect(result).toMatchObject({ accepted: 1, complete: false });
    expect(result.error).toContain("synthetic spawn failure");
    expect(session.list()).toEqual([expect.objectContaining({
      id: result.id, acceptance: "unknown", acceptedSubmissions: 1,
    })]);
    await session.cancel(result.id, home);
    expect(disabled).toEqual(["first"]);
    expect(attempts).toBe(2);
  });

  it("stops new submissions when the owning session closes during creation", async () => {
    let calls = 0;
    const { session, home } = await setup(async () => {
      calls++;
      await session.close();
      return ok("bq: scheduled first at=...\n");
    });
    const result = await session.scheduleReminders("check", home);
    expect(result).toMatchObject({ accepted: 1, complete: false });
    expect(calls).toBe(1);
    await expect(session.cancel(result.id, home)).rejects.toThrow("closed");
    expect(session.list()).toEqual([]);
  });

  it("does not start disable commands after an abort", async () => {
    let calls = 0;
    const { session, home } = await setup(async () => { calls++; return ok("bq: scheduled first at=...\n"); });
    const result = await session.submit({ reentryPrompt: "check", timing: { in: "1h" } }, home);
    const controller = new AbortController();
    controller.abort();
    expect(await session.cancel(result.submissionId, home, controller.signal)).toMatchObject({ confirmed: false, disabled: 0, remaining: 1 });
    expect(calls).toBe(1);
  });

  it("does not claim cancellation coverage when receipts are truncated or absent", async () => {
    const { session, home } = await setup(async () => ok("bq: scheduled one at=...\n", { stdoutTruncated: true }));
    const result = await session.submit({ reentryPrompt: "check", timing: { in: "1h" } }, home);
    expect(result.cancellation?.complete).toBe(false);
    expect(session.list()[0]).toMatchObject({ acceptance: "confirmed", cancellation: { coverageComplete: false } });
    expect((await session.cancel(result.submissionId, home)).confirmed).toBe(false);
  });
});
