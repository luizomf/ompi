import { truncateHead } from "@earendil-works/pi-coding-agent";
import type { SchedulerRecord } from "./scheduler.ts";

const MAX_LIST_BYTES = 24_000;
const MAX_LIST_LINES = 200;

// Quote supplied text so prompts, timing and diagnostics remain display data.
function quoted(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function recordText(record: SchedulerRecord): string {
  const cancellation = record.cancellation;
  let cancellationText = "Cancellation handle: none recorded";
  if (cancellation) {
    cancellationText = [
      `Cancellation handle: ${record.id}`,
      `known IDs not disabled: ${cancellation.knownNotDisabled}`,
      `disabled: ${cancellation.disabled}`,
      `coverage: ${cancellation.coverageComplete ? "complete" : "unknown"}`,
      `creating: ${cancellation.creating}`,
    ].join("; ");
    if (cancellation.lastAttemptConfirmed !== undefined) {
      cancellationText += `; last attempt: ${cancellation.lastAttemptConfirmed ? "confirmed" : "incomplete or unconfirmed"}`;
    }
  }
  return [
    `${record.id} · ${record.kind} · acceptance ${record.acceptance}`,
    `Created: ${record.createdAt}; confirmed submissions: ${record.acceptedSubmissions}`,
    `Prompt preview (data): ${quoted(record.promptPreview)}`,
    `Requested timing: ${record.timing ? quoted(record.timing) : "immediate"}`,
    `Callbacks: ${record.callbacks}${record.lastCallbackAt ? `; last: ${record.lastCallbackAt}; mechanical outcome: ${quoted(record.lastOutcome)}` : " (none observed)"}`,
    cancellationText,
  ].join("\n");
}

export function schedulerSnapshot(records: SchedulerRecord[], offset = 0) {
  const heading = "Session-local scheduler records — not official Queue state. Known IDs may include past occurrences; counts are not pending jobs. No Queue query performed.";
  const lines = [heading];
  let bytes = Buffer.byteLength(heading);
  let lineCount = 1;
  let shown = 0;
  for (const record of records.slice(offset)) {
    const entry = truncateHead(recordText(record), { maxBytes: MAX_LIST_BYTES - 1000, maxLines: MAX_LIST_LINES - 10 });
    const text = entry.content + (entry.truncated ? "\n[Record display truncated.]" : "");
    const size = Buffer.byteLength(text) + 2;
    const count = text.split("\n").length + 1;
    if (bytes + size > MAX_LIST_BYTES || lineCount + count > MAX_LIST_LINES) break;
    lines.push(text);
    bytes += size;
    lineCount += count;
    shown++;
  }
  const nextOffset = offset + shown < records.length ? offset + shown : undefined;
  if (!records.length) lines.push("No scheduler records in this live session.");
  else lines.push(`Showing ${shown} of ${records.length} records (offset ${offset}).`);
  if (nextOffset !== undefined) {
    lines.push(`More records: scheduler_list({ offset: ${nextOffset} }) or /schedulelist ${nextOffset}.`);
  }
  return { text: lines.join("\n\n"), details: { total: records.length, shown, offset, nextOffset } };
}
