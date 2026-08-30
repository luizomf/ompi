import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  BUILTIN_TOOL_PROVIDER,
  CAPABILITY_PROBE_STATUS_KEY,
  type ToolCapability,
} from "./capabilities.ts";

export default function capabilityProbe(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "rpc") return;
    const configured = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
    const tools = pi.getActiveTools().map((name): ToolCapability => {
      const tool = configured.get(name);
      if (!tool) return { name, provider: "<missing-provider>" };
      return {
        name,
        provider: tool.sourceInfo.source === "builtin"
          ? BUILTIN_TOOL_PROVIDER
          : tool.sourceInfo.path,
      };
    });
    ctx.ui.setStatus(
      CAPABILITY_PROBE_STATUS_KEY,
      JSON.stringify({ version: 1, tools }),
    );
  });
}
