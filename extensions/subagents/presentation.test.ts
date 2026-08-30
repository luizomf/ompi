import { initTheme, type ExtensionAPI, type MessageRenderer } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { SubagentView, TerminalResult } from "./controller.ts";
import subagentsExtension, { buildActiveUi, buildDirectResult, buildPongMessage } from "./index.ts";

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
      registerMessageRenderer: () => undefined,
      on: () => undefined,
      getThinkingLevel: () => "medium",
      sendMessage: () => undefined,
    } as unknown as ExtensionAPI;

    subagentsExtension(pi);

    const guidance = tools.flatMap((tool) => tool.promptGuidelines ?? []).join(" ");
    expect(guidance).toContain("never wait, sleep, or poll");
    expect(guidance).toContain("end the response");
    expect(guidance).toMatch(/independent delegations.*same turn.*concurrently.*do not wait/s);
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
    expect(presentation.lines?.[0]).toContain("#1 reader · running · 3s · provider/model · reasoning medium · read · visible progress");
    expect(presentation.lines?.join(" ")).not.toContain("#3");
    expect(buildActiveUi([view({ active: false, state: "completed" })], 5_000)).toEqual({});
  });

  it("collapses final assistant text behind Pi's native expansion state", () => {
    initTheme(undefined, false);
    let renderer: MessageRenderer | undefined;
    const pi = {
      registerTool: () => undefined,
      registerCommand: () => undefined,
      registerMessageRenderer: (customType: string, candidate: MessageRenderer) => {
        if (customType === "subagent-pong") renderer = candidate;
      },
      on: () => undefined,
      getThinkingLevel: () => "medium",
      sendMessage: () => undefined,
    } as unknown as ExtensionAPI;

    subagentsExtension(pi);
    expect(renderer).toBeDefined();
    if (!renderer) throw new Error("subagent-pong renderer was not registered");
    const registeredRenderer = renderer;

    const marker = "FULL SUBAGENT RESULT";
    const message = buildPongMessage({
      id: 7,
      name: "reader",
      outcome: "completed",
      sessionRef: "/sessions/7.jsonl",
      finalText: marker,
    });
    const theme = {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
    };
    const render = (expanded: boolean) => {
      const component = registeredRenderer(
        {
          role: "custom",
          customType: "subagent-pong",
          content: message.content,
          display: true,
          details: message.details,
          timestamp: 1,
        },
        { expanded },
        theme as never,
      );
      if (!component) throw new Error("subagent-pong renderer returned no component");
      return component.render(120).join("\n");
    };

    const collapsed = render(false);
    expect(collapsed).toContain("[PONG subagent #7 reader] completed");
    expect(collapsed).toContain("to expand");
    expect(collapsed).not.toContain(marker);
    expect(render(true)).toContain(marker);
    expect(message.content).toContain(marker);
  });

  it("bounds final assistant text and marks truncation", () => {
    const pong: TerminalResult = {
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

  it("keeps the native session reference in bounded direct failure and interruption results", () => {
    for (const outcome of ["failed", "interrupted"] as const) {
      const message = buildDirectResult({
        id: 9,
        outcome,
        sessionRef: "/sessions/recover.jsonl",
        finalText: "x".repeat(8_050),
        error: outcome === "failed" ? "provider failed" : undefined,
      });

      expect(message.content).toContain(`[SUBAGENT #9] ${outcome}`);
      expect(message.content).toContain("/sessions/recover.jsonl");
      expect(message.details).toMatchObject({
        outcome,
        sessionRef: "/sessions/recover.jsonl",
        truncated: true,
      });
    }
  });
});
