import { resolve } from "node:path";
import {
  keyHint,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
  SubagentController,
  type ContinueInput,
  type StartInput,
  type TerminalResult,
  type SubagentView,
  type ThinkingLevel,
  type OwnershipRuntime,
} from "./controller.ts";
import { buildChildInvocation, RpcSubprocess } from "./rpc-child.ts";
import { captureCapabilities } from "./capabilities.ts";
import { publishAsyncActivity } from "./async-activity.ts";
import {
  cancelledDialogResult,
  relayStandardDialog,
  type StandardDialogRequest,
  type StandardDialogResult,
} from "./dialogs.ts";
import { readManagedLineage } from "./lineage.ts";
import {
  OWNERSHIP_STATUS_KEY,
  encodeOwnershipStatus,
} from "./ownership.ts";
import {
  PARENT_ERROR_LIMIT,
  SESSION_REFERENCE_LIMIT,
  boundText,
  errorText,
  parentVisibleError,
} from "./feedback.ts";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const THINKING_LEVEL_SET = new Set<string>(THINKING_LEVELS);
const DELIVERY_MODES = ["async", "direct"] as const;
type DeliveryMode = typeof DELIVERY_MODES[number];
const TERMINAL_TEXT_LIMIT = 8_000;
const METADATA_ERROR_LIMIT = 1_000;
const METADATA_CWD_LIMIT = 512;
const METADATA_MODEL_LIMIT = 200;
const METADATA_NAME_LIMIT = 120;
const METADATA_TOOL_LIMIT = 16;
const INVENTORY_RECORD_LIMIT = 20;
const INVENTORY_TEXT_LIMIT = 16_000;
const OWNERSHIP_RUNTIME_LIMIT = 36;

const ReasoningSchema = StringEnum(THINKING_LEVELS, {
  description: "Reasoning override for this dispatch; omit to inherit the parent's current level",
});
const DeliverySchema = StringEnum(DELIVERY_MODES, {
  description: "Caller delivery preference where lifecycle permits; root TUI is always async, print and managed nested lineage are always direct, and root RPC defaults async while honoring explicit direct",
});
const ToolsSchema = Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
  maxItems: 256,
  description: "Optional restriction that keeps only these tools from the parent's active capability snapshot; omission inherits every active tool",
});
const MaxDepthSchema = Type.Integer({
  minimum: 2,
  maximum: 3,
  description: "Optional maximum managed delegation depth for this child; may tighten but never raise the inherited ceiling",
});
const MaxChildrenSchema = Type.Integer({
  minimum: 0,
  maximum: 2,
  description: "Optional direct active-child ceiling for this child; may tighten but never raise the inherited nested ceiling",
});

const StartSchema = Type.Object({
  prompt: Type.String({ description: "Complete initial prompt for the clean subagent conversation" }),
  name: Type.Optional(Type.String({ description: "Native Pi session display name" })),
  model: Type.Optional(Type.String({
    minLength: 1,
    description: 'Explicit override in "<provider>/<model>" form, for example "openai-codex/gpt-5.6-luna"; omit to inherit the parent\'s active model',
  })),
  reasoning: Type.Optional(ReasoningSchema),
  cwd: Type.Optional(Type.String({ description: "Initial working directory; fixed for this conversation" })),
  tools: Type.Optional(ToolsSchema),
  maxDepth: Type.Optional(MaxDepthSchema),
  maxChildren: Type.Optional(MaxChildrenSchema),
  delivery: Type.Optional(DeliverySchema),
});

const ContinueSchema = Type.Object({
  id: Type.Integer({ minimum: 1 }),
  prompt: Type.String({ description: "Prompt for the next turn in the existing conversation" }),
  model: Type.Optional(Type.String({
    minLength: 1,
    description: 'Explicit override in "<provider>/<model>" form, for example "openai-codex/gpt-5.6-luna"; omit to inherit the parent\'s active model',
  })),
  reasoning: Type.Optional(ReasoningSchema),
  tools: Type.Optional(ToolsSchema),
  maxDepth: Type.Optional(MaxDepthSchema),
  maxChildren: Type.Optional(MaxChildrenSchema),
  delivery: Type.Optional(DeliverySchema),
});

const SteerSchema = Type.Object({
  id: Type.Integer({ minimum: 1 }),
  message: Type.String({ description: "Instruction delivered at Pi's next safe steering boundary" }),
});

const InterruptSchema = Type.Object({ id: Type.Integer({ minimum: 1 }) });
const ListSchema = Type.Object({});

type StartParams = Static<typeof StartSchema>;
type ContinueParams = Static<typeof ContinueSchema>;

function effectiveDelivery(
  mode: ExtensionContext["mode"],
  lineageDepth: number,
  requested?: DeliveryMode,
): DeliveryMode {
  if (mode === "print" || lineageDepth > 1) return "direct";
  if (mode === "tui") return "async";
  return requested ?? "async";
}

function activeModel(ctx: ExtensionContext): string {
  if (!ctx.model) throw new Error("The parent has no active model to inherit.");
  return `${ctx.model.provider}/${ctx.model.id}`;
}

function selectedModel(value: unknown, ctx: ExtensionContext): string {
  if (value === undefined) return activeModel(ctx);
  if (typeof value !== "string" || !/^[^/\s]+\/\S+$/.test(value)) {
    throw new Error(
      'Explicit subagent model overrides must use "<provider>/<model>". Example: "openai-codex/gpt-5.6-luna".',
    );
  }
  return value;
}

function selectedThinking(value: unknown, inherited: ThinkingLevel): ThinkingLevel {
  if (value === undefined) return inherited;
  if (typeof value !== "string" || !THINKING_LEVEL_SET.has(value)) {
    throw new Error(`Reasoning override must be one of: ${THINKING_LEVELS.join(", ")}.`);
  }
  return value as ThinkingLevel;
}

function oneLine(value: string, limit: number): string {
  return boundText(value.replace(/\s+/g, " ").trim(), limit).text;
}

type ParentVisibleSubagentView = SubagentView & { toolsOmitted?: number };

function parentVisibleView(view: SubagentView): ParentVisibleSubagentView {
  const tools = view.tools?.slice(0, METADATA_TOOL_LIMIT);
  const toolsOmitted = Math.max(0, (view.tools?.length ?? 0) - (tools?.length ?? 0));
  return {
    ...view,
    name: view.name ? boundText(view.name, METADATA_NAME_LIMIT).text : undefined,
    sessionRef: view.sessionRef
      ? boundText(view.sessionRef, SESSION_REFERENCE_LIMIT).text
      : undefined,
    cwd: boundText(view.cwd, METADATA_CWD_LIMIT).text,
    model: boundText(view.model, METADATA_MODEL_LIMIT).text,
    currentTool: view.currentTool ? boundText(view.currentTool, 256).text : undefined,
    preview: view.preview ? boundText(view.preview, 240).text : undefined,
    error: view.error ? boundText(view.error, METADATA_ERROR_LIMIT).text : undefined,
    tools,
    ...(toolsOmitted > 0 ? { toolsOmitted } : {}),
  };
}

function formatView(view: SubagentView): string {
  const visible = parentVisibleView(view);
  const name = visible.name ? ` (${oneLine(visible.name, 60)})` : "";
  const session = visible.sessionRef ? `\n  session: ${oneLine(visible.sessionRef, 260)}` : "";
  const error = visible.error ? `\n  error: ${oneLine(visible.error, 160)}` : "";
  return `#${visible.id}${name}: ${visible.state} — ${oneLine(visible.model, 100)} · reasoning ${visible.thinking} @ ${oneLine(visible.cwd, 180)}${session}${error}`;
}

export function buildConversationList(views: SubagentView[]): {
  text: string;
  details: {
    subagents: ParentVisibleSubagentView[];
    total: number;
    omitted: number;
    textTruncated: boolean;
  };
} {
  const activeViews = views.filter((view) => view.active);
  const active = activeViews.slice(0, INVENTORY_RECORD_LIMIT);
  const activeIds = new Set(active.map((view) => view.id));
  const recentInactive = views
    .filter((view) => !activeIds.has(view.id))
    .slice(-Math.max(0, INVENTORY_RECORD_LIMIT - active.length));
  const selected = [...active, ...recentInactive].sort((left, right) => left.id - right.id);
  const omitted = Math.max(0, views.length - selected.length);
  const subagents = selected.map(parentVisibleView);
  if (subagents.length === 0) {
    return {
      text: "No subagents are known in this parent session.",
      details: { subagents, total: 0, omitted: 0, textTruncated: false },
    };
  }
  const omissionMarker = active.length === activeViews.length
    ? `[${omitted} known conversations omitted; all active entries shown]`
    : `[${omitted} known conversations omitted]`;
  const lines = omitted > 0
    ? [omissionMarker, ...subagents.map(formatView)]
    : subagents.map(formatView);
  const bounded = boundText(lines.join("\n"), INVENTORY_TEXT_LIMIT);
  return {
    text: bounded.text,
    details: {
      subagents,
      total: views.length,
      omitted,
      textTruncated: bounded.truncated,
    },
  };
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

function boundedTerminalText(pong: TerminalResult): {
  text?: string;
  truncated: boolean;
  omittedCharacters: number;
} {
  if (!pong.finalText) return { truncated: false, omittedCharacters: 0 };
  const bounded = boundText(pong.finalText, TERMINAL_TEXT_LIMIT);
  return {
    text: bounded.text,
    truncated: bounded.truncated,
    omittedCharacters: bounded.omittedCharacters,
  };
}

export function buildActiveUi(
  views: SubagentView[],
  now: number,
  ownership: OwnershipRuntime[] = [],
): { lines?: string[]; status?: string } {
  const active = views.filter((view) => view.active);
  if (active.length === 0) return {};
  const nestedCount = ownership.filter((runtime) => runtime.path.length > 1).length;
  const lines = active.map((view) => {
    const elapsed = view.startedAt ? Math.max(0, Math.floor((now - view.startedAt) / 1_000)) : 0;
    const name = view.name ? ` ${oneLine(view.name, 20)}` : "";
    const model = oneLine(view.model, 40);
    const tool = view.currentTool ? ` · ${oneLine(view.currentTool, 80)}` : "";
    const preview = view.preview ? ` · ${oneLine(view.preview, 72)}` : "";
    return `#${view.id}${name} · ${view.state} · ${elapsed}s · ${model} · reasoning ${view.thinking}${tool}${preview}`;
  });
  return {
    lines,
    status: `direct: ${active.length} • nested: ${nestedCount} • total: ${active.length + nestedCount}`,
  };
}

interface OwnershipStatusNode {
  runtimeId: string;
  parentRuntimeId?: string;
  managementId?: number;
  depth: number;
  state: "current" | OwnershipRuntime["state"];
  name?: string;
  model?: string;
  thinking?: ThinkingLevel;
}

export function buildOwnershipStatus(
  depth: number,
  ownership: OwnershipRuntime[],
): { lines: string[]; nodes: OwnershipStatusNode[]; total: number; omitted: number } {
  const visible = ownership.slice(0, OWNERSHIP_RUNTIME_LIMIT);
  const omitted = Math.max(0, ownership.length - visible.length);
  const nodes: OwnershipStatusNode[] = [
    { runtimeId: "self", depth, state: "current" },
    ...visible.map((runtime) => ({
      runtimeId: runtime.path.join("/"),
      parentRuntimeId: runtime.parentPath.length > 0 ? runtime.parentPath.join("/") : "self",
      managementId: runtime.id,
      depth: runtime.depth,
      state: runtime.state,
      name: runtime.name ? oneLine(runtime.name, 80) : undefined,
      model: oneLine(runtime.model, 160),
      thinking: runtime.thinking,
    })),
  ];
  const lines = ["self · depth " + depth + " · current owner"];
  for (const runtime of visible) {
    const runtimeId = runtime.path.join("/");
    const parentRuntimeId = runtime.parentPath.length > 0 ? runtime.parentPath.join("/") : "self";
    const name = runtime.name ? ` (${oneLine(runtime.name, 40)})` : "";
    const indent = "  ".repeat(Math.max(0, runtime.path.length - 1));
    lines.push(
      `${indent}└─ runtime ${runtimeId}${name} · depth ${runtime.depth} · ${runtime.state}`
      + ` · parent ${parentRuntimeId} · owner-local ID #${runtime.id}`
      + ` · ${oneLine(runtime.model, 80)} · reasoning ${runtime.thinking}`,
    );
  }
  if (omitted > 0) lines.push(`[${omitted} additional active runtimes omitted]`);
  return { lines, nodes, total: ownership.length + 1, omitted };
}

type ParentVisibleTerminalResult = TerminalResult & {
  finalText?: string;
  truncated: boolean;
  omittedCharacters: number;
  errorTruncated: boolean;
};

function buildTerminalMessage(
  pong: TerminalResult,
  prefix: "PONG subagent" | "SUBAGENT",
): { content: string; details: ParentVisibleTerminalResult } {
  const final = boundedTerminalText(pong);
  const name = pong.name ? oneLine(pong.name, METADATA_NAME_LIMIT) : undefined;
  const session = boundText(pong.sessionRef, SESSION_REFERENCE_LIMIT);
  const error = pong.error ? boundText(pong.error, PARENT_ERROR_LIMIT) : undefined;
  const heading = `[${prefix} #${pong.id}${name ? ` ${name}` : ""}] ${pong.outcome}`;
  const parts = [heading, `Session: ${session.text}`];
  if (error) parts.push(`Error: ${error.text}`);
  if (final.text) {
    parts.push(
      `Final assistant message${final.truncated ? ` (truncated to ${TERMINAL_TEXT_LIMIT.toLocaleString("en-US")} characters; ${final.omittedCharacters} source characters omitted)` : ""}:\n${final.text}`,
    );
  }
  return {
    content: parts.join("\n\n"),
    details: {
      id: pong.id,
      name,
      outcome: pong.outcome,
      sessionRef: session.text,
      finalText: final.text,
      error: error?.text,
      truncated: final.truncated,
      omittedCharacters: final.omittedCharacters,
      errorTruncated: error?.truncated ?? false,
    },
  };
}

export function buildPongMessage(pong: TerminalResult): ReturnType<typeof buildTerminalMessage> {
  return buildTerminalMessage(pong, "PONG subagent");
}

export function buildDirectResult(pong: TerminalResult): ReturnType<typeof buildTerminalMessage> {
  return buildTerminalMessage(pong, "SUBAGENT");
}

async function withParentVisibleErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw parentVisibleError(error);
  }
}

export default function subagentsExtension(pi: ExtensionAPI) {
  const lineage = readManagedLineage();

  pi.registerMessageRenderer("subagent-pong", (message, { expanded }, theme) => {
    const details = message.details as (TerminalResult & { truncated?: boolean }) | undefined;
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
  let uiMode: ExtensionContext["mode"] | undefined;
  let timer: NodeJS.Timeout | undefined;
  let publishedActiveCount: number | undefined;
  let publishedOwnershipStatus: string | undefined;
  let controller: SubagentController;

  const refreshUi = () => {
    const views = controller.list();
    const activeCount = views.filter((view) => view.active).length;
    const ownership = controller.activeSubtree();
    const presentation = buildActiveUi(views, Date.now(), ownership);
    if (
      ui
      && (uiMode === "tui" || (lineage.depth === 1 && uiMode === "rpc"))
    ) {
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
    if (ui && lineage.depth > 1 && uiMode === "rpc") {
      const ownershipStatus = encodeOwnershipStatus(ownership);
      if (publishedOwnershipStatus !== ownershipStatus) {
        publishedOwnershipStatus = ownershipStatus;
        ui.setStatus(OWNERSHIP_STATUS_KEY, ownershipStatus);
      }
    }
    if (activeCount > 0 && !timer) timer = setInterval(refreshUi, 1_000);
    if (activeCount === 0 && timer) {
      clearInterval(timer);
      timer = undefined;
    }
    if (publishedActiveCount !== activeCount) {
      publishedActiveCount = activeCount;
      publishAsyncActivity(pi, "subagents", activeCount);
    }
  };

  const relayDialog = async (
    request: StandardDialogRequest,
    signal: AbortSignal,
  ): Promise<StandardDialogResult> => {
    const currentUi = ui;
    if (
      !currentUi
      || !(
        (lineage.depth === 1 && uiMode === "tui")
        || (lineage.depth > 1 && uiMode === "rpc")
      )
    ) {
      return cancelledDialogResult();
    }
    return relayStandardDialog(currentUi, request, signal, {
      interactiveEditor: lineage.depth === 1 && uiMode === "tui",
    });
  };

  const sendPong = (pong: TerminalResult) => {
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
    lineage,
    createChild: async (spec) => new RpcSubprocess(
      buildChildInvocation(spec),
      { onDialog: relayDialog },
    ),
    onPong: sendPong,
    onChange: refreshUi,
  });

  const startInput = (params: StartParams, ctx: ExtensionContext): StartInput => ({
    prompt: params.prompt,
    name: params.name,
    model: selectedModel(params.model, ctx),
    thinking: selectedThinking(params.reasoning, pi.getThinkingLevel() as ThinkingLevel),
    cwd: resolve(ctx.cwd, params.cwd ?? "."),
    capabilities: captureCapabilities(pi, params.tools),
    maxDepth: params.maxDepth,
    maxChildren: params.maxChildren,
  });

  const start = (params: StartParams, ctx: ExtensionContext): Promise<SubagentView> => {
    return controller.start(startInput(params, ctx));
  };

  const continuationInput = (params: ContinueParams, ctx: ExtensionContext): ContinueInput => ({
    id: params.id,
    prompt: params.prompt,
    model: selectedModel(params.model, ctx),
    thinking: selectedThinking(params.reasoning, pi.getThinkingLevel() as ThinkingLevel),
    capabilities: captureCapabilities(pi, params.tools),
    maxDepth: params.maxDepth,
    maxChildren: params.maxChildren,
  });

  const continueSubagent = (params: ContinueParams, ctx: ExtensionContext): Promise<SubagentView> => {
    return controller.continue(continuationInput(params, ctx));
  };

  pi.registerTool({
    name: "subagent_start",
    label: "Start Subagent",
    description: 'Start a clean Pi conversation with the parent\'s active tools and required extension providers. Omit tools to inherit the complete active snapshot; an explicit list can only narrow it. Normal skills and repository instructions are discovered for the child cwd. Delivery is enforced from the runtime: root TUI is async, print and managed nested lineage are direct, and root RPC defaults async while honoring explicit direct. A post-boundary dispatch failure leaves acceptance unknown and must not be blindly retried. Optional model or reasoning overrides apply only for an explicit user request; model overrides require "<provider>/<model>".',
    promptSnippet: "Start an independent Pi conversation with a complete prompt",
    promptGuidelines: [
      "Set each subagent_start model or reasoning override only when the user explicitly requests that value for this dispatch; explicit model overrides must use the qualified <provider>/<model> form. Omit every unrequested override so it inherits the parent's active value.",
      "Only after deciding to call subagent_start, inspect PI_PROVIDER, PI_MODEL, and PI_REASONING_LEVEL to identify the parent's active route immediately before dispatch. Do not inspect routing on ordinary turns or merely because this tool is available. Unless the user explicitly requests routing, omit model and reasoning overrides so the dispatch inherits that active route rather than forcing a global or preferred default.",
      "When multiple independent delegations use asynchronous root delivery, issue their subagent_start calls in the same turn so Pi can run them concurrently; do not wait for one pong before starting another.",
      "Delivery is selected mechanically from runtime mode and managed lineage: root TUI is always async, print and managed nested lineage are always direct, and root RPC defaults async while honoring explicit direct.",
      "Use subagent_start delivery=direct only for dependent root RPC work; root TUI ignores conflicting direct input, while managed nested and print calls remain direct even when delivery is omitted or async.",
      "In print or managed nested lineage, subagent_start returns only after the subagent reaches a terminal outcome; inspect that direct result before continuing dependent work.",
      "After an asynchronous root subagent_start accepts a prompt, never wait, sleep, or poll for its result. Continue only useful independent work or end the response so user input and the later pong can be delivered.",
      "If dispatch acceptance is reported as unknown, preserve the native session reference and original cause, inspect available evidence, and do not blindly retry because the prompt may already have produced effects.",
    ],
    parameters: StartSchema,
    async execute(_id, params, signal, _onUpdate, ctx) {
      return withParentVisibleErrors(async () => {
        if (effectiveDelivery(ctx.mode, lineage.depth, params.delivery) === "direct") {
          const pong = await controller.run(startInput(params, ctx), signal);
          const message = buildDirectResult(pong);
          return {
            content: [{ type: "text" as const, text: message.content }],
            details: message.details,
          };
        }

        const view = await start(params, ctx);
        return {
          content: [{
            type: "text" as const,
            text: `Subagent #${view.id} accepted the prompt and is running. Session: ${view.sessionRef}\nDo not wait, sleep, or poll for completion. Start any other useful independent delegation without waiting, then continue independent work or end this response; the pong will arrive later.`,
          }],
          details: parentVisibleView(view),
        };
      });
    },
  });

  pi.registerTool({
    name: "subagent_continue",
    label: "Continue Subagent",
    description: 'Start another turn in a settled conversation known to this parent-session registry, using a fresh snapshot of the parent\'s active tools and required extension providers. Omit tools to inherit the complete active snapshot; an explicit list can only narrow it. Delivery is enforced from the runtime: root TUI is async, print and managed nested lineage are direct, and root RPC defaults async while honoring explicit direct. A post-boundary dispatch failure leaves acceptance unknown and must not be blindly retried. Optional model or reasoning overrides apply only for an explicit user request; model overrides require "<provider>/<model>".',
    promptGuidelines: [
      "Set each subagent_continue model or reasoning override only when the user explicitly requests that value for this dispatch; explicit model overrides must use the qualified <provider>/<model> form. Omit every unrequested override so it inherits the parent's active value.",
      "Only after deciding to call subagent_continue, inspect PI_PROVIDER, PI_MODEL, and PI_REASONING_LEVEL to identify the parent's active route immediately before dispatch. Do not inspect routing on ordinary turns or merely because this tool is available. Unless the user explicitly requests routing, omit model and reasoning overrides so the dispatch inherits that active route rather than forcing a global or preferred default.",
      "Delivery is selected mechanically from runtime mode and managed lineage: root TUI is always async, print and managed nested lineage are always direct, and root RPC defaults async while honoring explicit direct.",
      "Use subagent_continue delivery=direct only for dependent root RPC work; root TUI ignores conflicting direct input, while managed nested and print calls remain direct even when delivery is omitted or async.",
      "In print or managed nested lineage, subagent_continue returns only after the continuation reaches a terminal outcome; inspect that direct result before continuing dependent work.",
      "After an asynchronous root subagent_continue accepts a prompt, never wait, sleep, or poll for its result. Continue only useful independent work or end the response so user input and the later pong can be delivered.",
      "If dispatch acceptance is reported as unknown, preserve the native session reference and original cause, inspect available evidence, and do not blindly retry because the prompt may already have produced effects.",
    ],
    parameters: ContinueSchema,
    async execute(_id, params, signal, _onUpdate, ctx) {
      return withParentVisibleErrors(async () => {
        if (effectiveDelivery(ctx.mode, lineage.depth, params.delivery) === "direct") {
          const pong = await controller.runContinuation(continuationInput(params, ctx), signal);
          const message = buildDirectResult(pong);
          return {
            content: [{ type: "text" as const, text: message.content }],
            details: message.details,
          };
        }

        const view = await continueSubagent(params, ctx);
        return {
          content: [{
            type: "text" as const,
            text: `Subagent #${view.id} accepted the continuation and is running. Session: ${view.sessionRef}\nDo not wait, sleep, or poll for completion. Continue independent work or end this response; the pong will arrive later.`,
          }],
          details: parentVisibleView(view),
        };
      });
    },
  });

  pi.registerTool({
    name: "subagent_steer",
    label: "Steer Subagent",
    description: "Queue an instruction for an active subagent at Pi's safe steering boundary.",
    parameters: SteerSchema,
    async execute(_id, params) {
      return withParentVisibleErrors(async () => {
        const view = await controller.steer(params.id, params.message);
        return {
          content: [{ type: "text" as const, text: `Steering accepted for subagent #${view.id}.` }],
          details: parentVisibleView(view),
        };
      });
    },
  });

  pi.registerTool({
    name: "subagent_interrupt",
    label: "Interrupt Subagent",
    description: "Abort an active subagent turn while preserving its native conversation for continuation.",
    parameters: InterruptSchema,
    async execute(_id, params) {
      return withParentVisibleErrors(async () => {
        const view = await controller.interrupt(params.id);
        return {
          content: [{ type: "text" as const, text: `Interruption requested for subagent #${view.id}.` }],
          details: parentVisibleView(view),
        };
      });
    },
  });

  pi.registerTool({
    name: "subagent_status",
    label: "Subagent Ownership Status",
    description: "Take one on-demand snapshot of this parent's active ownership subtree. It includes self and active descendants with depth, state, parent relationships, and owner-scoped runtime IDs; it never includes transcripts or unrelated sessions and adds no management controls.",
    promptGuidelines: [
      "Use subagent_status only for a user-requested ownership snapshot or a concrete orchestration decision; never poll it for completion.",
    ],
    parameters: ListSchema,
    async execute() {
      const status = buildOwnershipStatus(lineage.depth, controller.activeSubtree());
      return {
        content: [{
          type: "text",
          text: [
            "Active ownership subtree (IDs are scoped to the runtime's direct owner):",
            ...status.lines,
          ].join("\n"),
        }],
        details: status,
      };
    },
  });

  pi.registerTool({
    name: "subagent_list",
    label: "List Subagents",
    description: "Take one snapshot of direct subagent conversations known to this parent session. This is not a completion wait or polling mechanism.",
    promptGuidelines: [
      "Use subagent_list only for a status snapshot needed for a user request or an orchestration decision; never call it repeatedly to poll for completion.",
    ],
    parameters: ListSchema,
    async execute() {
      const list = buildConversationList(controller.list());
      return { content: [{ type: "text", text: list.text }], details: list.details };
    },
  });

  pi.registerCommand("sub", {
    description: "Start a subagent: /sub <prompt> or /sub {JSON options}",
    handler: async (args, ctx) => {
      try {
        const object = parseObject<StartParams>(args);
        const params = object ?? { prompt: args.trim() };
        if (!params.prompt) throw new Error("Usage: /sub <prompt> or /sub {\"prompt\": \"...\"}");
        if (effectiveDelivery(ctx.mode, lineage.depth, params.delivery) === "direct") {
          const result = await controller.run(startInput(params, ctx));
          ctx.ui.notify(buildDirectResult(result).content, "info");
        } else {
          const view = await start(params, ctx);
          ctx.ui.notify(`Subagent #${view.id} started.`, "info");
        }
      } catch (error) {
        ctx.ui.notify(errorText(error), "error");
      }
    },
  });

  pi.registerCommand("subcont", {
    description: "Continue a subagent: /subcont <id> <prompt> or JSON options",
    handler: async (args, ctx) => {
      try {
        const object = parseObject<ContinueParams>(args);
        const params: ContinueParams = object ?? (() => {
          const parsed = parseIdMessage(args, "Usage: /subcont <id> <prompt>");
          return { id: parsed.id, prompt: parsed.message };
        })();
        if (effectiveDelivery(ctx.mode, lineage.depth, params.delivery) === "direct") {
          const result = await controller.runContinuation(continuationInput(params, ctx));
          ctx.ui.notify(buildDirectResult(result).content, "info");
        } else {
          const view = await continueSubagent(params, ctx);
          ctx.ui.notify(`Subagent #${view.id} continued.`, "info");
        }
      } catch (error) {
        ctx.ui.notify(errorText(error), "error");
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
        ctx.ui.notify(errorText(error), "error");
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
        ctx.ui.notify(errorText(error), "error");
      }
    },
  });

  pi.registerCommand("subtree", {
    description: "Show this parent's active ownership subtree",
    handler: async (_args, ctx) => {
      const status = buildOwnershipStatus(lineage.depth, controller.activeSubtree());
      ctx.ui.notify([
        "Active ownership subtree (IDs are scoped to the runtime's direct owner):",
        ...status.lines,
      ].join("\n"), "info");
    },
  });

  pi.registerCommand("sublist", {
    description: "List direct subagents known to this parent session",
    handler: async (_args, ctx) => {
      ctx.ui.notify(buildConversationList(controller.list()).text, "info");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    ui = ctx.ui;
    uiMode = ctx.mode;
    refreshUi();
  });

  pi.on("session_shutdown", async () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    await controller.shutdown();
    if (uiMode === "tui" || (lineage.depth === 1 && uiMode === "rpc")) {
      ui?.setWidget("subagents", undefined);
      ui?.setStatus("subagents", undefined);
    }
    if (lineage.depth > 1 && uiMode === "rpc") {
      ui?.setStatus(OWNERSHIP_STATUS_KEY, undefined);
    }
    publishedOwnershipStatus = undefined;
    ui = undefined;
    uiMode = undefined;
  });
}
