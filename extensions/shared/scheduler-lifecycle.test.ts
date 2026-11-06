import { describe, expect, it } from "vitest";
import { encodeSchedulerPending, parseSchedulerPending, SCHEDULER_STATUS_KEY } from "./scheduler-lifecycle.ts";

const id = "00000000-0000-4000-8000-000000000000";
const ids = (count: number) => Array.from({ length: count }, (_, i) =>
  `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);

describe("scheduler pending status", () => {
  it("round-trips bounded local callback facts", () => {
    expect(SCHEDULER_STATUS_KEY).toBe("ompi:scheduler:pending-v1");
    for (const state of [
      { count: 0, pendingIds: [], omitted: 0 },
      { count: 24, oldestPendingAt: 1000, pendingIds: [id], omitted: 0 },
      { count: 11, pendingIds: ids(10), omitted: 1 },
    ]) {
      const wire = encodeSchedulerPending(state);
      expect(JSON.parse(wire)).toEqual({ version: 1, ...state });
      expect(parseSchedulerPending(wire)).toEqual(state);
    }
  });

  it.each([
    null, [], {}, { count: "1", pendingIds: [id], omitted: 0 },
    { count: -1, pendingIds: [], omitted: 0 },
    { count: 0.5, pendingIds: [], omitted: 0 },
    { count: Number.MAX_SAFE_INTEGER + 1, pendingIds: [], omitted: 0 },
    { count: 0, pendingIds: [id], omitted: 0 },
    { count: 1, pendingIds: [], omitted: 0 },
    { count: 0, pendingIds: [], omitted: 0, oldestPendingAt: 1 },
    { count: 1, pendingIds: [id], omitted: 0, oldestPendingAt: -1 },
    { count: 1, pendingIds: [id], omitted: 0, oldestPendingAt: 1.1 },
    { count: 1, pendingIds: [id], omitted: 0, prompt: "private" },
    { count: 1, pendingIds: [id], omitted: -1 },
    { count: 1, pendingIds: [id], omitted: 1 },
    { count: 2, pendingIds: [id, id], omitted: 0 },
    { count: 1, pendingIds: ["x".repeat(201)], omitted: 0 },
    { count: 1, pendingIds: ["private prompt\n"], omitted: 0 },
    { count: 1, pendingIds: ["submission-1"], omitted: 0 },
    { count: 1, pendingIds: [id.replace("4000", "1000")], omitted: 0 },
    { count: 11, pendingIds: ids(11), omitted: 0 },
    { count: 1, pendingIds: new Array(1), omitted: 0 },
  ])("rejects malformed or unbounded state: %j", (state) => {
    expect(parseSchedulerPending(JSON.stringify({ version: 1, ...state }))).toBeUndefined();
    expect(() => encodeSchedulerPending(state as never)).toThrow();
  });

  it("rejects non-string, malformed, and oversized frames before decoding", () => {
    for (const text of [undefined, {}, "{", " ".repeat(4097),
      JSON.stringify({ count: 0, pendingIds: [], omitted: 0 }),
      JSON.stringify({ version: 2, count: 0, pendingIds: [], omitted: 0 }),
    ]) {
      expect(parseSchedulerPending(text)).toBeUndefined();
    }
  });
});
