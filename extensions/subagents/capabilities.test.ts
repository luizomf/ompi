import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_TOOL_PROVIDER,
  assertCapabilityMatch,
  captureCapabilities,
} from "./capabilities.ts";

function setupCapabilities(active: string[], tools: Array<{ name: string; source: string; path: string }>) {
  return {
    getActiveTools: () => [...active],
    getAllTools: () => tools.map((tool) => ({
      name: tool.name,
      description: `${tool.name} description`,
      parameters: {},
      sourceInfo: {
        source: tool.source,
        path: tool.path,
        scope: "temporary",
        origin: "top-level",
      },
    })),
  } as unknown as ExtensionAPI;
}

describe("subagent capability snapshots", () => {
  it("captures active built-in and extension tools with the required provider", () => {
    const pi = setupCapabilities(
      ["read", "browser_fetch"],
      [
        { name: "read", source: "builtin", path: "<builtin:read>" },
        { name: "write", source: "builtin", path: "<builtin:write>" },
        { name: "browser_fetch", source: "cli", path: "/extensions/browser-fetch/index.ts" },
      ],
    );

    expect(captureCapabilities(pi)).toEqual({
      tools: [
        { name: "read", provider: BUILTIN_TOOL_PROVIDER },
        { name: "browser_fetch", provider: "/extensions/browser-fetch/index.ts" },
      ],
      extensionPaths: ["/extensions/browser-fetch/index.ts"],
    });
  });

  it("allows restrictions to keep only parent-active tools, including none", () => {
    const pi = setupCapabilities(
      ["read", "browser_fetch"],
      [
        { name: "read", source: "builtin", path: "<builtin:read>" },
        { name: "browser_fetch", source: "cli", path: "/extensions/browser-fetch/index.ts" },
      ],
    );

    expect(captureCapabilities(pi, ["read", "read"]).tools).toEqual([
      { name: "read", provider: BUILTIN_TOOL_PROVIDER },
    ]);
    expect(captureCapabilities(pi, [])).toEqual({ tools: [], extensionPaths: [] });
    expect(() => captureCapabilities(pi, ["write"])).toThrow(
      "Restrictions can only keep tools active in the parent. Unavailable: write.",
    );
  });

  it("bounds diagnostics when many restrictions are unavailable", () => {
    const pi = setupCapabilities([], []);
    const unavailable = Array.from({ length: 12 }, (_, index) => `missing_${index + 1}`);

    expect(() => captureCapabilities(pi, unavailable)).toThrow(
      "Unavailable: missing_1, missing_2, missing_3, missing_4, missing_5, missing_6, missing_7, missing_8, and 4 more.",
    );
  });

  it("rejects an active tool whose provider cannot be loaded", () => {
    const pi = setupCapabilities(
      ["sdk_tool"],
      [{ name: "sdk_tool", source: "sdk", path: "<sdk:sdk_tool>" }],
    );

    expect(() => captureCapabilities(pi)).toThrow(
      'Active tool "sdk_tool" cannot be inherited because provider "<sdk:sdk_tool>" is not a loadable extension path.',
    );
  });

  it("diagnoses missing, unexpected, and wrong-provider child capabilities", () => {
    const promised = {
      tools: [
        { name: "read", provider: BUILTIN_TOOL_PROVIDER },
        { name: "browser_fetch", provider: "/expected/browser.ts" },
      ],
      extensionPaths: ["/expected/browser.ts"],
    };

    expect(() => assertCapabilityMatch(promised, {
      tools: [
        { name: "read", provider: "/wrong/read.ts" },
        { name: "extra", provider: BUILTIN_TOOL_PROVIDER },
      ],
      extensionPaths: [],
    })).toThrow(
      "read (expected builtin, got /wrong/read.ts); browser_fetch (expected /expected/browser.ts, missing); unexpected extra (builtin)",
    );
  });
});
