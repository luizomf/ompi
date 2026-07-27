import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import {
  SchedulerSession,
  type BqInvocation,
  type BqProcessResult,
  type SchedulerPayloadOutcome,
  type SchedulerStreamPreview,
  type SchedulerSubmissionResult,
  type SchedulerWake,
} from "./scheduler.ts";

const MAX_REENTRY_PROMPT_CHARACTERS = 8_000;
const MAX_ARGUMENT_CHARACTERS = 8_000;
const MAX_PAYLOAD_ARGUMENTS = 128;
const MAX_TIMING_CHARACTERS = 1_024;

const TimingValue = Type.String({ minLength: 1, maxLength: MAX_TIMING_CHARACTERS });
const TimingSchema = Type.Object({
  in: Type.Optional(TimingValue),
  at: Type.Optional(TimingValue),
  cron: Type.Optional(TimingValue),
  tz: Type.Optional(TimingValue),
  every: Type.Optional(TimingValue),
  count: Type.Optional(Type.Integer()),
}, { additionalProperties: false });
const PayloadSchema = Type.Object({
  executable: Type.String({ minLength: 1, maxLength: MAX_ARGUMENT_CHARACTERS }),
  args: Type.Optional(Type.Array(
    Type.String({ maxLength: MAX_ARGUMENT_CHARACTERS }),
    { maxItems: MAX_PAYLOAD_ARGUMENTS },
  )),
  cwd: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_ARGUMENT_CHARACTERS })),
}, { additionalProperties: false });
const SubmitSchema = Type.Object({
  reentryPrompt: Type.String({
    minLength: 1,
    maxLength: MAX_REENTRY_PROMPT_CHARACTERS,
    description: "Required self-contained prompt that explains the deferred context, completed event, checks to perform, constraints, and next decision.",
  }),
  timing: Type.Optional(TimingSchema),
  payload: Type.Optional(PayloadSchema),
}, { additionalProperties: false });

type SubmitParams = Static<typeof SubmitSchema>;

export interface SchedulerExtensionOptions {
  runBq?: (invocation: BqInvocation) => Promise<BqProcessResult>;
}

function outcomeText(outcome: SchedulerPayloadOutcome): string {
  switch (outcome.kind) {
    case "heartbeat":
      return "heartbeat delivered (no payload command)";
    case "exit":
      return `payload exited with code ${outcome.code}`;
    case "signal":
      return `payload terminated by signal ${outcome.signal}`;
    case "start_error":
      return `payload could not start: ${outcome.message}`;
  }
}

function previewText(name: "stdout" | "stderr", value: SchedulerStreamPreview): string | undefined {
  if (!value.preview && !value.truncated) return undefined;
  const bytes = Buffer.byteLength(value.preview, "utf8");
  const notice = value.truncated ? ` (${bytes.toLocaleString("en-US")} byte preview; truncated)` : "";
  return `${name}${notice}:\n${value.preview}`;
}

export function formatSchedulerWake(wake: SchedulerWake): string {
  const parts = [
    "[SCHEDULER WAKE]",
    `Reentry prompt (complete):\n${wake.reentryPrompt}`,
    `Mechanical payload outcome (not an official OMQueue Job state): ${outcomeText(wake.outcome)}`,
  ];
  const stdout = previewText("stdout", wake.stdout);
  const stderr = previewText("stderr", wake.stderr);
  if (stdout) parts.push(stdout);
  if (stderr) parts.push(stderr);
  return parts.join("\n\n");
}

function bqStatus(result: BqProcessResult): string {
  if (result.cancelled) return "cancelled before bq finished reporting acceptance";
  if (result.code !== null) return `exit code: ${result.code}`;
  return `signal: ${result.signal ?? "unknown"}`;
}

function streamSection(name: "stdout" | "stderr", value: string, truncated: boolean): string {
  const notice = truncated ? " (truncated to the scheduler adapter limit)" : "";
  return `${name}${notice}:\n${value}`;
}

export function formatSchedulerSubmission(result: SchedulerSubmissionResult): string {
  const heading = result.accepted
    ? `Scheduler submission accepted by bq (${bqStatus(result.bq)}).`
    : `Scheduler submission was not accepted by bq (${bqStatus(result.bq)}).`;
  return [
    heading,
    streamSection("stdout", result.bq.stdout, result.bq.stdoutTruncated),
    streamSection("stderr", result.bq.stderr, result.bq.stderrTruncated),
    result.accepted
      ? "Never wait, poll, or watch Queue completion. Continue only independent work or end this response; the scheduler wake will arrive later if the live owning session is reachable."
      : "No acceptance is claimed. Correct the reported submission problem before trying again.",
  ].join("\n\n");
}

export function registerSchedulerExtension(
  pi: ExtensionAPI,
  options: SchedulerExtensionOptions = {},
): void {
  let session: SchedulerSession | undefined;

  pi.registerTool({
    name: "scheduler_submit",
    label: "Submit Scheduler Wake",
    description: "Submit an immediate, delayed, absolute-time, finite-repeat, or cron scheduler wake through the existing global bq wrapper. Use for scheduler, cron, heartbeat, reminder, delayed command, or deferred recheck requests. Returns after bounded bq acceptance output and never waits for Queue completion. A complete reentryPrompt is required; an optional executable and literal argument vector run without a shell before the wake. Raw bq invocation or inspection remains ordinary bash work.",
    promptSnippet: "Submit a fire-and-forget scheduler, cron, heartbeat, reminder, delayed command, or deferred recheck wake",
    promptGuidelines: [
      "Use scheduler_submit only for fire-and-forget scheduler wakes; always provide a complete self-contained reentryPrompt that preserves deferred context, required checks, constraints, and the next decision.",
      "After scheduler_submit reports bq acceptance, never wait, sleep, poll, inspect OMQueue, or watch Queue completion; continue only independent work or end the response so a later scheduler wake can be delivered.",
      "When the user explicitly asks to invoke or inspect raw bq behavior, use ordinary bash instead of scheduler_submit.",
    ],
    parameters: SubmitSchema,
    async execute(_toolCallId, params: SubmitParams, signal, _onUpdate, ctx) {
      if (!session) throw new Error("Scheduler callback endpoint is unavailable; this Pi session has not started.");
      const result = await session.submit(params, ctx.cwd, signal);
      return {
        content: [{ type: "text", text: formatSchedulerSubmission(result) }],
        details: result,
      };
    },
  });

  pi.on("session_start", async () => {
    const previous = session;
    session = undefined;
    await previous?.close();
    session = await SchedulerSession.start({
      runBq: options.runBq,
      onWake: (wake) => {
        pi.sendMessage({
          customType: "scheduler-wake",
          content: formatSchedulerWake(wake),
          display: true,
          details: wake,
        }, { deliverAs: "followUp", triggerTurn: true });
      },
    });
  });

  pi.on("session_shutdown", async () => {
    const closing = session;
    session = undefined;
    await closing?.close();
  });
}

export default function schedulerExtension(pi: ExtensionAPI): void {
  registerSchedulerExtension(pi);
}
