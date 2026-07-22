import { describe, expect, it } from "vitest";
import { buildChildInvocation } from "./rpc-child.ts";

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

describe("buildChildInvocation", () => {
  it("creates a clean native Pi launch with inherited environment and explicit user skills", () => {
    const invocation = buildChildInvocation({
      cwd: "/tmp/worktree",
      model: "anthropic/claude",
      thinking: "high",
      tools: ["read", "bash"],
      name: "audit",
    }, "/home/user/.pi/agent/skills");

    expect(invocation.cwd).toBe("/tmp/worktree");
    expect(invocation.env.PATH).toBe(process.env.PATH);
    expect(invocation.args).toContain("--no-extensions");
    expect(invocation.args).toContain("--no-skills");
    expect(valueAfter(invocation.args, "--skill")).toBe("/home/user/.pi/agent/skills");
    expect(valueAfter(invocation.args, "--append-system-prompt")).toContain(
      "You are a worker subagent",
    );
    expect(valueAfter(invocation.args, "--append-system-prompt")).toContain(
      "Do not spawn or delegate to other agents",
    );
    expect(valueAfter(invocation.args, "--model")).toBe("anthropic/claude");
    expect(valueAfter(invocation.args, "--thinking")).toBe("high");
    expect(valueAfter(invocation.args, "--tools")).toBe("read,bash");
    expect(valueAfter(invocation.args, "--name")).toBe("audit");
    expect(invocation.args).not.toContain("--no-context-files");
  });

  it("resumes the native session without trying to rename it or restricting default tools", () => {
    const invocation = buildChildInvocation({
      cwd: "/tmp/worktree",
      model: "openai/gpt",
      thinking: "low",
      name: "existing",
      session: "/sessions/child.jsonl",
    }, "/skills");

    expect(valueAfter(invocation.args, "--session")).toBe("/sessions/child.jsonl");
    expect(invocation.args).not.toContain("--name");
    expect(invocation.args).not.toContain("--tools");
  });
});
