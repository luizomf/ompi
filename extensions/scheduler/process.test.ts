import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runBqProcess } from "./process.ts";

function invocation(script: string) {
  return {
    command: process.execPath,
    args: ["--input-type=module", "--eval", script],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH },
  };
}

describe("bq process adapter", () => {
  it("captures bounded unmodified acceptance streams and exit status without a shell", async () => {
    const result = await runBqProcess(invocation(
      "process.stdout.write('accepted\\n' + 'o'.repeat(20000)); process.stderr.write('e'.repeat(10000)); process.exitCode = 7;",
    ));

    expect(result).toEqual({
      code: 7,
      signal: null,
      stdout: `accepted\n${"o".repeat(15_991)}`,
      stderr: "e".repeat(8_000),
      stdoutTruncated: true,
      stderrTruncated: true,
      cancelled: false,
    });
  });

  it("keeps multibyte bq output within the byte limit", async () => {
    const result = await runBqProcess(invocation("process.stdout.write('€'.repeat(6000));"));

    expect(result.stdoutTruncated).toBe(true);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(16_000);
  });

  it("reports when the bq executable cannot start", async () => {
    await expect(runBqProcess({
      ...invocation(""),
      command: join(tmpdir(), `missing-bq-${process.pid}`),
    })).rejects.toThrow("Failed to start bq");
  });
});
