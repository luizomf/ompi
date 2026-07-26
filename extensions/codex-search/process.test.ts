import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildCodexSearchRequest,
  runProcess,
} from "./process.ts";

const node = process.execPath;

function nodeRequest(script: string, overrides: Partial<Parameters<typeof runProcess>[0]> = {}) {
  return {
    command: node,
    args: ["--input-type=module", "--eval", script],
    input: "",
    cwd: process.cwd(),
    timeoutMs: 1_000,
    maxStdoutBytes: 1_024,
    maxStderrBytes: 1_024,
    ...overrides,
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function runParentLeavingDescendant(
  exitCode: number,
  descendantStdio: "ignore" | "inherit",
): Promise<string | undefined> {
  const directory = await mkdtemp(join(tmpdir(), "ompi-codex-search-exit-"));
  const pidFile = join(directory, "grandchild.pid");
  let grandchildPid: number | undefined;
  const grandchildScript = [
    "const { writeFileSync } = require('node:fs');",
    "process.on('SIGTERM', () => {});",
    `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const parentScript = [
    "import { existsSync } from 'node:fs';",
    "import { spawn } from 'node:child_process';",
    `spawn(process.execPath, ['--eval', ${JSON.stringify(grandchildScript)}], { stdio: ${JSON.stringify(descendantStdio)} });`,
    `const timer = setInterval(() => { if (existsSync(${JSON.stringify(pidFile)})) { clearInterval(timer); process.exit(${exitCode}); } }, 5);`,
  ].join("\n");
  let failure: string | undefined;

  try {
    try {
      await runProcess(nodeRequest(parentScript, { timeoutMs: 2_000 }));
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    grandchildPid = Number(await readFile(pidFile, "utf8"));
    await vi.waitFor(() => expect(isAlive(grandchildPid!)).toBe(false));
    return failure;
  } finally {
    if (grandchildPid && isAlive(grandchildPid)) process.kill(grandchildPid, "SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
}

describe("codex_search process wrapper", () => {
  it("builds a fixed shell-free invocation with the query on stdin", () => {
    const signal = new AbortController().signal;
    const request = buildCodexSearchRequest("find primary sources", "/repo", signal);

    expect(request).toMatchObject({
      command: "codex_search",
      args: ["-"],
      input: "find primary sources",
      cwd: "/repo",
      signal,
    });
    expect(request).not.toHaveProperty("shell");
  });

  it("passes shell syntax through stdin as inert text", async () => {
    const query = "$(touch /tmp/should-not-run); `echo nope`; && rm -rf /";
    const result = await runProcess(nodeRequest(
      "const chunks=[]; for await (const chunk of process.stdin) chunks.push(chunk); process.stdout.write(Buffer.concat(chunks));",
      { input: query },
    ));

    expect(result.stdout).toBe(query);
    expect(result.code).toBe(0);
  });

  it("bounds stdout and stderr while continuing to drain both streams", async () => {
    const result = await runProcess(nodeRequest(
      "process.stdout.write('o'.repeat(100)); process.stderr.write('e'.repeat(100));",
      { maxStdoutBytes: 12, maxStderrBytes: 9 },
    ));

    expect(result.stdout).toBe("o".repeat(12));
    expect(result.stderr).toBe("e".repeat(9));
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(true);
  });

  it("reports process startup failure", async () => {
    await expect(runProcess({
      ...nodeRequest(""),
      command: join(tmpdir(), `missing-codex-search-${process.pid}`),
    })).rejects.toThrow("Failed to start");
  });

  it("reports a nonzero exit with bounded diagnostics", async () => {
    await expect(runProcess(nodeRequest(
      "process.stdout.write('partial'); process.stderr.write('x'.repeat(30)); process.exitCode=7;",
      { maxStderrBytes: 8 },
    ))).rejects.toThrow(/exited with code 7[\s\S]*xxxxxxxx/);
  });

  it("cleans up a successful parent's descendant that inherits output pipes", async () => {
    expect(await runParentLeavingDescendant(0, "inherit")).toBeUndefined();
  });

  it("cleans up a failed parent's descendant with ignored stdio", async () => {
    expect(await runParentLeavingDescendant(7, "ignore")).toContain("exited with code 7");
  });

  it("times out and terminates the process", async () => {
    await expect(runProcess(nodeRequest(
      "setInterval(() => {}, 1_000);",
      { timeoutMs: 20 },
    ))).rejects.toThrow("timed out after 20ms");
  });

  it("cancels and terminates the child process group", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ompi-codex-search-"));
    const pidFile = join(directory, "grandchild.pid");
    const controller = new AbortController();
    let grandchildPid: number | undefined;
    const grandchildScript = [
      "const { writeFileSync } = require('node:fs');",
      "process.on('SIGTERM', () => {});",
      `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const script = [
      "import { spawn } from 'node:child_process';",
      `spawn(process.execPath, ['--eval', ${JSON.stringify(grandchildScript)}], { stdio: 'ignore' });`,
      "setInterval(() => {}, 1000);",
    ].join("\n");

    try {
      const running = runProcess(nodeRequest(script, {
        signal: controller.signal,
        timeoutMs: 5_000,
      }));
      await vi.waitFor(async () => expect(await readFile(pidFile, "utf8")).toMatch(/^\d+$/));
      grandchildPid = Number(await readFile(pidFile, "utf8"));

      controller.abort();
      await expect(running).rejects.toThrow("cancelled");
      await vi.waitFor(() => expect(isAlive(grandchildPid!)).toBe(false));
    } finally {
      if (grandchildPid && isAlive(grandchildPid)) process.kill(grandchildPid, "SIGKILL");
      await rm(directory, { recursive: true, force: true });
    }
  });
});
