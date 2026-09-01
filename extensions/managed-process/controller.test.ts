import { describe, expect, it, vi } from "vitest";
import { ManagedProcessController } from "./controller.ts";

describe("ManagedProcessController", () => {
  it("accepts a shell-free process before completion and preserves literal argv and cwd", async () => {
    const controller = new ManagedProcessController();
    const literal = "value with spaces; $(printf not-a-shell)";

    try {
      const view = await controller.start({
        executable: process.execPath,
        args: [
          "--input-type=module",
          "--eval",
          "process.stdout.write(JSON.stringify({ argv: process.argv.slice(1), cwd: process.cwd() }) + '\\n'); setInterval(() => {}, 1000);",
          literal,
        ],
        cwd: process.cwd(),
      });

      expect(view).toMatchObject({ id: 1, state: "running", active: true, pid: expect.any(Number), pgid: expect.any(Number) });
      expect(controller.list()).toMatchObject([{ id: 1, executable: process.execPath, cwd: process.cwd() }]);

      await expect.poll(() => controller.output(1).stdout.text).toContain(literal);
      expect(controller.output(1).stdout.text).toContain(`"cwd":"${process.cwd()}"`);
    } finally {
      await controller.shutdown();
    }
  });

  it("bounds retained stream memory and each output snapshot", async () => {
    const controller = new ManagedProcessController({ maxStreamBytes: 32, maxOutputBytes: 8 });

    try {
      const view = await controller.start({
        executable: process.execPath,
        args: ["--input-type=module", "--eval", "process.stdout.write('a'.repeat(80) + 'TAIL'); setInterval(() => {}, 1000);"],
        cwd: process.cwd(),
      });

      await expect.poll(() => controller.output(view.id).stdout.observedBytes).toBe(84);
      expect(controller.output(view.id).stdout).toEqual({
        text: "aaaaTAIL",
        retainedBytes: 8,
        observedBytes: 84,
        truncated: true,
      });
      await expect(() => controller.output(view.id, 9)).toThrow("8");
    } finally {
      await controller.shutdown();
    }
  });

  it("keeps decoded binary output within the requested UTF-8 byte limit", async () => {
    const controller = new ManagedProcessController({ maxStreamBytes: 32, maxOutputBytes: 8 });

    try {
      const view = await controller.start({
        executable: process.execPath,
        args: ["--input-type=module", "--eval", "process.stdout.write(Buffer.alloc(32, 255)); setInterval(() => {}, 1000);"],
        cwd: process.cwd(),
      });
      await expect.poll(() => controller.output(view.id).stdout.observedBytes).toBe(32);
      const output = controller.output(view.id).stdout;
      expect(Buffer.byteLength(output.text, "utf8")).toBeLessThanOrEqual(8);
      expect(output.retainedBytes).toBe(Buffer.byteLength(output.text, "utf8"));
      expect(output.truncated).toBe(true);
    } finally {
      await controller.shutdown();
    }
  });

  it("stops an owned process group with escalation and is idempotent after termination", async () => {
    const controller = new ManagedProcessController({ stopGraceMs: 30 });
    let descendantPid = 0;

    try {
      const view = await controller.start({
        executable: process.execPath,
        args: [
          "--input-type=module",
          "--eval",
          "import { spawn } from 'node:child_process'; const child = spawn(process.execPath, ['--eval', 'process.on(\\\"SIGTERM\\\", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' }); process.stdout.write(String(child.pid) + '\\n'); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
        ],
        cwd: process.cwd(),
      });
      await expect.poll(() => controller.output(view.id).stdout.text.trim()).toMatch(/^\d+$/);
      descendantPid = Number(controller.output(view.id).stdout.text.trim());

      const stopped = await controller.stop(view.id);
      expect(stopped).toMatchObject({
        id: view.id,
        active: false,
        state: "signaled",
        exitSignal: "SIGKILL",
        stopReason: "explicit",
        cleanup: {
          status: "completed",
          reason: "explicit",
          sigterm: "sent",
          sigkill: "sent",
          group: "gone",
          leader: "signaled",
          errors: [],
          possibleEscapedDescendants: true,
        },
      });
      await expect.poll(() => {
        try {
          process.kill(descendantPid, 0);
          return false;
        } catch {
          return true;
        }
      }).toBe(true);
      await expect(controller.stop(view.id)).resolves.toEqual(stopped);
    } finally {
      await controller.shutdown();
      if (descendantPid) {
        try { process.kill(descendantPid, "SIGKILL"); } catch { /* already gone */ }
      }
    }
  });

  it("bounds retained terminal history without evicting active processes", async () => {
    const controller = new ManagedProcessController({ maxRecords: 2 });

    try {
      for (let index = 0; index < 3; index += 1) {
        const view = await controller.start({
          executable: process.execPath,
          args: ["--input-type=module", "--eval", `process.exitCode = ${index};`],
          cwd: process.cwd(),
        });
        await expect.poll(() => controller.list().find((item) => item.id === view.id)?.active).toBe(false);
      }

      expect(controller.list().map((view) => [view.id, view.exitCode])).toEqual([[2, 1], [3, 2]]);
    } finally {
      await controller.shutdown();
    }
  });

  it("evicts terminal history immediately so a newly active record remains within the total limit", async () => {
    const controller = new ManagedProcessController({ maxRecords: 2 });

    try {
      for (let index = 0; index < 2; index += 1) {
        const terminal = await controller.start({
          executable: process.execPath,
          args: ["--input-type=module", "--eval", "process.exit(0)"],
          cwd: process.cwd(),
        });
        await expect.poll(() => controller.list().find((item) => item.id === terminal.id)?.active).toBe(false);
      }
      const active = await controller.start({
        executable: process.execPath,
        args: ["--input-type=module", "--eval", "setInterval(() => {}, 1000)"],
        cwd: process.cwd(),
      });

      expect(controller.list()).toHaveLength(2);
      expect(controller.list()).toContainEqual(expect.objectContaining({ id: active.id, active: true }));
      expect(controller.list().map((view) => view.id)).toEqual([2, 3]);
    } finally {
      await controller.shutdown();
    }
  });

  it("rejects cancellation before spawn acceptance and leaves no active process", async () => {
    const controller = new ManagedProcessController();
    const abort = new AbortController();

    try {
      const starting = controller.start({
        executable: process.execPath,
        args: ["--input-type=module", "--eval", "setInterval(() => {}, 1000);"],
        cwd: process.cwd(),
        signal: abort.signal,
      });
      abort.abort();

      await expect(starting).rejects.toThrow("cancelled before spawn acceptance");
      await expect.poll(() => controller.list()[0]?.active).toBe(false);
      expect(controller.list()[0]).toMatchObject({
        stopReason: "startup_cancelled",
        cleanup: {
          status: expect.stringMatching(/^(completed|failed)$/),
          reason: "startup_cancelled",
          possibleEscapedDescendants: true,
        },
      });
    } finally {
      await controller.shutdown();
    }
  });

  it("rejects an in-flight start when session shutdown wins before spawn acceptance", async () => {
    const controller = new ManagedProcessController();
    const starting = controller.start({
      executable: process.execPath,
      args: ["--input-type=module", "--eval", "setInterval(() => {}, 1000);"],
      cwd: process.cwd(),
    });
    const shutdown = controller.shutdown();

    await expect(starting).rejects.toThrow("session shutdown began before spawn acceptance");
    await shutdown;
    expect(controller.list()).toEqual([]);
  });

  it("cleans up remaining process-group members after the leader exits naturally", async () => {
    const controller = new ManagedProcessController({ stopGraceMs: 30 });
    let descendantPid = 0;

    try {
      const view = await controller.start({
        executable: process.execPath,
        args: [
          "--input-type=module",
          "--eval",
          "import { spawn } from 'node:child_process'; const child = spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); child.unref(); process.stdout.write(String(child.pid) + '\\n');",
        ],
        cwd: process.cwd(),
      });
      await expect.poll(() => controller.output(view.id).stdout.text.trim()).toMatch(/^\d+$/);
      descendantPid = Number(controller.output(view.id).stdout.text.trim());
      await expect.poll(() => controller.list()[0]?.state).toBe("exited");
      expect(controller.list()[0]).toMatchObject({
        active: false,
        exitCode: 0,
        stopReason: "leader_exit_cleanup",
        cleanup: {
          status: "completed",
          reason: "leader_exit_cleanup",
          group: "gone",
          leader: "exited",
          possibleEscapedDescendants: true,
        },
      });
      await expect.poll(() => {
        try {
          process.kill(descendantPid, 0);
          return false;
        } catch {
          return true;
        }
      }).toBe(true);
    } finally {
      await controller.shutdown();
      if (descendantPid) {
        try { process.kill(descendantPid, "SIGKILL"); } catch { /* already gone */ }
      }
    }
  });

  it("rejects launches above the active concurrency limit without queuing work", async () => {
    const controller = new ManagedProcessController({ maxActive: 1 });

    try {
      const first = controller.start({
        executable: process.execPath,
        args: ["--input-type=module", "--eval", "setInterval(() => {}, 1000);"],
        cwd: process.cwd(),
      });
      await expect(controller.start({
        executable: process.execPath,
        args: ["--input-type=module", "--eval", "setInterval(() => {}, 1000);"],
        cwd: process.cwd(),
      })).rejects.toThrow("At most 1");
      await expect(first).resolves.toMatchObject({ state: "running" });
      expect(controller.list()).toHaveLength(1);
    } finally {
      await controller.shutdown();
    }
  });

  it("reports startup errors and clears active process state on shutdown", async () => {
    const controller = new ManagedProcessController({ stopGraceMs: 30 });

    await expect(controller.start({ executable: " ", cwd: process.cwd() })).rejects.toThrow("non-empty");
    await expect(controller.start({
      executable: process.execPath,
      cwd: `${process.cwd()}/missing-managed-process-cwd-${process.pid}`,
    })).rejects.toThrow("Failed to start");
    await expect.poll(() => controller.list()[0]?.state).toBe("start_failed");
    await expect(controller.start({
      executable: `${process.cwd()}/missing-managed-process-executable-${process.pid}`,
      cwd: process.cwd(),
    })).rejects.toThrow("Failed to start");

    const active = await controller.start({
      executable: process.execPath,
      args: ["--input-type=module", "--eval", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
      cwd: process.cwd(),
    });
    await controller.shutdown();
    expect(controller.list()).toEqual([]);
    if (active.pid) {
      await expect.poll(() => {
        try {
          process.kill(active.pid!, 0);
          return false;
        } catch {
          return true;
        }
      }).toBe(true);
    }
  });

  it("returns a bounded cleanup report when session shutdown clears active records", async () => {
    const controller = new ManagedProcessController({ stopGraceMs: 20 });
    const view = await controller.start({
      executable: process.execPath,
      args: ["--input-type=module", "--eval", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
      cwd: process.cwd(),
    });

    const report = await controller.shutdown();

    expect(report).toMatchObject({
      processes: [{
        id: view.id,
        state: "signaled",
        stopReason: "session_shutdown",
        cleanup: {
          status: "completed",
          reason: "session_shutdown",
          group: "gone",
          leader: "signaled",
          possibleEscapedDescendants: true,
        },
      }],
    });
    expect(Buffer.byteLength(JSON.stringify(report), "utf8")).toBeLessThanOrEqual(16_000);
    expect(controller.list()).toEqual([]);
  });

  it("does not hang when an escaped descendant keeps the captured pipes open", async () => {
    const controller = new ManagedProcessController({ stopGraceMs: 20 });
    let escapedPid = 0;

    try {
      const view = await controller.start({
        executable: process.execPath,
        args: [
          "--input-type=module",
          "--eval",
          "import { spawn } from 'node:child_process'; const child = spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] }); child.unref(); process.stdout.write(String(child.pid) + '\\n');",
        ],
        cwd: process.cwd(),
      });
      await expect.poll(() => controller.output(view.id).stdout.text.trim()).toMatch(/^\d+$/);
      escapedPid = Number(controller.output(view.id).stdout.text.trim());

      await expect.poll(() => controller.list()[0]?.active, { timeout: 500 }).toBe(false);
      expect(controller.list()[0]).toMatchObject({ state: "exited", exitCode: 0 });
    } finally {
      await controller.shutdown();
      if (escapedPid) {
        try { process.kill(-escapedPid, "SIGKILL"); } catch {
          try { process.kill(escapedPid, "SIGKILL"); } catch { /* already gone */ }
        }
      }
    }
  });

  it("reports process-group permission failures instead of claiming cleanup", async () => {
    const controller = new ManagedProcessController({ stopGraceMs: 20 });
    const view = await controller.start({
      executable: process.execPath,
      args: ["--input-type=module", "--eval", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
      cwd: process.cwd(),
    });
    const originalKill = process.kill.bind(process);
    const denied = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === -(view.pgid ?? 0)) throw denied;
      return originalKill(pid, signal as NodeJS.Signals);
    }) as typeof process.kill);

    try {
      await expect(controller.stop(view.id)).resolves.toMatchObject({
        state: "cleanup_failed",
        stopReason: "explicit",
        error: expect.stringContaining("EPERM"),
        cleanup: {
          status: "failed",
          reason: "explicit",
          sigterm: "failed",
          sigkill: "failed",
          group: "unknown",
          leader: "missing",
          possibleEscapedDescendants: true,
          errors: expect.arrayContaining([
            expect.stringContaining("SIGTERM failed (EPERM)"),
            expect.stringContaining("SIGKILL failed (EPERM)"),
            expect.stringContaining("leader did not report a terminal outcome"),
          ]),
        },
      });
    } finally {
      killSpy.mockRestore();
      if (view.pgid) {
        try { originalKill(-view.pgid, "SIGKILL"); } catch { /* already gone */ }
      }
      await controller.shutdown();
    }
  });

  it("reports a surviving group and missing leader outcome after bounded escalation", async () => {
    const controller = new ManagedProcessController({ stopGraceMs: 20 });
    const view = await controller.start({
      executable: process.execPath,
      args: ["--input-type=module", "--eval", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
      cwd: process.cwd(),
    });
    const originalKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === -(view.pgid ?? 0)) return true;
      return originalKill(pid, signal as NodeJS.Signals);
    }) as typeof process.kill);

    try {
      await expect(controller.stop(view.id)).resolves.toMatchObject({
        state: "cleanup_failed",
        cleanup: {
          status: "failed",
          sigterm: "sent",
          sigkill: "sent",
          group: "survived",
          leader: "missing",
          possibleEscapedDescendants: true,
          errors: expect.arrayContaining([
            expect.stringContaining("remained alive after SIGKILL"),
            expect.stringContaining("did not report a terminal outcome"),
          ]),
        },
      });
    } finally {
      killSpy.mockRestore();
      if (view.pgid) {
        try { originalKill(-view.pgid, "SIGKILL"); } catch { /* already gone */ }
      }
      await controller.shutdown();
    }
  });

  it("rejects argument vectors above the total byte limit", async () => {
    const controller = new ManagedProcessController();
    await expect(controller.start({
      executable: process.execPath,
      args: ["x".repeat(70_000)],
      cwd: process.cwd(),
    })).rejects.toThrow("argument vector");
    await controller.shutdown();
  });

  it("rejects invalid resource limits", () => {
    expect(() => new ManagedProcessController({ maxActive: 0 })).toThrow("maxActive");
    expect(() => new ManagedProcessController({ maxStreamBytes: 0 })).toThrow("maxStreamBytes");
    expect(() => new ManagedProcessController({ maxOutputBytes: 0 })).toThrow("maxOutputBytes");
    expect(() => new ManagedProcessController({ maxStreamBytes: 8, maxOutputBytes: 9 })).toThrow("maxOutputBytes");
    expect(() => new ManagedProcessController({ maxRecords: 0 })).toThrow("maxRecords");
    expect(() => new ManagedProcessController({ stopGraceMs: 0 })).toThrow("stopGraceMs");
    expect(() => new ManagedProcessController({ maxActive: 9 })).toThrow("maxActive");
    expect(() => new ManagedProcessController({ maxStreamBytes: 65_537 })).toThrow("maxStreamBytes");
    expect(() => new ManagedProcessController({ maxOutputBytes: 20_481 })).toThrow("maxOutputBytes");
    expect(() => new ManagedProcessController({ maxRecords: 65 })).toThrow("maxRecords");
  });
});
