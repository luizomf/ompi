import { resolve } from "node:path";
import {
  getAgentDir,
  keyHint,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
  SubagentController,
  type ContinueInput,
  type Pong,
  type StartInput,
  type SubagentView,
  type ThinkingLevel,
} from "./controller.ts";
import { buildChildInvocation, RpcSubprocess } from "./rpc-child.ts";

const NATIVE_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
const PONG_TEXT_LIMIT = 8_000;

const ToolsSchema = Type.Array(Type.String(), {
  minItems: 1,
  description: "Allowlist of native Pi tools: read, bash, edit, write, grep, find, ls",
});

const StartSchema = Type.Object({
  prompt: Type.String({ description: "Complete initial prompt for the clean subagent conversation" }),
  name: Type.Optional(Type.String({ description: "Native Pi session display name" })),
  cwd: Type.Optional(Type.String({ description: "Initial working directory; fixed for this conversation" })),
  tools: Type.Optional(ToolsSchema),
});

const ContinueSchema = Type.Object({
  id: Type.Integer({ minimum: 1 }),
  prompt: Type.String({ description: "Prompt for the next turn in the existing conversation" }),
  tools: Type.Optional(ToolsSchema),
});

const SteerSchema = Type.Object({
  id: Type.Integer({ minimum: 1 }),
  message: Type.String({ description: "Instruction delivered at Pi's next safe steering boundary" }),
});

const InterruptSchema = Type.Object({ id: Type.Integer({ minimum: 1 }) });
const ListSchema = Type.Object({});

type StartParams = Static<typeof StartSchema>;
type ContinueParams = Static<typeof ContinueSchema>;

function validateTools(tools?: string[]): string[] | undefined {
  if (!tools) return undefined;
  const invalid = tools.filter((tool) => !NATIVE_TOOLS.has(tool));
  if (invalid.length) throw new Error(`Only native Pi tools are allowed. Invalid: ${invalid.join(", ")}.`);
  return [...new Set(tools)];
}

function activeModel(ctx: ExtensionContext): string {
  if (!ctx.model) throw new Error("The orchestrator has no active model to inherit.");
  return `${ctx.model.provider}/${ctx.model.id}`;
}

function oneLine(value: string, limit: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

function formatView(view: SubagentView): string {
  const name = view.name ? ` (${view.name})` : "";
  const session = view.sessionRef ? `\n  session: ${view.sessionRef}` : "";
  const error = view.error ? `\n  error: ${view.error}` : "";
  return `#${view.id}${name}: ${view.state} — ${view.model} · reasoning ${view.thinking} @ ${view.cwd}${session}${error}`;
}

function parseObject<T>(args: string): T | undefined {
  const trimmed = args.trim();
  if (!trimmed.startsWith("{")) return undefined;
  return JSON.parse(trimmed) as T;
}

function parseIdMessage(args: string, usage: string): { id: number; message: string } {
  const match = args.trim().match(/^(\d+)\s+([\s\S]+)$/);
  if (!match) throw new Error(usage);
  return { id: Number(match[1]), message: match[2].trim() };
}

function boundedPongText(pong: Pong): { text?: string; truncated: boolean } {
  if (!pong.finalText) return { truncated: false };
  if (pong.finalText.length <= PONG_TEXT_LIMIT) return { text: pong.finalText, truncated: false };
  return { text: pong.finalText.slice(0, PONG_TEXT_LIMIT), truncated: true };
}

export function buildActiveUi(views: SubagentView[], now: number): { lines?: string[]; status?: string } {
  const active = views.filter((view) => view.active);
  if (active.length === 0) return {};
  const lines = active.map((view) => {
    const elapsed = view.startedAt ? Math.max(0, Math.floor((now - view.startedAt) / 1_000)) : 0;
    const name = view.name ? ` ${oneLine(view.name, 20)}` : "";
    const model = oneLine(view.model, 40);
    const tool = view.currentTool ? ` · ${view.currentTool}` : "";
    const preview = view.preview ? ` · ${oneLine(view.preview, 72)}` : "";
    return `#${view.id}${name} · ${view.state} · ${elapsed}s · ${model} · reasoning ${view.thinking}${tool}${preview}`;
  });
  return { lines, status: `subagents: ${active.length}` };
}

export function buildPongMessage(pong: Pong): { content: string; details: Pong & { finalText?: string; truncated: boolean } } {
  const final = boundedPongText(pong);
  const heading = `[PONG subagent #${pong.id}${pong.name ? ` ${pong.name}` : ""}] ${pong.outcome}`;
  const parts = [heading, `Session: ${pong.sessionRef}`];
  if (pong.error) parts.push(`Error: ${pong.error}`);
  if (final.text) parts.push(`Final assistant message${final.truncated ? " (truncated to 8,000 characters)" : ""}:\n${final.text}`);
  return {
    content: parts.join("\n\n"),
    details: { ...pong, finalText: final.text, truncated: final.truncated },
  };
}

export default function subagentsExtension(pi: ExtensionAPI) {
  pi.registerMessageRenderer("subagent-pong", (message, { expanded }, theme) => {
    const details = message.details as (Pong & { truncated?: boolean }) | undefined;
    const heading = details
      ? `[PONG subagent #${details.id}${details.name ? ` ${details.name}` : ""}] ${details.outcome}`
      : "[PONG subagent]";
    const collapsed = [heading];
    if (details?.sessionRef) collapsed.push(`Session: ${details.sessionRef}`);
    if (details?.error) collapsed.push(`Error: ${details.error}`);
    collapsed.push(keyHint("app.tools.expand", "to expand"));

    const expandedContent = typeof message.content === "string" ? message.content : collapsed.join("\n");
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(expanded ? expandedContent : collapsed.join("\n"), 0, 0));
    return box;
  });

  let ui: ExtensionContext["ui"] | undefined;
  let timer: NodeJS.Timeout | undefined;
  let controller: SubagentController;

  const refreshUi = () => {
    const views = controller.list();
    const activeCount = views.filter((view) => view.active).length;
    const presentation = buildActiveUi(views, Date.now());
    if (ui) {
      const theme = ui.theme;
      ui.setWidget(
        "subagents",
        presentation.lines?.map((line) => theme.fg("accent", line)),
      );
      ui.setStatus(
        "subagents",
        presentation.status ? theme.fg("success", presentation.status) : undefined,
      );
    }
    if (activeCount > 0 && !timer) timer = setInterval(refreshUi, 1_000);
    if (activeCount === 0 && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  const sendPong = (pong: Pong) => {
    const message = buildPongMessage(pong);
    pi.sendMessage(
      {
        customType: "subagent-pong",
        content: message.content,
        display: true,
        details: message.details,
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  };

  controller = new SubagentController({
    createChild: async (spec) => new RpcSubprocess(buildChildInvocation(spec, resolve(getAgentDir(), "skills"))),
    onPong: sendPong,
    onChange: refreshUi,
  });

  const start = (params: StartParams, ctx: ExtensionContext): Promise<SubagentView> => {
    const input: StartInput = {
      prompt: params.prompt,
      name: params.name,
      model: activeModel(ctx),
      thinking: pi.getThinkingLevel() as ThinkingLevel,
      cwd: resolve(ctx.cwd, params.cwd ?? "."),
      tools: validateTools(params.tools),
    };
    return controller.start(input);
  };

  const continueSubagent = (params: ContinueParams, ctx: ExtensionContext): Promise<SubagentView> => {
    const input: ContinueInput = {
      id: params.id,
      prompt: params.prompt,
      model: activeModel(ctx),
      thinking: pi.getThinkingLevel() as ThinkingLevel,
      tools: validateTools(params.tools),
    };
    return controller.continue(input);
  };

  pi.registerTool({
    name: "subagent_start",
    label: "Start Subagent",
    description: "Start a clean persistent Pi conversation asynchronously. Returns after RPC prompt acceptance; completion arrives later as one pong. Never wait or poll for that pong.",
    promptSnippet: "Start an independent asynchronous Pi conversation with a complete prompt",
    promptGuidelines: [
      "When multiple independent delegations are useful, issue their subagent_start calls in the same turn so Pi can run them concurrently; do not wait for one pong before starting another.",
      "After subagent_start accepts a prompt, never wait, sleep, or poll for its result. Continue only useful work independent of that result; otherwise end the response so user input and the later pong can be delivered.",
    ],
    parameters: StartSchema,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const view = await start(params, ctx);
      return {
        content: [{
          type: "text",
          text: `Subagent #${view.id} accepted the prompt and is running. Session: ${view.sessionRef}\nDo not wait, sleep, or poll for completion. Start any other useful independent delegation without waiting, then continue independent work or end this response; the pong will arrive later.`,
        }],
        details: view,
      };
    },
  });

  pi.registerTool({
    name: "subagent_continue",
    label: "Continue Subagent",
    description: "Start another asynchronous turn in a settled known subagent conversation. Returns after prompt acceptance; never wait or poll for completion.",
    promptGuidelines: [
      "After subagent_continue accepts a prompt, never wait, sleep, or poll for its result. Continue only useful work independent of that result; otherwise end the response so user input and the later pong can be delivered.",
    ],
    parameters: ContinueSchema,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const view = await continueSubagent(params, ctx);
      return {
        content: [{
          type: "text",
          text: `Subagent #${view.id} accepted the continuation and is running.\nDo not wait, sleep, or poll for completion. Continue independent work or end this response; the pong will arrive later.`,
        }],
        details: view,
      };
    },
  });

  pi.registerTool({
    name: "subagent_steer",
    label: "Steer Subagent",
    description: "Queue an instruction for an active subagent at Pi's safe steering boundary.",
    parameters: SteerSchema,
    async execute(_id, params) {
      const view = await controller.steer(params.id, params.message);
      return { content: [{ type: "text", text: `Steering accepted for subagent #${view.id}.` }], details: view };
    },
  });

  pi.registerTool({
    name: "subagent_interrupt",
    label: "Interrupt Subagent",
    description: "Abort an active subagent turn while preserving its native conversation for continuation.",
    parameters: InterruptSchema,
    async execute(_id, params) {
      const view = await controller.interrupt(params.id);
      return { content: [{ type: "text", text: `Interruption requested for subagent #${view.id}.` }], details: view };
    },
  });

  pi.registerTool({
    name: "subagent_list",
    label: "List Subagents",
    description: "Take one snapshot of conversations known to this orchestrator session. This is not a completion wait or polling mechanism.",
    promptGuidelines: [
      "Use subagent_list only for a status snapshot needed for a user request or an orchestration decision; never call it repeatedly to poll for completion.",
    ],
    parameters: ListSchema,
    async execute() {
      const views = controller.list();
      const text = views.length ? views.map(formatView).join("\n") : "No subagents are known in this orchestrator session.";
      return { content: [{ type: "text", text }], details: { subagents: views } };
    },
  });

  pi.registerCommand("sub", {
    description: "Start a subagent: /sub <prompt> or /sub {JSON options}",
    handler: async (args, ctx) => {
      try {
        const object = parseObject<StartParams>(args);
        const params = object ?? { prompt: args.trim() };
        if (!params.prompt) throw new Error("Usage: /sub <prompt> or /sub {\"prompt\": \"...\"}");
        const view = await start(params, ctx);
        ctx.ui.notify(`Subagent #${view.id} started.`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("subcont", {
    description: "Continue a subagent: /subcont <id> <prompt> or JSON options",
    handler: async (args, ctx) => {
      try {
        const object = parseObject<ContinueParams>(args);
        const params = object ?? (() => {
          const parsed = parseIdMessage(args, "Usage: /subcont <id> <prompt>");
          return { id: parsed.id, prompt: parsed.message };
        })();
        const view = await continueSubagent(params, ctx);
        ctx.ui.notify(`Subagent #${view.id} continued.`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("substeer", {
    description: "Steer an active subagent: /substeer <id> <instruction>",
    handler: async (args, ctx) => {
      try {
        const { id, message } = parseIdMessage(args, "Usage: /substeer <id> <instruction>");
        await controller.steer(id, message);
        ctx.ui.notify(`Steering accepted for subagent #${id}.`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("substop", {
    description: "Interrupt an active subagent: /substop <id>",
    handler: async (args, ctx) => {
      try {
        const id = Number(args.trim());
        if (!Number.isInteger(id) || id < 1) throw new Error("Usage: /substop <id>");
        await controller.interrupt(id);
        ctx.ui.notify(`Interruption requested for subagent #${id}.`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("sublist", {
    description: "List subagents known to this orchestrator session",
    handler: async (_args, ctx) => {
      const views = controller.list();
      ctx.ui.notify(views.length ? views.map(formatView).join("\n") : "No known subagents.", "info");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    ui = ctx.ui;
    refreshUi();
  });

  pi.on("session_shutdown", async () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    await controller.shutdown();
    ui?.setWidget("subagents", undefined);
    ui?.setStatus("subagents", undefined);
    ui = undefined;
  });
}
