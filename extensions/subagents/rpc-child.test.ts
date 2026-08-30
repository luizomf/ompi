import { describe, expect, it } from "vitest";
import { BUILTIN_TOOL_PROVIDER } from "./capabilities.ts";
import { buildChildInvocation } from "./rpc-child.ts";

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

function valuesAfter(args: string[], flag: string): string[] {
  return args.flatMap((value, index) => value === flag ? [args[index + 1]] : []);
}

describe("buildChildInvocation", () => {
  it("creates a clean Pi launch with exact tools, required providers, and normal resource discovery", () => {
    const invocation = buildChildInvocation({
      cwd: "/tmp/worktree",
      model: "anthropic/claude",
      thinking: "high",
      capabilities: {
        tools: [
          { name: "read", provider: BUILTIN_TOOL_PROVIDER },
          { name: "browser_fetch", provider: "/extensions/browser-fetch/index.ts" },
        ],
        extensionPaths: ["/extensions/browser-fetch/index.ts"],
      },
      name: "audit",
    });

    expect(invocation.cwd).toBe("/tmp/worktree");
    expect(invocation.env.PATH).toBe(process.env.PATH);
    expect(invocation.args).toContain("--no-extensions");
    expect(valuesAfter(invocation.args, "--extension")).toEqual([
      "/extensions/browser-fetch/index.ts",
      expect.stringMatching(/capability-probe\.ts$/),
    ]);
    expect(invocation.args).not.toContain("--no-skills");
    expect(invocation.args).not.toContain("--skill");
    expect(invocation.args).not.toContain("--append-system-prompt");
    expect(valueAfter(invocation.args, "--model")).toBe("anthropic/claude");
    expect(valueAfter(invocation.args, "--thinking")).toBe("high");
    expect(valueAfter(invocation.args, "--tools")).toBe("read,browser_fetch");
    expect(valueAfter(invocation.args, "--name")).toBe("audit");
    expect(invocation.args).not.toContain("--no-context-files");
  });

  it("resumes only the native session and can preserve an explicitly empty snapshot", () => {
    const invocation = buildChildInvocation({
      cwd: "/tmp/worktree",
      model: "openai/gpt",
      thinking: "low",
      capabilities: { tools: [], extensionPaths: [] },
      name: "existing",
      session: "/sessions/child.jsonl",
    });

    expect(valueAfter(invocation.args, "--session")).toBe("/sessions/child.jsonl");
    expect(invocation.args).not.toContain("--name");
    expect(invocation.args).toContain("--no-tools");
    expect(invocation.args).not.toContain("--tools");
  });
});
