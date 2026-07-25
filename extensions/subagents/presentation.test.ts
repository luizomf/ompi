import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { Pong, SubagentView } from "./controller.ts";
import subagentsExtension, { buildActiveUi, buildPongMessage } from "./index.ts";

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

describe("subagent tool guidance", () => {
  it("tells the orchestrator to release its turn instead of waiting or polling", () => {
    const tools: Array<{ name: string; description: string; promptGuidelines?: string[] }> = [];
    const pi = {
      registerTool: (tool: { name: string; description: string; promptGuidelines?: string[] }) => tools.push(tool),
      registerCommand: () => undefined,
      on: () => undefined,
      getThinkingLevel: () => "medium",
      sendMessage: () => undefined,
    } as unknown as ExtensionAPI;

    subagentsExtension(pi);

    const guidance = tools.flatMap((tool) => tool.promptGuidelines ?? []).join(" ");
    expect(guidance).toContain("never wait, sleep, or poll");
    expect(guidance).toContain("end the response");
    expect(guidance).toContain("subagent_list");
  });
});

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
