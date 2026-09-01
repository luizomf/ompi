import {
  keyHint,
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import { publishAsyncActivity } from "./async-activity.ts";

export interface BackgroundOperationView {
  id: number;
  toolName: string;
  active: boolean;
  startedAt: number;
}

export interface BackgroundCompletionDetails {
  id: number;
  toolName: string;
  outcome: "completed" | "failed";
  resultDetails?: unknown;
  error?: string;
}

export interface BackgroundToolManagerOptions {
  namespace: string;
  statusLabel?: string;
  maxActive?: number;
  now?: () => number;
}

export interface BackgroundToolManager {
  wrapTool<TParams extends TSchema, TDetails>(
    tool: ToolDefinition<TParams, TDetails>,
  ): ToolDefinition<TParams, BackgroundOperationView | TDetails>;
}

function resultText(result: AgentToolResult<unknown>): string {
  return result.content
    .map((item) => item.type === "text"
      ? item.text
      : "[Non-text output omitted from this background result.]")
    .join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createBackgroundToolManager(
  pi: ExtensionAPI,
  options: BackgroundToolManagerOptions,
): BackgroundToolManager {
  if (!/^[a-z0-9-]+$/.test(options.namespace)) {
    throw new Error("Background tool namespace must contain only lowercase letters, numbers, and hyphens.");
  }
  const maxActive = options.maxActive ?? 8;
  if (!Number.isInteger(maxActive) || maxActive < 1) {
    throw new Error("Background tool maxActive must be a positive integer.");
  }
  const now = options.now ?? Date.now;
  const customType = `background-${options.namespace}`;
  const statusLabel = options.statusLabel ?? options.namespace;

  pi.registerMessageRenderer(customType, (message, { expanded }, theme) => {
    const details = message.details as BackgroundCompletionDetails | undefined;
    const heading = details
      ? `[BACKGROUND #${details.id} ${details.toolName}] ${details.outcome}; delivered to its owning live Pi session`
      : `[BACKGROUND ${options.namespace}]`;
    const collapsed = [heading];
    if (details?.error) collapsed.push(`Error: ${details.error}`);
    collapsed.push(keyHint("app.tools.expand", "to expand"));
    const content = expanded && typeof message.content === "string"
      ? message.content
      : collapsed.join("\n");
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(content, 0, 0));
    return box;
  });

  let nextId = 1;
  let closed = false;
  let ui: ExtensionContext["ui"] | undefined;
  const active = new Map<number, AbortController>();
  const refreshUi = () => {
    const status = active.size > 0 ? `${statusLabel}: ${active.size}` : undefined;
    ui?.setStatus(customType, status ? ui.theme.fg("success", status) : undefined);
    publishAsyncActivity(pi, customType, active.size);
  };

  pi.on("session_start", (_event, ctx) => {
    ui = ctx.ui;
    refreshUi();
  });

  pi.on("session_shutdown", () => {
    closed = true;
    for (const controller of active.values()) controller.abort();
    active.clear();
    refreshUi();
    ui = undefined;
  });

  return {
    wrapTool<TParams extends TSchema, TDetails>(
      tool: ToolDefinition<TParams, TDetails>,
    ): ToolDefinition<TParams, BackgroundOperationView | TDetails> {
      if (tool.renderResult) {
        throw new Error(`${tool.name} has a custom result renderer and is not eligible for background wrapping.`);
      }
      const { execute, renderResult: _renderResult, ...definition } = tool;
      return {
        ...definition,
        async execute(toolCallId, params, signal, onUpdate, ctx: ExtensionContext) {
          if (signal?.aborted) throw new Error(`${tool.name} was cancelled before background work started.`);
          if (closed) throw new Error(`The ${options.namespace} background tool manager has shut down.`);
          if (active.size >= maxActive) {
            throw new Error(`At most ${maxActive} ${options.namespace} background operations may be active.`);
          }
          const id = nextId++;
          if (ctx.mode === "print") {
            const controller = new AbortController();
            const abort = () => controller.abort();
            signal?.addEventListener("abort", abort, { once: true });
            active.set(id, controller);
            refreshUi();
            try {
              return await execute.call(tool, toolCallId, params, controller.signal, onUpdate, ctx);
            } finally {
              signal?.removeEventListener("abort", abort);
              active.delete(id);
              refreshUi();
            }
          }
          const view: BackgroundOperationView = {
            id,
            toolName: tool.name,
            active: true,
            startedAt: now(),
          };
          const controller = new AbortController();
          active.set(id, controller);
          refreshUi();
          let operation: Promise<AgentToolResult<TDetails>>;
          try {
            operation = execute.call(tool, toolCallId, params, controller.signal, undefined, ctx);
          } catch (error) {
            operation = Promise.reject(error);
          }
          void operation.then(
            (result) => {
              if (!active.delete(id) || closed) return;
              refreshUi();
              const text = resultText(result);
              pi.sendMessage({
                customType,
                content: [
                  `[BACKGROUND #${id} ${tool.name}] completed`,
                  "This result was delivered to its owning live Pi session.",
                  text,
                ].filter(Boolean).join("\n\n"),
                display: true,
                details: {
                  id,
                  toolName: tool.name,
                  outcome: "completed",
                  resultDetails: result.details,
                } satisfies BackgroundCompletionDetails,
              }, { deliverAs: "followUp", triggerTurn: true });
            },
            (error) => {
              if (!active.delete(id) || closed) return;
              refreshUi();
              const message = errorMessage(error);
              pi.sendMessage({
                customType,
                content: `[BACKGROUND #${id} ${tool.name}] failed\n\nThis result was delivered to its owning live Pi session.\n\nError: ${message}`,
                display: true,
                details: { id, toolName: tool.name, outcome: "failed", error: message } satisfies BackgroundCompletionDetails,
              }, { deliverAs: "followUp", triggerTurn: true });
            },
          );
          return {
            content: [{
              type: "text",
              text: `Background operation #${id} (${tool.name}) started. Its result can be delivered later only while the owning Pi session remains live; session shutdown aborts the work and suppresses delivery. Do not wait, sleep, or poll for completion. If another independent, non-overlapping background call is useful, start it without waiting for this result.`,
            }],
            details: view,
          };
        },
      };
    },
  };
}
