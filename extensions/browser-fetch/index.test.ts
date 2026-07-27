import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
  proxyClose: vi.fn(),
  startProxy: vi.fn(),
}));

vi.mock("./public-proxy.ts", () => ({ startPublicProxy: mocks.startProxy }));
vi.mock("playwright-core", () => ({
  chromium: { launch: mocks.launch },
}));

import browserFetchExtension from "./index.ts";

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
  const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
  const pi = {
    registerTool: (tool: { name: string }) => tools.set(tool.name, tool),
    registerMessageRenderer: () => undefined,
    sendMessage: (message: unknown, options: unknown) => messages.push({ message, options }),
    on: (event: string, handler: (...args: any[]) => unknown) => {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    },
  } as unknown as ExtensionAPI;
  browserFetchExtension(pi);
  return { tools, messages, handlers };
}

function fakeBrowser() {
  const close = vi.fn().mockResolvedValue(undefined);
  const page = {
    setDefaultTimeout: vi.fn(),
    goto: vi.fn().mockResolvedValue({ status: () => 200 }),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue({
      finalUrl: "https://example.com/final",
      title: "Example",
      text: "Readable rendered content. ".repeat(10),
      links: [{ text: "Documentation", url: "https://example.com/docs" }],
    }),
  };
  const browser = {
    close,
    newContext: vi.fn().mockResolvedValue({
      newPage: vi.fn().mockResolvedValue(page),
    }),
  };
  return { browser, close };
}

describe("browser_fetch background delivery", () => {
  beforeEach(() => {
    mocks.launch.mockReset();
    mocks.proxyClose.mockReset();
    mocks.proxyClose.mockResolvedValue(undefined);
    mocks.startProxy.mockReset();
    mocks.startProxy.mockResolvedValue({
      url: "http://127.0.0.1:43210",
      close: mocks.proxyClose,
    });
  });

  it("releases the tool call before Chromium finishes and delivers rendered content later", async () => {
    const launch = deferred<ReturnType<typeof fakeBrowser>["browser"]>();
    mocks.launch.mockReturnValue(launch.promise);
    const { tools, messages } = setup();
    const tool = tools.get("browser_fetch");

    const accepted = await tool.execute(
      "fetch-1",
      { url: "https://example.com" },
      undefined,
      undefined,
      { cwd: "/repo" } as ExtensionContext,
    );

    expect(accepted.content[0].text).toContain("Background task #1");
    expect(messages).toEqual([]);
    expect(tool.description).toContain("asynchronously");
    expect(tool.promptGuidelines.join(" ")).toContain("never wait");

    const { browser, close } = fakeBrowser();
    launch.resolve(browser);
    await vi.waitFor(() => expect(messages).toHaveLength(1));

    expect(messages[0]).toMatchObject({
      message: {
        content: expect.stringContaining("Readable rendered content"),
        details: {
          toolName: "browser_fetch",
          outcome: "completed",
          resultDetails: {
            finalUrl: "https://example.com/final",
            status: 200,
          },
        },
      },
      options: { deliverAs: "followUp", triggerTurn: true },
    });
    expect(mocks.launch).toHaveBeenCalledWith(expect.objectContaining({
      args: expect.arrayContaining([
        "--disable-quic",
        "--proxy-server=http://127.0.0.1:43210",
        "--proxy-bypass-list=<-loopback>",
      ]),
    }));
    expect(browser.newContext).toHaveBeenCalledWith({ serviceWorkers: "block" });
    expect(close).toHaveBeenCalled();
    expect(mocks.proxyClose).toHaveBeenCalled();
  });

  it("reports URL validation failures as the single background result", async () => {
    const { tools, messages } = setup();
    const tool = tools.get("browser_fetch");

    const accepted = await tool.execute(
      "fetch-2",
      { url: "file:///tmp/private" },
      undefined,
      undefined,
      { cwd: "/repo" } as ExtensionContext,
    );

    expect(accepted.content[0].text).toContain("started");
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(messages[0].message).toMatchObject({
      details: {
        toolName: "browser_fetch",
        outcome: "failed",
        error: "Unsupported URL protocol: file:",
      },
    });
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it("closes a browser that resolves after session cancellation without using it", async () => {
    const launch = deferred<ReturnType<typeof fakeBrowser>["browser"]>();
    mocks.launch.mockReturnValue(launch.promise);
    const { tools, messages, handlers } = setup();
    await tools.get("browser_fetch").execute(
      "fetch-cancelled",
      { url: "https://example.com" },
      undefined,
      undefined,
      { cwd: "/repo" } as ExtensionContext,
    );
    await vi.waitFor(() => expect(mocks.launch).toHaveBeenCalled());

    for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, {});
    const { browser, close } = fakeBrowser();
    launch.resolve(browser);

    await vi.waitFor(() => expect(close).toHaveBeenCalled());
    expect(browser.newContext).not.toHaveBeenCalled();
    expect(mocks.proxyClose).toHaveBeenCalled();
    expect(messages).toEqual([]);
  });
});
