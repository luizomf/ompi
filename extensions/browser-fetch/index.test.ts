import {
  DEFAULT_MAX_BYTES,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
}));

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

interface FakePageOptions {
  status?: number | null;
  finalUrl?: string;
  title?: string;
  text?: string;
  gotoError?: Error;
}

function fakeBrowser(options: FakePageOptions = {}) {
  const close = vi.fn().mockResolvedValue(undefined);
  const goto = options.gotoError
    ? vi.fn().mockRejectedValue(options.gotoError)
    : vi.fn().mockResolvedValue(options.status === null
      ? null
      : { status: () => options.status ?? 200 });
  const page = {
    setDefaultTimeout: vi.fn(),
    goto,
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue({
      finalUrl: options.finalUrl ?? "https://example.com/final",
      title: options.title ?? "Example",
      text: options.text ?? "Readable rendered content. ".repeat(10),
      links: [{ text: "Documentation", url: "https://example.com/docs" }],
    }),
  };
  const browser = {
    close,
    newContext: vi.fn().mockResolvedValue({
      newPage: vi.fn().mockResolvedValue(page),
    }),
  };
  return { browser, close, page };
}

async function executeFetch(url: string, options: FakePageOptions = {}) {
  const fake = fakeBrowser(options);
  mocks.launch.mockResolvedValue(fake.browser);
  const { tools, messages } = setup();
  const accepted = await tools.get("browser_fetch").execute(
    "fetch",
    { url },
    undefined,
    undefined,
    { cwd: "/repo" } as ExtensionContext,
  );
  await vi.waitFor(() => expect(messages).toHaveLength(1));
  return { accepted, message: messages[0].message, ...fake };
}

describe("browser_fetch background delivery", () => {
  beforeEach(() => {
    mocks.launch.mockReset();
  });

  it("releases the tool call before fresh Chromium rendering finishes and delivers bounded content later", async () => {
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

    expect(accepted.content[0].text).toContain("Background operation #1");
    expect(accepted.content[0].text).toMatch(/owning Pi session remains live/i);
    expect(messages).toEqual([]);
    expect(tool.description).toContain("asynchronously");
    expect(tool.description).toMatch(/user-authorized HTTP or HTTPS/i);
    const guidance = tool.promptGuidelines.join(" ");
    expect(guidance).toContain("never wait");
    expect(guidance).toMatch(/independently useful.*same turn.*concurrently.*do not wait/s);
    expect(guidance).toMatch(/direct HTTP\/curl.*browser_fetch.*original URL.*codex_search.*intent exact_url.*markdown\.new.*r\.jina\.ai/is);
    expect(guidance).toMatch(/do not restart.*transformed fallback URL/i);
    expect(guidance).toMatch(/third-party.*credentials.*signed.*confidential/i);
    expect(guidance).toMatch(/every safe stage fails.*could not access or verify.*must not invent/is);

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
            retrievalOutcome: "retrieved",
          },
        },
      },
      options: { deliverAs: "followUp", triggerTurn: true },
    });
    expect(messages[0].message.content).toMatch(/delivered to its owning live Pi session/i);
    expect(mocks.launch).toHaveBeenCalledWith(expect.objectContaining({
      args: ["--disable-dev-shm-usage", "--disable-extensions"],
    }));
    expect(browser.newContext).toHaveBeenCalledWith();
    expect(close).toHaveBeenCalled();
  });

  it.each([
    "http://127.0.0.1/admin",
    "http://10.0.0.8/private",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/status",
    "https://internal.example/",
  ])("attempts the authorized valid destination without local network classification: %s", async (url) => {
    const { message } = await executeFetch(url);

    expect(mocks.launch).toHaveBeenCalledOnce();
    expect(message.details).toMatchObject({
      outcome: "completed",
      resultDetails: {
        url: new URL(url).href,
        retrievalOutcome: "retrieved",
      },
    });
    const launchArgs = mocks.launch.mock.calls[0][0].args as string[];
    expect(launchArgs.some((argument) => argument.startsWith("--proxy-server"))).toBe(false);
    expect(launchArgs).not.toContain("--proxy-bypass-list=<-loopback>");
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

  it("reports transport failures and advances to exact-URL Codex retrieval", async () => {
    const { message } = await executeFetch("https://example.com/article", {
      gotoError: new Error("net::ERR_CONNECTION_RESET"),
    });

    expect(message.details).toMatchObject({
      toolName: "browser_fetch",
      outcome: "failed",
    });
    expect(message.content).toMatch(/transport or navigation failed.*ERR_CONNECTION_RESET/is);
    expect(message.content).toMatch(/Next exact-URL stage.*codex_search.*intent "exact_url".*exact URL/is);
    expect(message.content).toMatch(/helper\/model-produced prose.*not proof of access/i);
  });

  it("reports a missing navigation response without treating page text as access proof", async () => {
    const { message } = await executeFetch("https://example.com/no-response", { status: null });

    expect(message.details.resultDetails).toMatchObject({
      status: null,
      retrievalOutcome: "no_http_response",
    });
    expect(message.content).toMatch(/no HTTP response.*exact-target access could not be established/is);
    expect(message.content).toMatch(/Next exact-URL stage.*codex_search.*intent "exact_url"/is);
  });

  it("reports HTTP failures with the next exact-URL stage", async () => {
    const { message } = await executeFetch("https://example.com/missing", { status: 503 });

    expect(message.details.resultDetails).toMatchObject({
      status: 503,
      retrievalOutcome: "http_failure",
    });
    expect(message.content).toMatch(/HTTP failure.*503/is);
    expect(message.content).toMatch(/Next exact-URL stage.*codex_search.*intent "exact_url"/is);
  });

  it("does not infer a login or CAPTCHA response from an HTTP status alone", async () => {
    const { message } = await executeFetch("https://example.com/forbidden", { status: 403 });

    expect(message.details.resultDetails).toMatchObject({
      status: 403,
      retrievalOutcome: "http_failure",
    });
    expect(message.content).toMatch(/HTTP failure.*403/is);
    expect(message.content).not.toMatch(/CAPTCHA|anti-bot/i);
  });

  it("reports login or CAPTCHA responses with the next exact-URL stage", async () => {
    const { message } = await executeFetch("https://example.com/private", {
      status: 403,
      title: "Sign in to continue",
    });

    expect(message.details.resultDetails).toMatchObject({
      status: 403,
      retrievalOutcome: "access_block",
    });
    expect(message.content).toMatch(/login, CAPTCHA, anti-bot, or other access-block response.*HTTP 403/is);
    expect(message.content).toMatch(/Next exact-URL stage.*codex_search.*intent "exact_url"/is);
  });

  it("reports unreadable rendered content with the next exact-URL stage", async () => {
    const { message } = await executeFetch("https://example.com/empty", { text: "Loading" });

    expect(message.details.resultDetails).toMatchObject({
      retrievalOutcome: "no_readable_content",
    });
    expect(message.content).toMatch(/unreadable.*7 characters/is);
    expect(message.content).toMatch(/Next exact-URL stage.*codex_search.*intent "exact_url"/is);
  });

  it("bounds rendered failure results containing a long valid URL", async () => {
    const fake = fakeBrowser({ status: 503 });
    mocks.launch.mockResolvedValue(fake.browser);
    const { tools } = setup();
    const longUrl = `https://example.com/${"a".repeat(DEFAULT_MAX_BYTES * 2)}`;

    const result = await tools.get("browser_fetch").execute(
      "fetch-long-result",
      { url: longUrl },
      undefined,
      undefined,
      { cwd: "/repo", mode: "print" } as ExtensionContext,
    );

    expect(Buffer.byteLength(result.content[0].text, "utf8")).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
    expect(result.content[0].text).toMatch(/HTTP failure.*503/is);
    expect(result.content[0].text).toMatch(/Requested URL:.*\[truncated\]/is);
    expect(result.content[0].text).toMatch(/Next exact-URL stage.*codex_search/is);
  });

  it("bounds transport errors while preserving the original cause", async () => {
    const transportError = new Error(`net::ERR_FAILED ${"x".repeat(DEFAULT_MAX_BYTES * 2)}`);
    const fake = fakeBrowser({ gotoError: transportError });
    mocks.launch.mockResolvedValue(fake.browser);
    const { tools } = setup();

    let thrown: unknown;
    try {
      await tools.get("browser_fetch").execute(
        "fetch-long-error",
        { url: "https://example.com/article" },
        undefined,
        undefined,
        { cwd: "/repo", mode: "print" } as ExtensionContext,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const error = thrown as Error;
    expect(Buffer.byteLength(error.message, "utf8")).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
    expect(error.message).toMatch(/transport or navigation failed.*ERR_FAILED.*\[truncated\]/is);
    expect(error.message).toMatch(/Next exact-URL stage.*codex_search/is);
    expect(error.cause).toBe(transportError);
  });

  it("advances a failed markdown.new request only to the final hosted fallback", async () => {
    const { message } = await executeFetch(
      "https://markdown.new/https://example.com/article?view=full",
      { status: 502 },
    );

    expect(message.content).toMatch(/HTTP failure.*502/is);
    expect(message.content).toMatch(/Next exact-URL stage.*third-party disclosure is authorized/is);
    expect(message.content).toContain("https://r.jina.ai/https://example.com/article?view=full");
    expect(message.content).toMatch(/Do not restart the fallback chain/i);
    expect(message.content).not.toMatch(/Next exact-URL stage.*codex_search/is);
  });

  it("reports honest exhaustion when the final hosted fallback is unreadable", async () => {
    const { message } = await executeFetch(
      "https://r.jina.ai/https://example.com/article",
      { text: "No content" },
    );

    expect(message.details.resultDetails).toMatchObject({
      retrievalOutcome: "no_readable_content",
    });
    expect(message.content).toMatch(/exact-URL fallback chain is exhausted/i);
    expect(message.content).toMatch(/could not be accessed or verified/i);
    expect(message.content).toMatch(/do not invent page-specific facts/i);
    expect(message.content).not.toMatch(/Next exact-URL stage/i);
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
    expect(messages).toEqual([]);
  });
});
