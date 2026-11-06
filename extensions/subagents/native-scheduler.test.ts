import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { SubagentController, type TerminalResult } from "./controller.ts";
import { buildChildInvocation, RpcSubprocess } from "./rpc-child.ts";

const execute = promisify(execFile);
const PI_CLI = resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js");

// A real RPC Pi and scheduler endpoint, with only Queue acceptance and the model
// replaced. The test explicitly runs the captured callback runner after idle.
const fixture = `
import { writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { registerSchedulerExtension } from ${JSON.stringify(resolve("extensions/scheduler/index.ts"))};
export default function (pi) {
  let woke = false;
  let race = false;
  let duringAcceptance = false;
  let releaseSettlement;
  pi.on("agent_settled", async () => {
    if (race && !woke) {
      writeFileSync(process.env.OMPI_SCHEDULER_CAPTURE + ".settling", "yes");
      await new Promise(resolve => { releaseSettlement = resolve; });
    }
  });
  registerSchedulerExtension({ ...pi, sendMessage(message, options) {
    if (message.customType === "scheduler-wake") woke = true;
    pi.sendMessage(message, options);
    if (woke) releaseSettlement?.();
  } }, { runBq: async (invocation) => {
    writeFileSync(process.env.OMPI_SCHEDULER_CAPTURE, JSON.stringify(invocation.args));
    if (duringAcceptance) {
      const runner = invocation.args.slice(invocation.args.indexOf("--") + 1);
      await promisify(execFile)(runner[0], runner.slice(1));
    }
    return { code: 0, stdout: "accepted", stderr: "", stdoutTruncated: false, stderrTruncated: false };
  } });
  // This hook deliberately follows the scheduler hook. Starting a run is not
  // proof that its agent_start event has reached the parent yet.
  pi.on("agent_start", async () => {
    if (woke && race) await new Promise(resolve => setTimeout(resolve, 500));
  });
  pi.registerProvider("fixture", {
    name: "Fixture", baseUrl: "http://fixture.invalid", apiKey: "fixture-key", api: "fixture-api",
    models: [{ id: "model", name: "Fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 }],
    streamSimple(model, context) {
      if (JSON.stringify(context.messages).includes("SETTLEMENT_RACE")) race = true;
      if (JSON.stringify(context.messages).includes("DURING_ACCEPTANCE")) duringAcceptance = true;
      const submitted = context.messages.some(m => m.role === "toolResult" && m.toolName === "scheduler_submit");
      const call = { type: "toolCall", id: "schedule_once", name: "scheduler_submit", arguments: {
        reentryPrompt: "Inspect this completed heartbeat; never rerun it or inspect/administer OMQueue."
      } };
      const content = submitted ? [{ type: "text", text: woke ? "CALLBACK_PROCESSED" : "WAITING_AND_REACHABLE" }] : [call];
      const message = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: submitted ? "stop" : "toolUse", timestamp: Date.now() };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        if (submitted) {
          stream.push({ type: "text_start", contentIndex: 0, partial: message });
          stream.push({ type: "text_delta", contentIndex: 0, delta: content[0].text, partial: message });
          stream.push({ type: "text_end", contentIndex: 0, content: content[0].text, partial: message });
        } else {
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
        }
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end(message);
      });
      return stream;
    }
  });
}
`;

it("retains a real idle scheduler child, wakes it through steering and callback, and can close its next wait", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ompi-native-scheduler-")));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const extension = join(root, "fixture.ts");
  const capture = join(root, "invocation.json");
  await mkdir(agentDir);
  await mkdir(cwd);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
  await writeFile(extension, fixture);
  const environment = {
    PI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    OMPI_SCHEDULER_CAPTURE: capture,
  };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const pongs: TerminalResult[] = [];
  const controller = new SubagentController({
    createChild: async spec => {
      const invocation = buildChildInvocation(spec);
      return new RpcSubprocess({ ...invocation, command: process.execPath, args: [PI_CLI, ...invocation.args] });
    },
    onPong: pong => { pongs.push(pong); },
  });
  const input = {
    prompt: "Schedule one heartbeat and return; process its callback when it arrives.",
    cwd, model: "fixture/model", thinking: "off" as const,
    capabilities: { tools: [{ name: "scheduler_submit", provider: extension }], extensionPaths: [extension] },
  };
  try {
    await controller.start(input);
    await vi.waitFor(() => expect(controller.list()[0]).toMatchObject({ state: "waiting-scheduler", active: true, scheduler: { count: 1 } }), { timeout: 10_000 });
    expect(pongs).toEqual([]);
    await controller.steer(1, "Respond without resubmitting; keep the existing callback pending.");
    await vi.waitFor(() => expect(controller.list()[0].state).toBe("waiting-scheduler"), { timeout: 5_000 });
    const session = await readFile(controller.list()[0].sessionRef!, "utf8");
    expect(session).toContain("Respond without resubmitting");
    const args: string[] = JSON.parse(await readFile(capture, "utf8"));
    const runner = args.slice(args.indexOf("--") + 1);
    await execute(runner[0], runner.slice(1), { cwd });
    await vi.waitFor(() => expect(pongs).toEqual([expect.objectContaining({ outcome: "completed", finalText: "CALLBACK_PROCESSED" })]), { timeout: 5_000 });
    expect(controller.list()[0].active).toBe(false);

    await controller.start(input);
    await vi.waitFor(() => expect(controller.list()[1].state).toBe("waiting-scheduler"), { timeout: 10_000 });
    await controller.steer(2, "/schedulelist");
    expect(controller.list()[1].state).toBe("waiting-scheduler");
    await controller.interrupt(2);
    expect(controller.list()[1]).toMatchObject({ state: "interrupted", active: false });
    expect(pongs[1]).toMatchObject({ outcome: "interrupted", error: expect.stringContaining("Queue") });

    // Force callback delivery during an async settled hook: the old settled
    // event must not close the child before its queued callback turn starts.
    await controller.start({ ...input, prompt: "SETTLEMENT_RACE: schedule one heartbeat" });
    await vi.waitFor(async () => expect(await readFile(capture + ".settling", "utf8")).toBe("yes"), { timeout: 10_000 });
    const raceArgs: string[] = JSON.parse(await readFile(capture, "utf8"));
    const raceRunner = raceArgs.slice(raceArgs.indexOf("--") + 1);
    await execute(raceRunner[0], raceRunner.slice(1), { cwd });
    await vi.waitFor(() => expect(pongs[2]).toMatchObject({ outcome: "completed", finalText: "CALLBACK_PROCESSED" }), { timeout: 5_000 });

    // Follow-ups can be consumed inside the existing run, without agent_start.
    await controller.start({ ...input, prompt: "DURING_ACCEPTANCE: schedule one heartbeat" });
    await vi.waitFor(() => expect(pongs[3]).toMatchObject({ outcome: "completed", finalText: "CALLBACK_PROCESSED" }), { timeout: 10_000 });
  } finally {
    await controller.shutdown();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
