import { describe, expect, it } from "vitest";
import type { Pong, SubagentView } from "./controller.ts";
import { buildActiveUi, buildPongMessage } from "./index.ts";

function view(overrides: Partial<SubagentView>): SubagentView {
  return {
    id: 1,
    state: "running",
    active: true,
    startedAt: 1_000,
    cwd: "/repo",
    model: "provider/model",
    thinking: "medium",
    ...overrides,
  };
}

describe("subagent presentation", () => {
  it("shows only active work and the minimal concurrent footer count", () => {
    const presentation = buildActiveUi([
      view({ id: 1, name: "reader", currentTool: "read", preview: "visible progress" }),
      view({ id: 2, state: "finalizing" }),
      view({ id: 3, active: false, state: "completed" }),
    ], 4_500);

    expect(presentation.status).toBe("subagents: 2");
    expect(presentation.lines).toHaveLength(2);
    expect(presentation.lines?.[0]).toContain("#1 reader · running · 3s · read · visible progress");
    expect(presentation.lines?.join(" ")).not.toContain("#3");
    expect(buildActiveUi([view({ active: false, state: "completed" })], 5_000)).toEqual({});
  });

  it("bounds final assistant text and marks truncation", () => {
    const pong: Pong = {
      id: 7,
      outcome: "completed",
      sessionRef: "/sessions/7.jsonl",
      finalText: "x".repeat(8_050),
    };
    const message = buildPongMessage(pong);

    expect(message.details.finalText).toHaveLength(8_000);
    expect(message.details.truncated).toBe(true);
    expect(message.content).toContain("truncated to 8,000 characters");
    expect(message.content).toContain("/sessions/7.jsonl");
  });
});
