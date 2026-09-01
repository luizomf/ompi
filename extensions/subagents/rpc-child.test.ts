import { describe, expect, it, vi } from "vitest";
import { initTheme, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { BUILTIN_TOOL_PROVIDER } from "./capabilities.ts";
import { PromptTransportError } from "./controller.ts";
import {
  parseStandardDialogRequest,
  relayStandardDialog,
  STANDARD_DIALOG_METHODS,
} from "./dialogs.ts";
import {
  OWNERSHIP_STATUS_KEY,
  encodeOwnershipStatus,
  parseOwnershipStatus,
} from "./ownership.ts";
import { buildChildInvocation, RpcSubprocess } from "./rpc-child.ts";

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

function valuesAfter(args: string[], flag: string): string[] {
  return args.flatMap((value, index) => value === flag ? [args[index + 1]] : []);
}

const DIALOG_CHILD_SCRIPT = String.raw`
  let buffer = "";
  let commandId;
  const dialog = JSON.parse(process.env.DIALOG_REQUEST);
  const deadline = setTimeout(() => process.exit(2), 1000);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const message = JSON.parse(line);
      if (message.type === "trigger") {
        commandId = message.id;
        process.stdout.write(JSON.stringify(dialog) + "\n");
      } else if (message.type === "extension_ui_response") {
        clearTimeout(deadline);
        process.stdout.write(JSON.stringify({
          type: "response",
          id: commandId,
          command: "trigger",
          success: true,
          data: message,
        }) + "\n");
      }
    }
  });
`;

function dialogChildInvocation(dialog: Record<string, unknown>) {
  return {
    command: process.execPath,
    args: ["-e", DIALOG_CHILD_SCRIPT],
    cwd: process.cwd(),
    env: {
      ...process.env,
      DIALOG_REQUEST: JSON.stringify({ type: "extension_ui_request", ...dialog }),
    },
  };
}

const FRAME_CHILD_SCRIPT = String.raw`
  let buffer = "";
  let frameCommand;
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const command = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      if (command.type === "emit_frame") {
        frameCommand = command;
        const totalBytes = Number(process.env.FRAME_TEXT_BYTES);
        const imageCount = 6;
        const imageBytes = Math.ceil(totalBytes / imageCount);
        process.stdout.write(JSON.stringify({
          type: "agent_end",
          messages: Array.from({ length: imageCount }, (_, index) => ({
            role: "toolResult",
            toolCallId: "read-image-" + index,
            toolName: "read",
            content: [{ type: "image", data: "A".repeat(imageBytes), mimeType: "image/png" }],
            isError: false,
            timestamp: index,
          })),
        }) + "\n");
        continue;
      }
      process.stdout.write(JSON.stringify({
        type: "response",
        id: frameCommand.id,
        command: frameCommand.type,
        success: true,
        data: "frame accepted",
      }) + "\n");
      process.stdout.write(JSON.stringify({
        type: "response",
        id: command.id,
        command: command.type,
        success: true,
        data: "pong",
      }) + "\n");
    }
  });
`;

function frameChildInvocation(frameTextBytes: number) {
  return {
    command: process.execPath,
    args: ["-e", FRAME_CHILD_SCRIPT],
    cwd: process.cwd(),
    env: {
      ...process.env,
      FRAME_TEXT_BYTES: String(frameTextBytes),
    },
  };
}

describe("ownership status protocol", () => {
  it("round-trips a bounded active subtree without transcript fields", () => {
    const ownership = [{
      path: [2],
      parentPath: [],
      id: 2,
      depth: 3,
      state: "running" as const,
      name: "leaf",
      model: "provider/model",
      thinking: "medium" as const,
    }];

    const encoded = encodeOwnershipStatus(ownership);

    expect(OWNERSHIP_STATUS_KEY).toBe("ompi:subagents:ownership-v1");
    expect(parseOwnershipStatus(encoded)).toEqual(ownership);
    expect(encoded).not.toContain("preview");
    expect(encoded).not.toContain("finalText");
    expect(() => parseOwnershipStatus(JSON.stringify({
      version: 1,
      ownership: [{ ...ownership[0], path: [2, 3, 4] }],
    }))).toThrow("invalid");
  });

  it("marks bounded ownership metadata omissions before relaying status", () => {
    const [runtime] = parseOwnershipStatus(encodeOwnershipStatus([{
      path: [1],
      parentPath: [],
      id: 1,
      depth: 3,
      state: "running",
      name: `leaf-${"n".repeat(200)}`,
      model: `provider/${"m".repeat(300)}`,
      thinking: "medium",
    }]));

    expect(runtime.name).toHaveLength(80);
    expect(runtime.name).toContain("characters omitted");
    expect(runtime.model).toHaveLength(160);
    expect(runtime.model).toContain("characters omitted");
  });

  it("omits a whitespace-only optional name instead of rejecting active status", () => {
    const encoded = encodeOwnershipStatus([{
      path: [1],
      parentPath: [],
      id: 1,
      depth: 3,
      state: "handshaking",
      name: "   ",
      model: "provider/model",
      thinking: "low",
    }]);

    expect(parseOwnershipStatus(encoded)).toEqual([{
      path: [1],
      parentPath: [],
      id: 1,
      depth: 3,
      state: "handshaking",
      model: "provider/model",
      thinking: "low",
    }]);
  });
});

describe("standard dialog relay", () => {
  it("uses only the user UI and preserves method-appropriate responses", async () => {
    const calls: unknown[] = [];
    const ui = {
      select: async (title: string, options: string[], settings: unknown) => {
        calls.push({ method: "select", title, options, settings });
        return "Allow";
      },
      confirm: async (title: string, message: string, settings: unknown) => {
        calls.push({ method: "confirm", title, message, settings });
        return false;
      },
      input: async (title: string, placeholder: string, settings: unknown) => {
        calls.push({ method: "input", title, placeholder, settings });
        return "typed";
      },
      editor: async (title: string, prefill: string) => {
        calls.push({ method: "editor", title, prefill });
        return "edited";
      },
    } as unknown as ExtensionUIContext;
    const signal = new AbortController().signal;

    await expect(relayStandardDialog(ui, {
      id: "1",
      method: "select",
      title: "Choose",
      options: ["Allow", "Block"],
    }, signal)).resolves.toEqual({ value: "Allow" });
    await expect(relayStandardDialog(ui, {
      id: "2",
      method: "confirm",
      title: "Continue",
      message: "Proceed?",
    }, signal)).resolves.toEqual({ confirmed: false });
    await expect(relayStandardDialog(ui, {
      id: "3",
      method: "input",
      title: "Value",
      placeholder: "type",
    }, signal)).resolves.toEqual({ value: "typed" });
    await expect(relayStandardDialog(ui, {
      id: "4",
      method: "editor",
      title: "Edit",
      prefill: "before",
    }, signal)).resolves.toEqual({ value: "edited" });

    expect(calls).toHaveLength(4);
    expect(calls[0]).toMatchObject({
      method: "select",
      settings: { timeout: 30_000, signal },
    });
    expect(calls[1]).toMatchObject({ method: "confirm" });
    expect(calls[2]).toMatchObject({ method: "input" });
  });

  it("fails closed when the user UI does not settle before the relay deadline", async () => {
    const ui = {
      confirm: async () => new Promise<boolean>(() => undefined),
    } as unknown as ExtensionUIContext;
    const relaying = relayStandardDialog(ui, {
      id: "slow",
      method: "confirm",
      title: "Continue?",
      message: "No response",
      timeout: 5,
    }, new AbortController().signal);
    const observed = await Promise.race([
      relaying,
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 25)),
    ]);

    expect(observed).toEqual({ cancelled: true });
  });

  it("dismisses the root interactive editor when its bounded relay expires", async () => {
    initTheme(undefined, false);
    let customSettled = false;
    const ui = {
      custom: async (factory: (...args: any[]) => unknown) => new Promise<string | undefined>((resolve, reject) => {
        const done = (value: string | undefined) => {
          customSettled = true;
          resolve(value);
        };
        Promise.resolve(factory(
          { requestRender: () => undefined },
          {},
          {},
          done,
        )).catch(reject);
      }),
    } as unknown as ExtensionUIContext;

    await expect(relayStandardDialog(ui, {
      id: "editor-deadline",
      method: "editor",
      title: "Edit",
      prefill: "draft",
      timeout: 5,
    }, new AbortController().signal, { interactiveEditor: true })).resolves.toEqual({ cancelled: true });
    expect(customSettled).toBe(true);
  });

  it("keeps TUI-only custom components outside the standard relay protocol", () => {
    expect(STANDARD_DIALOG_METHODS).toEqual(["select", "confirm", "input", "editor"]);
    expect(() => parseStandardDialogRequest({
      type: "extension_ui_request",
      id: "custom-1",
      method: "custom",
      title: "Unsupported",
    })).toThrow("invalid");
  });
});

describe("RpcSubprocess dialog transport", () => {
  it("correlates a standard child dialog with the relay response", async () => {
    const requests: unknown[] = [];
    const child = new RpcSubprocess(dialogChildInvocation({
      id: "child-dialog-7",
      method: "select",
      title: "Allow?",
      options: ["Allow", "Block"],
    }), {
      onDialog: async (request) => {
        requests.push(request);
        return { value: "Allow" };
      },
    });

    await expect(child.request({ type: "trigger" })).resolves.toEqual({
      type: "extension_ui_response",
      id: "child-dialog-7",
      value: "Allow",
    });
    expect(requests).toEqual([{
      id: "child-dialog-7",
      method: "select",
      title: "Allow?",
      options: ["Allow", "Block"],
    }]);
    await child.close();
  });

  it("fails a standard dialog closed immediately when no relay is available", async () => {
    const child = new RpcSubprocess(dialogChildInvocation({
      id: "child-dialog-8",
      method: "confirm",
      title: "Continue?",
      message: "This needs a user decision.",
    }));

    await expect(child.request({ type: "trigger" })).resolves.toEqual({
      type: "extension_ui_response",
      id: "child-dialog-8",
      cancelled: true,
    });
    await child.close();
  });

  it("cancels and settles a pending dialog before process cleanup", async () => {
    let relayStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      relayStarted = resolve;
    });
    let aborted = false;
    const child = new RpcSubprocess(dialogChildInvocation({
      id: "child-dialog-9",
      method: "input",
      title: "Value",
    }), {
      onDialog: async (_request, signal) => {
        relayStarted();
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve();
          }, { once: true });
        });
        return { value: "too late" };
      },
    });

    const requesting = child.request({ type: "trigger" });
    await started;
    const closing = child.close();
    await expect(requesting).resolves.toEqual({
      type: "extension_ui_response",
      id: "child-dialog-9",
      cancelled: true,
    });
    await closing;
    expect(aborted).toBe(true);
  });
});

describe("RpcSubprocess ownership transport", () => {
  it("intercepts a strict JSONL ownership frame and forwards only validated status", async () => {
    const ownership = [{
      path: [2],
      parentPath: [],
      id: 2,
      depth: 3,
      state: "running" as const,
      name: "leaf\u2028runtime",
      model: "provider/model",
      thinking: "medium" as const,
    }];
    const status = JSON.stringify({ version: 1, ownership });
    const script = String.raw`
      process.stdout.write(JSON.stringify({
        type: "extension_ui_request",
        id: "status-1",
        method: "setStatus",
        statusKey: process.env.STATUS_KEY,
        statusText: process.env.STATUS_TEXT,
      }) + "\n");
      let buffer = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const command = JSON.parse(buffer.slice(0, newline));
        process.stdout.write(JSON.stringify({
          type: "response",
          id: command.id,
          command: command.type,
          success: true,
          data: "pong",
        }) + "\n");
      });
    `;
    const child = new RpcSubprocess({
      command: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      env: {
        ...process.env,
        STATUS_KEY: OWNERSHIP_STATUS_KEY,
        STATUS_TEXT: status,
      },
    });
    const events: unknown[] = [];
    child.onEvent((event) => events.push(event));

    await expect(child.request({ type: "ping" })).resolves.toBe("pong");
    await vi.waitFor(() => expect(events).toEqual([{
      type: "subagent_ownership",
      ownership,
    }]));
    await child.close();
  });
});

describe("RpcSubprocess prompt transport", () => {
  it("marks failure before a prompt can be written as not crossed", async () => {
    const child = new RpcSubprocess({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: process.cwd(),
      env: { ...process.env },
    });
    await new Promise<void>((resolve) => child.onExit(() => resolve()));
    let captured: unknown;

    try {
      await child.prompt("not sent");
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(PromptTransportError);
    expect((captured as PromptTransportError).mayHaveCrossed).toBe(false);
    expect((captured as Error).cause).toBeInstanceOf(Error);
  });

  it("marks process failure after a prompt write as possibly crossed", async () => {
    const child = new RpcSubprocess({
      command: process.execPath,
      args: ["-e", "process.stdin.once('data', () => process.exit(2))"],
      cwd: process.cwd(),
      env: { ...process.env },
    });
    let captured: unknown;

    try {
      await child.prompt("possibly sent");
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(PromptTransportError);
    expect((captured as PromptTransportError).mayHaveCrossed).toBe(true);
    expect((captured as Error).message).toContain("code=2");
  });
});

describe("RpcSubprocess frame transport", () => {
  it("ignores valid JSON values that are not RPC records", async () => {
    const script = String.raw`
      process.stdout.write("null\n[]\n42\n");
      let buffer = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const command = JSON.parse(buffer.slice(0, newline));
        process.stdout.write(JSON.stringify({
          type: "response",
          id: command.id,
          success: true,
          data: "pong",
        }) + "\n");
      });
    `;
    const child = new RpcSubprocess({
      command: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      env: { ...process.env },
    });
    const events: unknown[] = [];
    child.onEvent((event) => events.push(event));

    await expect(child.request({ type: "ping" })).resolves.toBe("pong");
    expect(events).toEqual([]);
    await child.close();
  });

  it("accepts a valid model-sized frame and settles following responses", async () => {
    const child = new RpcSubprocess(frameChildInvocation(1024 * 1024));
    const followingResponse = new Promise<unknown>((resolve, reject) => {
      child.onEvent((event) => {
        if (event.type === "agent_end") {
          void child.request({ type: "after_frame" }).then(resolve, reject);
        }
      });
      child.onExit((error) => reject(error ?? new Error("Child exited before the large frame settled.")));
    });

    const frameResponse = child.request({ type: "emit_frame" });
    await expect(followingResponse).resolves.toBe("pong");
    await expect(frameResponse).resolves.toBe("frame accepted");
    await child.close();
  });

  it("accepts an image-bearing frame above 8 MiB and settles following responses", async () => {
    const child = new RpcSubprocess(frameChildInvocation(10 * 1024 * 1024));
    const followingResponse = new Promise<unknown>((resolve, reject) => {
      child.onEvent((event) => {
        if (event.type === "agent_end") {
          void child.request({ type: "after_frame" }).then(resolve, reject);
        }
      });
      child.onExit((error) => reject(error ?? new Error("Child exited before the image frame settled.")));
    });

    const frameResponse = child.request({ type: "emit_frame" });
    await expect(followingResponse).resolves.toBe("pong");
    await expect(frameResponse).resolves.toBe("frame accepted");
    await child.close();
  });
});

describe("buildChildInvocation", () => {
  it("creates a clean Pi launch with exact tools, required providers, and normal resource discovery", () => {
    const invocation = buildChildInvocation({
      cwd: "/tmp/worktree",
      model: "anthropic/claude",
      thinking: "high",
      lineage: { depth: 2, maxDepth: 3, maxChildren: 2 },
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
    expect(invocation.env.OMPI_SUBAGENT_LINEAGE).toBe(
      '{"version":1,"depth":2,"maxDepth":3,"maxChildren":2}',
    );
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
      lineage: { depth: 2, maxDepth: 2, maxChildren: 0 },
      name: "existing",
      session: "/sessions/child.jsonl",
    });

    expect(valueAfter(invocation.args, "--session")).toBe("/sessions/child.jsonl");
    expect(invocation.env.OMPI_SUBAGENT_LINEAGE).toContain('"depth":2');
    expect(invocation.args).not.toContain("--name");
    expect(invocation.args).toContain("--no-tools");
    expect(invocation.args).not.toContain("--tools");
  });
});
