import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("research launch profile", () => {
  it("exposes every tool provider in the exact-URL fallback chain", async () => {
    const justfile = await readFile(new URL("../justfile", import.meta.url), "utf8");
    const recipe = justfile.match(/^research:\n(?<body>(?: {4}.*\n?)+)/m)?.groups?.body;

    expect(recipe).toBeDefined();
    expect(recipe).toContain("browser-fetch/index.ts");
    expect(recipe).toContain("codex-search/index.ts");
    expect(recipe?.match(/browser-fetch\/index\.ts/g)).toHaveLength(1);
    expect(recipe?.match(/codex-search\/index\.ts/g)).toHaveLength(1);
  });
});
