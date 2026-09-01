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

  it("routes exact-URL retrieval by required intent and delivers helper/model output later", async () => {
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
      { query: "Fetch and extract https://example.com/source", intent: "exact_url" },
      undefined,
      undefined,
      { cwd: "/repo" } as ExtensionContext,
    );

    expect(accepted.content[0].text).toContain("Background operation #1");
    expect(messages).toEqual([]);
    expect(tool.description).toContain("asynchronously");
    expect(tool.description).toMatch(/completion may arrive later.*owning Pi session remains live/i);
    expect(tool.description).toMatch(/exact-URL retrieval.*Luna.*high.*complex research.*Sol.*high.*image generation.*Sol.*high/is);
    expect(tool.description).toMatch(/every.*unsandboxed/i);
    expect(tool.parameters.properties.intent.anyOf.map((item: { const: string }) => item.const)).toEqual([
      "exact_url",
      "research",
      "image",
    ]);
    expect(tool.parameters.required).toEqual(expect.arrayContaining(["query", "intent"]));
    expect(tool.parameters.properties).toHaveProperty("destination");
    for (const removed of ["effort", "image", "write", "yolo", "model", "reasoning"]) {
      expect(tool.parameters.properties).not.toHaveProperty(removed);
    }
    expect(processMock.run).toHaveBeenCalledWith(
      "Fetch and extract https://example.com/source",
      "/repo",
      "exact_url",
      undefined,
      expect.any(AbortSignal),
    );
    const guidance = tool.promptGuidelines.join(" ");
    expect(guidance).toContain("never wait");
    expect(guidance).toMatch(/later result.*only while the owning Pi session remains live/i);
    expect(guidance).toMatch(/independently useful.*same turn.*concurrently.*do not wait/s);
    expect(guidance).toMatch(/specific URL.*intent: exact_url.*fetch and extract.*exact URL.*related pages/is);
    expect(guidance).toMatch(/markdown\.new.*r\.jina\.ai/is);
    expect(guidance).toMatch(/third-party.*credentials.*signed.*confidential/is);
    expect(guidance).toMatch(/could not access or verify.*must not invent/is);
    expect(guidance).toMatch(/exact_url and research.*do not authorize.*workspace mutation/is);

    search.resolve({
      stdout: "retrieved page text",
      stderr: "",
      code: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
    });
    await vi.waitFor(() => expect(messages).toHaveLength(1));

    expect(messages[0].message.content).toContain("retrieved page text");
    expect(messages[0].message.content).toMatch(/helper\/model-produced exact-URL retrieval output/i);
    expect(messages[0].message.content).toContain("not a verified primary source");
    expect(messages[0].message.details).toMatchObject({
      toolName: "codex_search",
      outcome: "completed",
    });
  });

  it("uses direct image intent as artifact authorization and passes a final destination", async () => {
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
    expect(tool.promptSnippet).toMatch(/image generation/i);
    expect(tool.parameters.properties.destination.description).toMatch(/only with intent: image/i);
    expect(tool.parameters.properties.query.description).toMatch(/free-form image intent/i);
    expect(tool.promptGuidelines.join(" ")).toMatch(/direct intent: image.*authorizes creation/i);

    await tool.execute(
      "image-1",
      {
        query: "Generate a cinematic 16:9 mountain landscape",
        intent: "image",
        destination: "/repo/output.png",
      },
      undefined,
      undefined,
      { cwd: "/repo" } as ExtensionContext,
    );

    expect(processMock.run).toHaveBeenCalledWith(
      "Generate a cinematic 16:9 mountain landscape",
      "/repo",
      "image",
      "/repo/output.png",
      expect.any(AbortSignal),
    );
    const guidance = tool.promptGuidelines.join(" ");
    expect(guidance).toMatch(/free-form intent.*without.*rigid visual template/i);
    expect(guidance).toMatch(/after image generation starts.*do not inspect, move, or modify.*artifact paths/i);

    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(messages[0].message.content).toContain("Saved final image to /repo/output.png");
    expect(messages[0].message.content).toMatch(/destination passed to the helper.*\/repo\/output\.png/i);
    expect(messages[0].message.content).not.toContain("not a verified primary source");
  });

  it("reports image helper output without claiming final placement when destination is absent", async () => {
    processMock.run.mockResolvedValueOnce({
      stdout: "Created a candidate at /tmp/generated-image.png",
      stderr: "",
      code: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
    });
    const { tools, messages } = setup();
    const tool = tools.get("codex_search");

    await tool.execute(
      "image-2",
      { query: "Generate an icon", intent: "image" },
      undefined,
      undefined,
      { cwd: "/repo" } as ExtensionContext,
    );

    expect(processMock.run).toHaveBeenCalledWith(
      "Generate an icon",
      "/repo",
      "image",
      undefined,
      expect.any(AbortSignal),
    );
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(messages[0].message.content).toContain("Created a candidate at /tmp/generated-image.png");
    expect(messages[0].message.content).toMatch(/not confirmation of final placement or delivery.*calling agent must inspect.*place it/is);
    expect(messages[0].message.content).not.toContain("not a verified primary source");
  });

  it("rejects an image destination for non-image intent before helper execution", async () => {
    const { tools, messages } = setup();
    const tool = tools.get("codex_search");

    await tool.execute(
      "search-destination",
      {
        query: "Compare primary sources",
        intent: "research",
        destination: "/repo/ambiguous.png",
      },
      undefined,
      undefined,
      { cwd: "/repo" } as ExtensionContext,
    );

    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(processMock.run).not.toHaveBeenCalled();
    expect(messages[0].message.content).toMatch(/destination is valid only with intent: image/i);
  });

  it("makes exact-URL helper failures visible and advances the remaining fallback stages", async () => {
    processMock.run.mockRejectedValueOnce(new Error("configured model is unavailable"));
    const { tools, messages } = setup();
    const tool = tools.get("codex_search");

    await tool.execute(
      "search-2",
      {
        query: "Fetch and extract https://example.com/source",
        intent: "exact_url",
      },
      undefined,
      undefined,
      { cwd: "/repo" } as ExtensionContext,
    );
    expect(processMock.run).toHaveBeenCalledWith(
      "Fetch and extract https://example.com/source",
      "/repo",
      "exact_url",
      undefined,
      expect.any(AbortSignal),
    );

    await vi.waitFor(() => expect(messages).toHaveLength(1));

    expect(messages[0].message.content).toMatch(/MUST report this codex_search failure in your next user-facing response/i);
    expect(messages[0].message.content).toMatch(/MUST NOT stop or abandon the task solely because codex_search failed/i);
    expect(messages[0].message.content).toMatch(/markdown\.new.*then.*r\.jina\.ai.*do not restart/is);
    expect(messages[0].message.content).toContain("configured model is unavailable");
    expect(messages[0].message.details).toMatchObject({
      toolName: "codex_search",
      outcome: "failed",
    });
  });
});
