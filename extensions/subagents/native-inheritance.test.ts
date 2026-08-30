import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CapabilitySnapshot } from "./capabilities.ts";
import { SubagentController } from "./controller.ts";
import { buildChildInvocation, RpcSubprocess } from "./rpc-child.ts";

const PI_CLI = resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const temporaryRoots: string[] = [];

const PROVIDER_EXTENSION = String.raw`
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

function streamFixture(model, context) {
  appendFileSync(process.env.OMPI_FIXTURE_CAPTURE, JSON.stringify({
    cwd: process.cwd(),
    environment: process.env.OMPI_INHERITED_ENV,
    systemPrompt: context.systemPrompt,
    messages: context.messages,
    tools: context.tools?.map((tool) => tool.name),
  }) + "\n");
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
  const message = {
    ...partial,
    content: [{ type: "text", text: "fixture done" }],
  };
  queueMicrotask(() => {
    stream.push({ type: "start", partial });
    stream.push({ type: "text_start", contentIndex: 0, partial });
    stream.push({ type: "text_delta", contentIndex: 0, delta: "fixture done", partial: message });
    stream.push({ type: "text_end", contentIndex: 0, content: "fixture done", partial: message });
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
  });
  return stream;
}

export default function fixtureProvider(pi) {
  pi.registerTool({
    name: "fixture_tool",
    label: "Fixture Tool",
    description: "Deterministic inherited extension tool",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "fixture tool" }] };
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

function userText(entry: any): string | undefined {
  if (entry.type !== "message" || entry.message?.role !== "user") return undefined;
  const content = entry.message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content
    .filter((item) => item?.type === "text")
    .map((item) => item.text)
    .join("");
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native child inheritance", () => {
  it("keeps a clean native conversation while inheriting extension tools, skills, context, cwd, and environment", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "ompi-subagent-inheritance-"));
    temporaryRoots.push(temporaryRoot);
    const root = await realpath(temporaryRoot);
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    const skillDir = join(cwd, ".pi", "skills", "fixture-skill");
    const providerPath = join(root, "fixture-provider.ts");
    const capturePath = join(root, "captures.jsonl");
    await mkdir(agentDir, { recursive: true });
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
    await writeFile(join(cwd, "AGENTS.md"), "PROJECT_CONTEXT_MARKER\n");
    await writeFile(join(skillDir, "SKILL.md"), [
      "---",
      "name: fixture-skill",
      "description: SKILL_DISCOVERY_MARKER for deterministic inheritance",
      "---",
      "",
      "# Fixture Skill",
    ].join("\n"));
    await writeFile(providerPath, PROVIDER_EXTENSION);

    const previous = {
      agentDir: process.env.PI_CODING_AGENT_DIR,
      sessionDir: process.env.PI_CODING_AGENT_SESSION_DIR,
      offline: process.env.PI_OFFLINE,
      skipVersion: process.env.PI_SKIP_VERSION_CHECK,
      capture: process.env.OMPI_FIXTURE_CAPTURE,
      inherited: process.env.OMPI_INHERITED_ENV,
    };
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_CODING_AGENT_SESSION_DIR = join(root, "sessions");
    process.env.PI_OFFLINE = "1";
    process.env.PI_SKIP_VERSION_CHECK = "1";
    process.env.OMPI_FIXTURE_CAPTURE = capturePath;
    process.env.OMPI_INHERITED_ENV = "ENVIRONMENT_MARKER";

    const capabilities: CapabilitySnapshot = {
      tools: [
        { name: "read", provider: "builtin" },
        { name: "fixture_tool", provider: providerPath },
      ],
      extensionPaths: [providerPath],
    };
    const controller = new SubagentController({
      handshakeMs: 10_000,
      createChild: async (spec) => {
        const invocation = buildChildInvocation(spec);
        return new RpcSubprocess({
          ...invocation,
          command: process.execPath,
          args: [PI_CLI, ...invocation.args],
        });
      },
      onPong: () => {
        throw new Error("Direct integration runs must not emit pongs.");
      },
    });

    try {
      const first = await controller.run({
        prompt: "EXPLICIT_FIRST",
        cwd,
        model: "fixture/model",
        thinking: "off",
        capabilities,
        name: "named-only",
      });
      expect(first.outcome).toBe("completed");

      const second = await controller.runContinuation({
        id: 1,
        prompt: "EXPLICIT_SECOND",
        model: "fixture/model",
        thinking: "off",
        capabilities,
      });
      expect(second).toMatchObject({
        outcome: "completed",
        sessionRef: first.sessionRef,
      });

      const sessionLines = (await readFile(first.sessionRef, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(sessionLines[0]).toMatchObject({ type: "session", cwd });
      expect(sessionLines[0]).not.toHaveProperty("parentSession");
      expect(sessionLines.map(userText).filter(Boolean)).toEqual([
        "EXPLICIT_FIRST",
        "EXPLICIT_SECOND",
      ]);
      const serializedSession = JSON.stringify(sessionLines);
      expect(serializedSession).not.toContain("PARENT_TRANSCRIPT_MARKER");
      expect(serializedSession).not.toContain("compactionSummary");
      expect(serializedSession).not.toContain("worker subagent");

      const captures = (await readFile(capturePath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(captures).toHaveLength(2);
      for (const capture of captures) {
        expect(capture.cwd).toBe(cwd);
        expect(capture.environment).toBe("ENVIRONMENT_MARKER");
        expect(capture.systemPrompt).toContain("PROJECT_CONTEXT_MARKER");
        expect(capture.systemPrompt).toContain("SKILL_DISCOVERY_MARKER");
        expect(capture.systemPrompt).not.toContain("worker subagent");
        expect(capture.tools).toEqual(["read", "fixture_tool"]);
      }
      expect(captures[0].messages.map((message: any) => message.role)).toEqual(["user"]);
      expect(captures[1].messages.map((message: any) => message.role)).toEqual([
        "user",
        "assistant",
        "user",
      ]);
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
      restore("OMPI_FIXTURE_CAPTURE", previous.capture);
      restore("OMPI_INHERITED_ENV", previous.inherited);
    }
  }, 20_000);
});
