import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

const processMock = vi.hoisted(() => ({
  run: vi.fn(),
}));

vi.mock("./process.ts", () => ({
  runCodexSearch: processMock.run,
}));

import codexSearchExtension from "./index.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function setup() {
  const tools = new Map<string, any>();
  const messages: Array<{ message: any; options: any }> = [];
  const pi = {
    registerTool: (tool: { name: string }) => tools.set(tool.name, tool),
    registerMessageRenderer: () => undefined,
    registerCommand: () => undefined,
    sendMessage: (message: unknown, options: unknown) => messages.push({ message, options }),
    on: () => undefined,
  } as unknown as ExtensionAPI;
  codexSearchExtension(pi);
  return { tools, messages };
}

describe("codex_search background delivery", () => {
  beforeEach(() => processMock.run.mockReset());

  it("releases the tool call before research completes and delivers the bounded result later", async () => {
    const search = deferred<{
      stdout: string;
      stderr: string;
      code: number;
      stdoutTruncated: boolean;
      stderrTruncated: boolean;
    }>();
    processMock.run.mockReturnValue(search.promise);
    const { tools, messages } = setup();
    const tool = tools.get("codex_search");

    const accepted = await tool.execute(
      "search-1",
      { query: "find Bash sources" },
      undefined,
      undefined,
      { cwd: "/repo" } as ExtensionContext,
    );

    expect(accepted.content[0].text).toContain("Background task #1");
    expect(messages).toEqual([]);
    expect(tool.description).toContain("asynchronously");
    expect(tool.promptGuidelines.join(" ")).toContain("never wait");

    search.resolve({
      stdout: "primary research",
      stderr: "",
      code: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
    });
    await vi.waitFor(() => expect(messages).toHaveLength(1));

    expect(messages[0].message.content).toContain("primary research");
    expect(messages[0].message.content).toContain("not a verified primary source");
    expect(messages[0].message.details).toMatchObject({
      toolName: "codex_search",
      outcome: "completed",
    });
  });
});
