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
    expect(tool.parameters.properties.effort.anyOf.map((item: { const: string }) => item.const)).toEqual([
      "quick",
      "research",
    ]);
    expect(tool.parameters.properties.effort.description).toMatch(/helper owns.*default model and reasoning/i);
    expect(tool.parameters.properties).not.toHaveProperty("model");
    expect(tool.parameters.properties).not.toHaveProperty("reasoning");
    expect(tool.parameters.properties).toHaveProperty("write");
    expect(tool.parameters.properties).toHaveProperty("yolo");
    expect(processMock.run).toHaveBeenCalledWith(
      "find Bash sources",
      "/repo",
      "quick",
      { write: undefined, yolo: undefined },
      expect.any(AbortSignal),
    );
    const guidance = tool.promptGuidelines.join(" ");
    expect(guidance).toContain("never wait");
    expect(guidance).toMatch(/independently useful.*same turn.*concurrently.*do not wait/s);
    expect(guidance).not.toMatch(/MUST inform the user/i);

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

  it("generates images through the research profile without adding research-verification reminders", async () => {
    processMock.run.mockResolvedValueOnce({
      stdout: "Saved final image to /repo/output.png",
      stderr: "",
      code: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
    });
    const { tools, messages } = setup();
    const tool = tools.get("codex_search");

    expect(tool.label).toContain("Image");
    expect(tool.description).toMatch(/image generation.*Codex\/ImageGen/i);
    expect(tool.promptSnippet).toMatch(/image generation/i);
    expect(tool.parameters.properties.image.description).toMatch(/save.*inspect.*iterate/i);
    expect(tool.parameters.properties.query.description).toMatch(/free-form.*without.*template/i);
    expect(tool.promptGuidelines.join(" ")).toMatch(/do not rewrite.*post-processing/i);

    await tool.execute(
      "image-1",
      {
        query: "Generate a cinematic 16:9 mountain landscape and save the final PNG",
        effort: "quick",
        image: true,
        write: true,
      },
      undefined,
      undefined,
      { cwd: "/repo" } as ExtensionContext,
    );

    expect(processMock.run).toHaveBeenCalledWith(
      "Generate a cinematic 16:9 mountain landscape and save the final PNG",
      "/repo",
      "research",
      { write: true, yolo: undefined },
      expect.any(AbortSignal),
    );
    const guidance = tool.promptGuidelines.join(" ");
    expect(guidance).toMatch(/Codex\/ImageGen generates.*Pi.*deliver/i);
    expect(guidance).toMatch(/workspace-write.*Pi session cwd.*primary workspace/i);
    expect(guidance).toMatch(/never.*yolo.*specific.*authoriz/i);

    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(messages[0].message.content).toContain("Saved final image to /repo/output.png");
    expect(messages[0].message.content).not.toContain("not a verified primary source");
  });

  it("requires an explicit workspace-write opt-in before image generation", async () => {
    const { tools, messages } = setup();
    const tool = tools.get("codex_search");

    await tool.execute(
      "image-2",
      { query: "Generate an icon", image: true },
      undefined,
      undefined,
      { cwd: "/repo" } as ExtensionContext,
    );

    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(processMock.run).not.toHaveBeenCalled();
    expect(messages[0].message.content).toMatch(/requires explicit write: true/i);
  });

  it("passes the research profile and makes failures require user-visible reporting without stopping fallback work", async () => {
    processMock.run.mockRejectedValueOnce(new Error("configured model is unavailable"));
    const { tools, messages } = setup();
    const tool = tools.get("codex_search");

    await tool.execute(
      "search-2",
      {
        query: "synthesize conflicting primary sources",
        effort: "research",
        write: true,
        yolo: true,
      },
      undefined,
      undefined,
      { cwd: "/repo" } as ExtensionContext,
    );
    expect(processMock.run).toHaveBeenCalledWith(
      "synthesize conflicting primary sources",
      "/repo",
      "research",
      { write: true, yolo: true },
      expect.any(AbortSignal),
    );

    await vi.waitFor(() => expect(messages).toHaveLength(1));

    expect(messages[0].message.content).toMatch(/MUST report this codex_search failure in your next user-facing response/i);
    expect(messages[0].message.content).toMatch(/MUST NOT stop or abandon the task solely because codex_search failed.*continue with another appropriate tool when useful or available/is);
    expect(messages[0].message.content).toContain("configured model is unavailable");
    expect(messages[0].message.details).toMatchObject({
      toolName: "codex_search",
      outcome: "failed",
    });
  });
});
