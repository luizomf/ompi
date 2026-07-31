import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { createBackgroundToolManager } from "./background-tool.ts";
import { runCodexSearch } from "./process.ts";

const QuerySchema = Type.Object({
  query: Type.String({
    minLength: 1,
    description: "Focused research request. Ask for source URLs or citations when they are relevant.",
  }),
  effort: Type.Optional(Type.Union([
    Type.Literal("quick"),
    Type.Literal("research"),
  ], {
    description: "Semantic effort profile. Omit to use quick. The helper owns the profile's default model and reasoning.",
  })),
  write: Type.Optional(Type.Boolean({
    description: "Use Codex workspace-write with the Pi session cwd as the primary workspace for this call. Omit or use false for read-only research.",
  })),
  yolo: Type.Optional(Type.Boolean({
    description: "Explicitly bypass Codex approvals and sandboxing for this call. Extremely dangerous; use only when the user specifically requests it.",
  })),
});

export type CodexSearchInput = Static<typeof QuerySchema>;

export default function codexSearchExtension(pi: ExtensionAPI) {
  const background = createBackgroundToolManager(pi, {
    namespace: "codex-search",
    statusLabel: "codex_search",
    maxActive: 4,
  });

  pi.registerTool(background.wrapReadOnly({
    name: "codex_search",
    label: "Codex Search",
    description: "Run the codex_search helper asynchronously for blocked-page fallback, independent web research, or another bounded Codex task. The fixed quick/research profiles isolate model and reasoning selection from the host Codex config. Calls are read-only by default; write explicitly selects workspace-write with the Pi session cwd as its primary workspace, and yolo is an explicit unsandboxed opt-in. Returns immediately after starting bounded background work; completion arrives later as one background result. Model-produced research is not itself a verified primary source: verify cited URLs and primary sources before relying on it. The prompt is sent through stdin without a shell; captured output is limited to 48,000 bytes.",
    promptSnippet: "Start asynchronous Codex web research as a fallback or independent second research path",
    promptGuidelines: [
      "Use codex_search when ordinary browser fetching is blocked or insufficient, or for an independent second research path; request URLs or citations when relevant and verify primary sources separately.",
      "Omit write and yolo unless the user explicitly requests the capability. write uses workspace-write with the Pi session cwd as its primary workspace; yolo bypasses both approvals and sandboxing and is extremely dangerous.",
      "When multiple codex_search calls or other background research calls are independently useful, start them in the same turn so Pi can run them concurrently; do not wait for one result before starting another.",
      "After codex_search starts background research, never wait, sleep, or poll for its result. Continue only useful work independent of that result; otherwise end the response so the later background result can be delivered.",
    ],
    parameters: QuerySchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      let result;
      try {
        result = await runCodexSearch(params.query, ctx.cwd, params.effort ?? "quick", {
          write: params.write,
          yolo: params.yolo,
        }, signal);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error([
          message,
          "IMPORTANT: You MUST report this codex_search failure in your next user-facing response. You MUST NOT stop or abandon the task solely because codex_search failed; continue with another appropriate tool when useful or available.",
        ].join("\n\n"));
      }
      let text = result.stdout.trimEnd();
      if (!text) text = "codex_search completed without returning research output.";
      if (result.stdoutTruncated) text += "\n\n[Research output truncated to 48,000 bytes.]";
      text += "\n\n[Reminder: this is model-produced research, not a verified primary source. Verify cited URLs and primary sources before relying on it.]";

      return {
        content: [{ type: "text", text }],
        details: {
          outputTruncated: result.stdoutTruncated,
          diagnosticsTruncated: result.stderrTruncated,
        },
      };
    },
  }));
}
