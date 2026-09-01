import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import {
  CAPABILITY_PROBE_STATUS_KEY,
  parseCapabilityProbe,
  type CapabilitySnapshot,
} from "./capabilities.ts";
import { PromptTransportError } from "./controller.ts";
import type {
  LaunchSpec,
  OwnershipRuntime,
  RpcChild,
  RpcEvent,
} from "./controller.ts";
import {
  cancelledDialogResult,
  isStandardDialogMethod,
  normalizeDialogResult,
  parseStandardDialogRequest,
  type StandardDialogRequest,
  type StandardDialogResult,
} from "./dialogs.ts";
import { MANAGED_LINEAGE_ENV, encodeManagedLineage } from "./lineage.ts";
import { OWNERSHIP_STATUS_KEY, parseOwnershipStatus } from "./ownership.ts";

interface RpcResponse {
  id?: string;
  type: "response";
  success: boolean;
  data?: unknown;
  error?: string;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface PendingDialog {
  abort: AbortController;
}

export interface RpcSubprocessOptions {
  onDialog?(request: StandardDialogRequest, signal: AbortSignal): Promise<StandardDialogResult>;
}

const CAPABILITY_PROBE_PATH = fileURLToPath(new URL("./capability-probe.ts", import.meta.url));

export interface ChildInvocation {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export function buildChildInvocation(spec: LaunchSpec): ChildInvocation {
  const args = ["--mode", "rpc", "--no-extensions"];
  const env = {
    ...process.env,
    [MANAGED_LINEAGE_ENV]: encodeManagedLineage(spec.lineage),
  };
  for (const extensionPath of spec.capabilities.extensionPaths) {
    args.push("--extension", extensionPath);
  }
  args.push(
    "--extension", CAPABILITY_PROBE_PATH,
    "--model", spec.model,
    "--thinking", spec.thinking,
  );
  if (spec.session) args.push("--session", spec.session);
  if (spec.name && !spec.session) args.push("--name", spec.name);
  const tools = spec.capabilities.tools.map((tool) => tool.name);
  if (tools.length > 0) args.push("--tools", tools.join(","));
  else args.push("--no-tools");

  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args], cwd: spec.cwd, env };
  }

  const executable = basename(process.execPath).toLowerCase();
  const genericRuntime = /^(node|bun)(\.exe)?$/.test(executable);
  return {
    command: genericRuntime ? "pi" : process.execPath,
    args,
    cwd: spec.cwd,
    env,
  };
}

export class RpcSubprocess implements RpcChild {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly pendingDialogs = new Map<string, PendingDialog>();
  private readonly eventListeners: Array<(event: RpcEvent) => void> = [];
  private readonly exitListeners: Array<(error?: Error) => void> = [];
  private requestId = 0;
  private stderr = "";
  private exited = false;
  private exitPromise: Promise<void>;
  private resolveExit!: () => void;
  private readonly capabilitiesPromise: Promise<CapabilitySnapshot>;
  private resolveCapabilities!: (snapshot: CapabilitySnapshot) => void;
  private rejectCapabilities!: (error: Error) => void;

  constructor(
    invocation: ChildInvocation,
    private readonly options: RpcSubprocessOptions = {},
  ) {
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    this.capabilitiesPromise = new Promise((resolve, reject) => {
      this.resolveCapabilities = resolve;
      this.rejectCapabilities = reject;
    });
    void this.capabilitiesPromise.catch(() => undefined);
    this.process = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.attachJsonlReader();
    this.process.stderr.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-8_000);
    });
    this.process.once("error", (error) => this.handleExit(error));
    this.process.once("exit", (code, signal) => {
      const error = code === 0
        ? undefined
        : new Error(`Child exited (code=${code}, signal=${signal}).${this.stderr ? ` ${this.stderr}` : ""}`);
      this.handleExit(error);
    });
    this.process.stdin.on("error", (error) => {
      if (!this.exited) this.rejectPending(error);
    });
  }

  getCapabilities(): Promise<CapabilitySnapshot> {
    return this.capabilitiesPromise;
  }

  request(command: Record<string, unknown>): Promise<unknown> {
    return this.sendRequest(command);
  }

  async prompt(message: string): Promise<void> {
    let mayHaveCrossed = false;
    try {
      await this.sendRequest(
        { type: "prompt", message },
        () => { mayHaveCrossed = true; },
      );
    } catch (error) {
      throw new PromptTransportError(mayHaveCrossed, error);
    }
  }

  private sendRequest(
    command: Record<string, unknown>,
    onBoundaryCrossed?: () => void,
  ): Promise<unknown> {
    if (this.exited || !this.process.stdin.writable) return Promise.reject(new Error("Child RPC process is not writable."));
    const id = `subagent_${++this.requestId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for RPC response to ${String(command.type)}.${this.stderr ? ` ${this.stderr}` : ""}`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.process.stdin.write(`${JSON.stringify({ ...command, id })}\n`, "utf8", (error) => {
          if (!error) return;
          const pending = this.pending.get(id);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(id);
          pending.reject(error);
        });
        onBoundaryCrossed?.();
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  onEvent(listener: (event: RpcEvent) => void): () => void {
    this.eventListeners.push(listener);
    return () => {
      const index = this.eventListeners.indexOf(listener);
      if (index >= 0) this.eventListeners.splice(index, 1);
    };
  }

  onExit(listener: (error?: Error) => void): () => void {
    this.exitListeners.push(listener);
    return () => {
      const index = this.exitListeners.indexOf(listener);
      if (index >= 0) this.exitListeners.splice(index, 1);
    };
  }

  async close(): Promise<void> {
    if (this.exited) return;
    this.cancelPendingDialogs(true);
    this.process.stdin.end();
    const timeout = setTimeout(() => this.process.kill("SIGTERM"), 2_000);
    const killTimeout = setTimeout(() => this.process.kill("SIGKILL"), 4_000);
    await this.exitPromise;
    clearTimeout(timeout);
    clearTimeout(killTimeout);
  }

  private attachJsonlReader(): void {
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    this.process.stdout.on("data", (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        this.handleLine(line);
      }
    });
    this.process.stdout.on("end", () => {
      buffer += decoder.end();
      if (buffer) this.handleLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
    });
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: RpcResponse | RpcEvent;
    try {
      message = JSON.parse(line) as RpcResponse | RpcEvent;
    } catch {
      return;
    }
    if (
      !message
      || typeof message !== "object"
      || Array.isArray(message)
      || typeof message.type !== "string"
    ) {
      return;
    }
    if (
      message.type === "extension_ui_request"
      && "method" in message
      && message.method === "setStatus"
      && "statusKey" in message
      && message.statusKey === CAPABILITY_PROBE_STATUS_KEY
    ) {
      try {
        this.resolveCapabilities(parseCapabilityProbe(
          "statusText" in message ? message.statusText : undefined,
        ));
      } catch (error) {
        this.rejectCapabilities(error instanceof Error ? error : new Error(String(error)));
      }
      return;
    }
    if (
      message.type === "extension_ui_request"
      && "method" in message
      && isStandardDialogMethod(message.method)
    ) {
      this.handleDialog(message);
      return;
    }
    if (
      message.type === "extension_ui_request"
      && "method" in message
      && message.method === "setStatus"
      && "statusKey" in message
      && message.statusKey === OWNERSHIP_STATUS_KEY
    ) {
      let ownership: OwnershipRuntime[] = [];
      try {
        ownership = "statusText" in message && message.statusText !== undefined
          ? parseOwnershipStatus(message.statusText)
          : [];
      } catch {
        // Invalid child status fails closed instead of preserving stale descendants.
      }
      for (const listener of this.eventListeners) {
        listener({ type: "subagent_ownership", ownership });
      }
      return;
    }
    if (message.type === "response" && "id" in message && message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.success) pending.resolve(message.data);
      else pending.reject(new Error(message.error ?? "Unknown RPC error."));
      return;
    }
    for (const listener of this.eventListeners) listener(message as RpcEvent);
  }

  private handleExit(error?: Error): void {
    if (this.exited) return;
    this.exited = true;
    const exitError = error ?? new Error("Child RPC process exited.");
    this.rejectCapabilities(exitError);
    this.rejectPending(exitError);
    this.cancelPendingDialogs(false);
    this.resolveExit();
    for (const listener of this.exitListeners) listener(error);
  }

  private handleDialog(message: RpcResponse | RpcEvent): void {
    const rawId = "id" in message ? message.id : undefined;
    let request: StandardDialogRequest;
    try {
      request = parseStandardDialogRequest(message);
    } catch {
      if (typeof rawId === "string" && rawId.length > 0 && rawId.length <= 128) {
        this.writeDialogResponse(rawId, cancelledDialogResult());
      }
      return;
    }
    if (this.pendingDialogs.has(request.id)) {
      this.writeDialogResponse(request.id, cancelledDialogResult());
      return;
    }
    if (!this.options.onDialog) {
      this.writeDialogResponse(request.id, cancelledDialogResult());
      return;
    }
    const abort = new AbortController();
    this.pendingDialogs.set(request.id, { abort });
    void this.options.onDialog(request, abort.signal)
      .then((result) => normalizeDialogResult(request, result))
      .catch(() => cancelledDialogResult())
      .then((result) => {
        if (!this.pendingDialogs.delete(request.id)) return;
        this.writeDialogResponse(request.id, result);
      });
  }

  private writeDialogResponse(id: string, result: StandardDialogResult): void {
    if (this.exited || !this.process.stdin.writable) return;
    this.process.stdin.write(`${JSON.stringify({
      type: "extension_ui_response",
      id,
      ...result,
    })}\n`, "utf8", () => undefined);
  }

  private cancelPendingDialogs(respond: boolean): void {
    for (const [id, pending] of this.pendingDialogs) {
      if (respond) this.writeDialogResponse(id, cancelledDialogResult());
      pending.abort.abort();
    }
    this.pendingDialogs.clear();
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
