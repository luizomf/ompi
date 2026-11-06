export const SCHEDULER_STATUS_KEY = "ompi:scheduler:pending-v1";
const MAX_STATUS_BYTES = 4_096;
const MAX_PENDING_IDS = 10;
const SUBMISSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Local unresolved occurrences, not Queue state or proof of wake delivery. */
export type SchedulerPending = {
  count: number;
  oldestPendingAt?: number;
  /** Unique submission IDs; one submission can own multiple occurrences. */
  pendingIds: string[];
  /** Pending submission IDs omitted from the bounded preview (not occurrences). */
  omitted: number;
};

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function valid(value: unknown): value is SchedulerPending {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  if (Object.keys(state).some((key) => !["count", "oldestPendingAt", "pendingIds", "omitted"].includes(key))
    || !nonnegativeInteger(state.count) || !nonnegativeInteger(state.omitted)
    || !Array.isArray(state.pendingIds) || state.pendingIds.length > MAX_PENDING_IDS
    || Array.from(state.pendingIds).some((id) => typeof id !== "string" || !SUBMISSION_ID.test(id))
    || new Set(state.pendingIds).size !== state.pendingIds.length
    || state.pendingIds.length + state.omitted > state.count) return false;
  if ("oldestPendingAt" in state && !nonnegativeInteger(state.oldestPendingAt)) return false;
  if (state.count === 0) return !("oldestPendingAt" in state);
  return state.pendingIds.length > 0;
}

export function encodeSchedulerPending(state: SchedulerPending): string {
  if (!valid(state)) throw new Error("Invalid scheduler pending status.");
  return JSON.stringify({ version: 1, ...state });
}

/** Invalid/absent status is not equivalent to a confirmed zero-pending status. */
export function parseSchedulerPending(text: unknown): SchedulerPending | undefined {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_STATUS_BYTES) return undefined;
  try {
    const frame: unknown = JSON.parse(text);
    if (typeof frame !== "object" || frame === null || Array.isArray(frame)) return undefined;
    const { version, ...state } = frame as Record<string, unknown>;
    return version === 1 && valid(state) ? state : undefined;
  } catch {
    return undefined;
  }
}
