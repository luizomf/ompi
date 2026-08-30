import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { BUILTIN_TOOL_PROVIDER, CAPABILITY_PROBE_STATUS_KEY } from "./capabilities.ts";
import capabilityProbe from "./capability-probe.ts";

describe("child capability probe", () => {
  it("reports the child's exact active tool providers through the RPC UI protocol", () => {
    let sessionStart: ((event: unknown, ctx: ExtensionContext) => void) | undefined;
    const pi = {
      on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => {
        if (event === "session_start") sessionStart = handler;
      },
      getActiveTools: () => ["read", "browser_fetch"],
      getAllTools: () => [
        {
          name: "read",
          sourceInfo: { source: "builtin", path: "<builtin:read>" },
        },
        {
          name: "browser_fetch",
          sourceInfo: { source: "cli", path: "/extensions/browser-fetch/index.ts" },
        },
      ],
    } as unknown as ExtensionAPI;
    const statuses: Array<{ key: string; text?: string }> = [];
    const ctx = {
      mode: "rpc",
      ui: { setStatus: (key: string, text?: string) => statuses.push({ key, text }) },
    } as unknown as ExtensionContext;

    capabilityProbe(pi);
    expect(sessionStart).toBeDefined();
    sessionStart?.({}, ctx);

    expect(statuses).toHaveLength(1);
    expect(statuses[0].key).toBe(CAPABILITY_PROBE_STATUS_KEY);
    expect(JSON.parse(statuses[0].text ?? "")).toEqual({
      version: 1,
      tools: [
        { name: "read", provider: BUILTIN_TOOL_PROVIDER },
        { name: "browser_fetch", provider: "/extensions/browser-fetch/index.ts" },
      ],
    });
  });

  it("is inert outside RPC mode", () => {
    let sessionStart: ((event: unknown, ctx: ExtensionContext) => void) | undefined;
    const pi = {
      on: (_event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => {
        sessionStart = handler;
      },
    } as unknown as ExtensionAPI;
    const setStatus = () => {
      throw new Error("unexpected status");
    };

    capabilityProbe(pi);
    sessionStart?.({}, { mode: "print", ui: { setStatus } } as unknown as ExtensionContext);
  });
});
