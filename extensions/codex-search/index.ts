import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { createBackgroundToolManager } from "./background-tool.ts";
import { runCodexSearch } from "./process.ts";

const MAX_IMAGE_DESTINATION_CHARS = 4_096;

const QuerySchema = Type.Object({
  query: Type.String({
    minLength: 1,
    description: "Focused exact-URL retrieval request, complex research request, or free-form image intent. For images, include only the artifact and iteration directions the user actually wants.",
  }),
  intent: Type.Union([
    Type.Literal("exact_url"),
    Type.Literal("research"),
    Type.Literal("image"),
  ], {
    description: "Required task intent. exact_url, research, and image use GPT-6 Astra with high reasoning.",
  }),
  destination: Type.Optional(Type.String({
    minLength: 1,
    maxLength: MAX_IMAGE_DESTINATION_CHARS,
    description: "Optional final image artifact location, valid only with intent: image. Relative paths are interpreted from the Pi session cwd.",
  })),
});

export type CodexSearchInput = Static<typeof QuerySchema>;

export default function codexSearchExtension(pi: ExtensionAPI) {
  const background = createBackgroundToolManager(pi, {
    namespace: "codex-search",
    statusLabel: "codex_search",
    maxActive: 4,
  });

  pi.registerTool(background.wrapTool({
    name: "codex_search",
    label: "Codex Retrieval + Research + Image",
    description: "Run the codex_search helper for one required task intent. Exact-URL retrieval uses GPT-6 Astra with high reasoning; complex research uses GPT-6 Astra with high reasoning; image generation uses GPT-6 Astra with high reasoning. Every invocation runs in the accepted unsandboxed mode, while callers select neither models, reasoning, nor execution capabilities. A direct image intent authorizes artifact creation and may include a final destination; without one, helper output does not establish final placement or delivery. Retrieval and research results are helper/model-produced output that requires primary-source verification; image output does not receive that reminder. In print mode, the tool waits and returns the result directly. In other modes, it runs asynchronously: the call returns immediately after starting bounded background work and completion may arrive later as one background result only while the owning Pi session remains live. The prompt is sent through stdin without a shell; captured stdout is limited to 48,000 bytes and diagnostics are bounded.",
    promptSnippet: "Run exact-URL retrieval, complex Codex research, or image generation by explicit intent",
    promptGuidelines: [
      "Set exactly one task intent: intent: exact_url for retrieval of one supplied URL, intent: research for complex multi-source comparison or synthesis, or intent: image for image generation. Do not use research merely for simple exact-URL retrieval.",
      "For a specific URL after direct HTTP or browser_fetch fails, use intent: exact_url and require Codex to fetch and extract that exact URL, not merely search for related pages; require it to disclose if it could not access the exact URL.",
      "If exact-URL Codex retrieval fails or cannot prove access, continue the remaining safe stages in order: browser_fetch on https://markdown.new/<absolute-target-URL>, then browser_fetch on https://r.jina.ai/<absolute-target-URL>. Do not restart the chain from a transformed fallback URL.",
      "A helper/model-produced answer, snippets, or related pages do not prove exact-URL access. If the safe chain is exhausted, explicitly state that you could not access or verify the URL and must not invent page-specific facts or imply that you read it.",
      "Treat markdown.new and r.jina.ai as third-party disclosure boundaries. Do not submit URLs containing credentials, signed or private query parameters, or confidential identifiers to them without explicit user authorization.",
      "For complex source comparison or synthesis, use intent: research, request URLs or citations when relevant, and verify primary sources separately.",
      "A direct intent: image request authorizes creation of that image artifact. Forward the user's free-form intent without a rigid visual template or mandatory post-processing. Supply destination only when the user or calling task has chosen a final image location. Without destination, inspect any artifact reported by the helper and place it as the calling task requires; do not claim final delivery from helper output alone.",
      "The exact_url and research intents do not authorize unrelated workspace mutation even though every helper invocation is mechanically unsandboxed. Keep those requests limited to retrieval and research.",
      "When multiple codex_search calls or other calls are independently useful, start them in the same turn so Pi can run them concurrently; outside print mode, do not wait for one result before starting another.",
      "In print mode, codex_search returns its result directly; inspect it before continuing dependent work.",
      "Outside print mode, after codex_search starts a background operation, never wait, sleep, or poll for its result. Continue only useful independent work or end the response; a later result can be delivered only while the owning Pi session remains live. After image generation starts, do not inspect, move, or modify its potential artifact paths until that live session delivers the result.",
    ],
    parameters: QuerySchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (params.destination !== undefined && params.intent !== "image") {
        throw new Error("destination is valid only with intent: image.");
      }
      if (params.destination !== undefined && !params.destination.trim()) {
        throw new Error("Image destination must not be empty.");
      }
      if (params.destination !== undefined && params.destination.length > MAX_IMAGE_DESTINATION_CHARS) {
        throw new Error(`Image destination must not exceed ${MAX_IMAGE_DESTINATION_CHARS} characters.`);
      }

      let result;
      try {
        result = await runCodexSearch(
          params.query,
          ctx.cwd,
          params.intent,
          params.destination,
          signal,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const nextAction = params.intent === "exact_url"
          ? "For exact-URL retrieval, continue the remaining safe fallback stages in order: browser_fetch on https://markdown.new/<absolute-target-URL>, then browser_fetch on https://r.jina.ai/<absolute-target-URL>. Do not restart the chain from a transformed fallback URL or infer page contents from this failed attempt."
          : params.intent === "image"
            ? "For image generation, do not claim that an artifact was created or delivered. Correct the reported problem or use another explicitly authorized image path when useful or available."
            : "For research, continue with another appropriate source or tool when useful or available and preserve primary-source verification.";
        throw new Error([
          message,
          "IMPORTANT: You MUST report this codex_search failure in your next user-facing response. You MUST NOT stop or abandon the task solely because codex_search failed.",
          nextAction,
        ].join("\n\n"), { cause: error });
      }

      const outputKind = params.intent === "exact_url"
        ? "exact-URL retrieval"
        : params.intent === "research"
          ? "complex research"
          : "image";
      let text = result.stdout.trimEnd();
      if (!text) {
        text = params.intent === "image"
          ? "codex_search completed without returning image helper output; artifact creation and final delivery are not confirmed."
          : `codex_search completed without returning ${outputKind} helper/model output.`;
      }
      if (result.stdoutTruncated) {
        text += `\n\n[${params.intent === "image" ? "Image helper" : "Helper/model"} output truncated to 48,000 bytes.]`;
      }

      if (params.intent === "image") {
        text += params.destination === undefined
          ? "\n\n[No final image destination was supplied. This is helper output, not confirmation of final placement or delivery. The calling agent must inspect any reported artifact and place it as the task requires.]"
          : "\n\n[The supplied final image destination was passed to the helper. Treat the helper output above as the source of truth for whether creation succeeded.]";
      } else {
        text += `\n\n[Reminder: this is codex_search helper/model-produced ${outputKind} output, not a verified primary source. Verify cited URLs and primary sources before relying on it.]`;
      }

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
