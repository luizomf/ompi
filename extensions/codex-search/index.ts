import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { createBackgroundToolManager } from "./background-tool.ts";
import { runCodexSearch } from "./process.ts";

const QuerySchema = Type.Object({
  query: Type.String({
    minLength: 1,
    description: "Focused research request. Ask for source URLs or citations when they are relevant.",
  }),
});

export type CodexSearchInput = Static<typeof QuerySchema>;

export default function codexSearchExtension(pi: ExtensionAPI) {
  const background = createBackgroundToolManager(pi, {
    namespace: "codex-search",
    maxActive: 4,
  });

  pi.registerTool(background.wrapReadOnly({
    name: "codex_search",
    label: "Codex Search",
    description: "Run the existing codex_search helper asynchronously as a fallback when ordinary browser fetching is blocked or insufficient, or as an independent second research path. Returns immediately after starting bounded background work; completion arrives later as one background result. Model-produced research is not itself a verified primary source: ask for URLs or citations in the query when relevant, then verify those sources separately. The query is sent through stdin without a shell; captured research output is limited to 48,000 bytes.",
    promptSnippet: "Start asynchronous Codex web research as a fallback or independent second research path",
    promptGuidelines: [
      "Use codex_search when ordinary browser fetching is blocked or insufficient, or for an independent second research path; request URLs or citations when relevant and verify primary sources separately.",
      "After codex_search starts background research, never wait, sleep, or poll for its result. Continue only useful work independent of that result; otherwise end the response so the later background result can be delivered.",
    ],
    parameters: QuerySchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = await runCodexSearch(params.query, ctx.cwd, signal);
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
