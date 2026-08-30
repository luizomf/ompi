import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CapabilitySnapshot } from "./capabilities.ts";
import { SubagentController } from "./controller.ts";
import { buildChildInvocation, RpcSubprocess } from "./rpc-child.ts";

const PI_CLI = resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const SUBAGENT_EXTENSION = resolve("extensions/subagents/index.ts");
const temporaryRoots: string[] = [];

const NESTED_PROVIDER_EXTENSION = String.raw`
import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";

function usage() {
  return {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function lastUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    return message.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("");
  }
  return "";
}

function textStream(model, text) {
  const stream = createAssistantMessageEventStream();
  const partial = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: usage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
  const message = { ...partial, content: [{ type: "text", text }] };
  queueMicrotask(() => {
    stream.push({ type: "start", partial });
    stream.push({ type: "text_start", contentIndex: 0, partial });
    stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
    stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
  });
  return stream;
}

function toolStream(model, id, name, arguments_) {
  const stream = createAssistantMessageEventStream();
  const partial = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: usage(),
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
  const toolCall = {
    type: "toolCall",
    id,
    name,
    arguments: arguments_,
  };
  const message = { ...partial, content: [toolCall] };
  queueMicrotask(() => {
    stream.push({ type: "start", partial });
    stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
    stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
    stream.push({ type: "done", reason: "toolUse", message });
    stream.end(message);
  });
  return stream;
}

function hangingStream(model, signal) {
  const stream = createAssistantMessageEventStream();
  const partial = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: usage(),
    stopReason: "pending",
    timestamp: Date.now(),
  };
  queueMicrotask(() => stream.push({ type: "start", partial }));
  const abort = () => {
    const error = {
      ...partial,
      stopReason: "aborted",
      errorMessage: "fixture leaf interrupted",
    };
    stream.push({ type: "error", reason: "aborted", error });
    stream.end();
  };
  if (signal?.aborted) queueMicrotask(abort);
  else signal?.addEventListener("abort", abort, { once: true });
  return stream;
}

function streamFixture(model, context, options) {
  const userText = lastUserText(context.messages);
  const subagentResult = context.messages.findLast((message) =>
    message.role === "toolResult" && message.toolName === "subagent_start"
  );
  const dialogResult = context.messages.findLast((message) =>
    message.role === "toolResult" && message.toolName === "fixture_dialog"
  );
  const phase = userText === "LEAF"
    ? "leaf"
    : userText === "HANG"
      ? "leaf-hang"
      : userText === "DIALOG_LEAF"
        ? dialogResult
          ? "dialog-leaf-after"
          : "dialog-leaf-before"
        : subagentResult
          ? "coordinator-after"
          : "coordinator-before";
  appendFileSync(process.env.OMPI_NESTED_CAPTURE, JSON.stringify({
    phase,
    pid: process.pid,
    toolResult: subagentResult?.content ?? dialogResult?.content,
  }) + "\n");
  if (phase === "coordinator-before") {
    const prompt = userText === "SHUTDOWN" || userText === "CANCEL"
      ? "HANG"
      : userText === "DIALOG"
        ? "DIALOG_LEAF"
        : "LEAF";
    return toolStream(model, "call_leaf", "subagent_start", {
      prompt,
      delivery: "direct",
    });
  }
  if (phase === "dialog-leaf-before") {
    return toolStream(model, "call_dialog", "fixture_dialog", {});
  }
  if (phase === "dialog-leaf-after") return textStream(model, "leaf dialog completed");
  if (phase === "leaf") return textStream(model, "leaf done");
  if (phase === "leaf-hang") return hangingStream(model, options?.signal);
  return textStream(model, "coordinator received leaf");
}

export default function fixtureProvider(pi) {
  pi.registerTool({
    name: "fixture_tool",
    label: "Fixture Tool",
    description: "Keeps the deterministic model provider inherited",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "fixture tool" }] };
    },
  });
  pi.registerTool({
    name: "fixture_dialog",
    label: "Fixture Dialog",
    description: "Requests one deterministic standard confirmation",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _onUpdate, ctx) {
      const confirmed = await ctx.ui.confirm(
        "Nested approval",
        "Approve the depth-3 fixture?",
        { signal, timeout: 5_000 },
      );
      return { content: [{ type: "text", text: "confirmed: " + confirmed }] };
    },
  });
  pi.registerProvider("fixture", {
    name: "Fixture",
    baseUrl: "http://fixture.invalid",
    apiKey: "fixture-key",
    api: "fixture-api",
    models: [{
      id: "model",
      name: "Fixture Model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32000,
      maxTokens: 1024,
    }],
    streamSimple: streamFixture,
  });
}
`;

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("native nested subagents", () => {
  it("retains nested direct work, distinguishes cancellation, and shuts down the lineage", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "ompi-subagent-nesting-"));
    temporaryRoots.push(temporaryRoot);
    const root = await realpath(temporaryRoot);
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    const providerPath = join(root, "nested-provider.ts");
    const capturePath = join(root, "captures.jsonl");
    await mkdir(agentDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
    await writeFile(providerPath, NESTED_PROVIDER_EXTENSION);

    const previous = {
      agentDir: process.env.PI_CODING_AGENT_DIR,
      sessionDir: process.env.PI_CODING_AGENT_SESSION_DIR,
      offline: process.env.PI_OFFLINE,
      skipVersion: process.env.PI_SKIP_VERSION_CHECK,
      capture: process.env.OMPI_NESTED_CAPTURE,
    };
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_CODING_AGENT_SESSION_DIR = join(root, "sessions");
    process.env.PI_OFFLINE = "1";
    process.env.PI_SKIP_VERSION_CHECK = "1";
    process.env.OMPI_NESTED_CAPTURE = capturePath;

    const capabilities: CapabilitySnapshot = {
      tools: [
        { name: "subagent_start", provider: SUBAGENT_EXTENSION },
        { name: "fixture_tool", provider: providerPath },
        { name: "fixture_dialog", provider: providerPath },
      ],
      extensionPaths: [SUBAGENT_EXTENSION, providerPath],
    };
    const relayedDialogs: unknown[] = [];
    const controller = new SubagentController({
      handshakeMs: 10_000,
      createChild: async (spec) => {
        const invocation = buildChildInvocation(spec);
        return new RpcSubprocess({
          ...invocation,
          command: process.execPath,
          args: [PI_CLI, ...invocation.args],
        }, {
          onDialog: async (request) => {
            relayedDialogs.push(request);
            return request.method === "confirm"
              ? { confirmed: true }
              : { cancelled: true };
          },
        });
      },
      onPong: () => {
        throw new Error("Direct native nesting must not emit a pong.");
      },
    });

    try {
      const result = await controller.run({
        prompt: "COORDINATOR",
        cwd,
        model: "fixture/model",
        thinking: "off",
        capabilities,
        maxDepth: 3,
        maxChildren: 2,
      });
      expect(result).toMatchObject({
        outcome: "completed",
        finalText: "coordinator received leaf",
      });

      const captures = (await readFile(capturePath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(captures.map((capture) => capture.phase)).toEqual([
        "coordinator-before",
        "leaf",
        "coordinator-after",
      ]);
      expect(captures[0].pid).toBe(captures[2].pid);
      expect(captures[1].pid).not.toBe(captures[0].pid);

      const nestedResultText = captures[2].toolResult
        .filter((item: { type?: string }) => item.type === "text")
        .map((item: { text: string }) => item.text)
        .join("");
      expect(nestedResultText).toContain("[SUBAGENT #1] completed");
      const leafSession = nestedResultText.match(/Session: ([^\n]+\.jsonl)/)?.[1];
      expect(leafSession).toBeDefined();
      if (!leafSession) throw new Error("Nested result did not retain the leaf session reference.");

      const coordinatorSession = await readFile(result.sessionRef, "utf8");
      const persistedLeafSession = await readFile(leafSession, "utf8");
      expect(coordinatorSession).toContain("COORDINATOR");
      expect(coordinatorSession).toContain("coordinator received leaf");
      expect(persistedLeafSession).toContain("LEAF");
      expect(persistedLeafSession).toContain("leaf done");

      const dialogResult = await controller.run({
        prompt: "DIALOG",
        cwd,
        model: "fixture/model",
        thinking: "off",
        capabilities,
        maxDepth: 3,
        maxChildren: 2,
      });
      expect(dialogResult).toMatchObject({
        outcome: "completed",
        finalText: "coordinator received leaf",
      });
      expect(relayedDialogs).toEqual([{
        id: expect.any(String),
        method: "confirm",
        title: "Nested approval",
        message: "Approve the depth-3 fixture?",
        timeout: 5_000,
      }]);
      const dialogCaptures = (await readFile(capturePath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(dialogCaptures.map((capture) => capture.phase)).toEqual([
        "coordinator-before",
        "leaf",
        "coordinator-after",
        "coordinator-before",
        "dialog-leaf-before",
        "dialog-leaf-after",
        "coordinator-after",
      ]);
      expect(dialogCaptures[5].toolResult).toEqual([
        { type: "text", text: "confirmed: true" },
      ]);

      const cancellation = new AbortController();
      const cancelling = controller.run({
        prompt: "CANCEL",
        cwd,
        model: "fixture/model",
        thinking: "off",
        capabilities,
        maxDepth: 3,
        maxChildren: 2,
      }, cancellation.signal);
      let cancellationCaptures: Array<{ phase: string; pid: number }> = [];
      await vi.waitFor(async () => {
        cancellationCaptures = (await readFile(capturePath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(cancellationCaptures.filter((capture) => capture.phase === "leaf-hang")).toHaveLength(1);
      }, { timeout: 5_000 });
      const cancelledCoordinator = cancellationCaptures.findLast(
        (capture) => capture.phase === "coordinator-before",
      );
      const cancelledLeaf = cancellationCaptures.findLast(
        (capture) => capture.phase === "leaf-hang",
      );
      expect(cancelledCoordinator).toBeDefined();
      expect(cancelledLeaf).toBeDefined();
      if (!cancelledCoordinator || !cancelledLeaf) {
        throw new Error("Cancellation lineage processes were not observed.");
      }
      await vi.waitFor(() => {
        expect(controller.activeSubtree()).toEqual(expect.arrayContaining([
          expect.objectContaining({ path: [3], depth: 2, state: "running" }),
          expect.objectContaining({ path: [3, 1], parentPath: [3], depth: 3, state: "running" }),
        ]));
      });
      cancellation.abort();
      await expect(cancelling).resolves.toMatchObject({
        outcome: "interrupted",
        sessionRef: expect.stringMatching(/\.jsonl$/),
      });
      expect(processIsAlive(cancelledCoordinator.pid)).toBe(false);
      expect(processIsAlive(cancelledLeaf.pid)).toBe(false);
      expect(controller.activeSubtree()).toEqual([]);

      await controller.start({
        prompt: "SHUTDOWN",
        cwd,
        model: "fixture/model",
        thinking: "off",
        capabilities,
        maxDepth: 3,
        maxChildren: 2,
      });
      let activeCaptures: Array<{ phase: string; pid: number }> = [];
      await vi.waitFor(async () => {
        activeCaptures = (await readFile(capturePath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(activeCaptures.filter((capture) => capture.phase === "leaf-hang")).toHaveLength(2);
      }, { timeout: 5_000 });
      const activeCoordinator = activeCaptures.findLast(
        (capture) => capture.phase === "coordinator-before",
      );
      const activeLeaf = activeCaptures.findLast((capture) => capture.phase === "leaf-hang");
      expect(activeCoordinator).toBeDefined();
      expect(activeLeaf).toBeDefined();
      if (!activeCoordinator || !activeLeaf) {
        throw new Error("Shutdown lineage processes were not observed.");
      }
      expect(processIsAlive(activeCoordinator.pid)).toBe(true);
      expect(processIsAlive(activeLeaf.pid)).toBe(true);

      await controller.shutdown();
      expect(controller.list()).toEqual([]);
      expect(processIsAlive(activeCoordinator.pid)).toBe(false);
      expect(processIsAlive(activeLeaf.pid)).toBe(false);
    } finally {
      await controller.shutdown();
      const restore = (name: string, value: string | undefined) => {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      };
      restore("PI_CODING_AGENT_DIR", previous.agentDir);
      restore("PI_CODING_AGENT_SESSION_DIR", previous.sessionDir);
      restore("PI_OFFLINE", previous.offline);
      restore("PI_SKIP_VERSION_CHECK", previous.skipVersion);
      restore("OMPI_NESTED_CAPTURE", previous.capture);
    }
  }, 30_000);
});
