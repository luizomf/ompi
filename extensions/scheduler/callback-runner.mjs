#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";

const PROTOCOL_VERSION = 1;
const MAX_ACK_BYTES = 1_024;
const MAX_CALLBACK_FRAME_BYTES = 128_000;
const CALLBACK_TIMEOUT_MS = 2_000;
const MAX_REENTRY_PROMPT_BYTES = 8_000;
const MAX_PREVIEW_BYTES = 4_000;
const MAX_START_ERROR_BYTES = 2_000;
const MAX_PAYLOAD_ARGUMENTS = 128;
const MAX_ARGUMENT_BYTES = 8_000;
const MAX_TOTAL_ARGUMENT_BYTES = 64_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PAYLOAD_ENVIRONMENT_KEYS = [
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "PATH",
  "PROJECTS_DIR",
  "SHELL",
  "TMPDIR",
  "TZ",
  "USER",
];

function fail(message) {
  process.stderr.write(`scheduler callback runner: ${message}\n`);
  process.exitCode = 2;
}

function parseArguments(arguments_) {
  const values = {};
  let index = 0;
  for (const option of ["--socket", "--capability", "--submission", "--prompt-base64"]) {
    if (arguments_[index] !== option || index + 1 >= arguments_.length) {
      throw new Error(`expected ${option}`);
    }
    values[option.slice(2)] = arguments_[index + 1];
    index += 2;
  }

  let payload;
  if (index < arguments_.length) {
    if (arguments_[index] !== "--" || index + 1 >= arguments_.length) {
      throw new Error("unexpected callback runner arguments");
    }
    payload = {
      executable: arguments_[index + 1],
      args: arguments_.slice(index + 2),
    };
  }

  if (!values.socket || !values.capability || !values.submission) {
    throw new Error("callback endpoint, capability, and submission are required");
  }
  if (!values.socket.startsWith("/") || Buffer.byteLength(values.socket, "utf8") > 1_024) {
    throw new Error("callback endpoint path is invalid");
  }
  if (!CAPABILITY_PATTERN.test(values.capability) || !UUID_PATTERN.test(values.submission)) {
    throw new Error("callback capability or submission identity is invalid");
  }
  if (payload) {
    if (!payload.executable.trim() || Buffer.byteLength(payload.executable, "utf8") > MAX_ARGUMENT_BYTES) {
      throw new Error("payload executable is invalid");
    }
    if (payload.args.length > MAX_PAYLOAD_ARGUMENTS
      || payload.args.some((argument) => Buffer.byteLength(argument, "utf8") > MAX_ARGUMENT_BYTES)
      || payload.args.reduce((total, argument) => total + Buffer.byteLength(argument, "utf8"), 0) > MAX_TOTAL_ARGUMENT_BYTES) {
      throw new Error("payload argument vector exceeds its limit");
    }
  }
  if (!/^[A-Za-z0-9_-]+$/.test(values["prompt-base64"] ?? "")) {
    throw new Error("reentry prompt encoding is invalid");
  }
  const reentryPrompt = Buffer.from(values["prompt-base64"], "base64url").toString("utf8");
  if (Buffer.from(reentryPrompt, "utf8").toString("base64url") !== values["prompt-base64"]
    || !reentryPrompt.trim()
    || Buffer.byteLength(reentryPrompt, "utf8") > MAX_REENTRY_PROMPT_BYTES) {
    throw new Error("reentry prompt is invalid");
  }

  return {
    socketPath: values.socket,
    capability: values.capability,
    submissionId: values.submission,
    reentryPrompt,
    payload,
  };
}

function decodeWithin(buffer, maximumBytes) {
  let text = buffer.toString("utf8");
  while (Buffer.byteLength(text, "utf8") > maximumBytes && text.length > 0) {
    const last = text.charCodeAt(text.length - 1);
    const remove = last >= 0xdc00 && last <= 0xdfff && text.length > 1 ? 2 : 1;
    text = text.slice(0, -remove);
  }
  return text;
}

class BoundedPreview {
  #chunks = [];
  #bytes = 0;
  #seenBytes = 0;

  append(chunk) {
    this.#seenBytes += chunk.length;
    const remaining = MAX_PREVIEW_BYTES - this.#bytes;
    if (remaining <= 0) return;
    const retained = chunk.subarray(0, remaining);
    this.#chunks.push(retained);
    this.#bytes += retained.length;
  }

  value() {
    return {
      preview: decodeWithin(Buffer.concat(this.#chunks, this.#bytes), MAX_PREVIEW_BYTES),
      truncated: this.#seenBytes > MAX_PREVIEW_BYTES,
    };
  }
}

class WriteTracker {
  #pending = 0;
  #waiters = [];

  write(source, destination, chunk) {
    this.#pending++;
    const writable = destination.write(chunk, () => {
      this.#pending--;
      if (this.#pending === 0) {
        for (const resolve of this.#waiters.splice(0)) resolve();
      }
    });
    if (!writable) {
      source.pause();
      destination.once("drain", () => source.resume());
    }
  }

  wait() {
    if (this.#pending === 0) return Promise.resolve();
    return new Promise((resolve) => this.#waiters.push(resolve));
  }
}

function selectedPayloadEnvironment(source) {
  const environment = {};
  for (const key of PAYLOAD_ENVIRONMENT_KEYS) {
    if (source[key] !== undefined) environment[key] = source[key];
  }
  return environment;
}

function boundedError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const bytes = Buffer.from(message, "utf8");
  return decodeWithin(bytes.subarray(0, MAX_START_ERROR_BYTES), MAX_START_ERROR_BYTES);
}

function runPayload(payload) {
  return new Promise((resolve) => {
    const stdout = new BoundedPreview();
    const stderr = new BoundedPreview();
    const stdoutWrites = new WriteTracker();
    const stderrWrites = new WriteTracker();
    let child;
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      resolve({ outcome, stdout: stdout.value(), stderr: stderr.value() });
    };
    const startFailed = (error) => {
      const message = boundedError(error);
      process.stderr.write(`scheduler callback runner: payload start failed: ${message}\n`);
      finish({ kind: "start_error", message });
    };

    try {
      child = spawn(payload.executable, payload.args, {
        cwd: process.cwd(),
        env: selectedPayloadEnvironment(process.env),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      startFailed(error);
      return;
    }

    child.stdout.on("data", (chunk) => {
      stdout.append(chunk);
      stdoutWrites.write(child.stdout, process.stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr.append(chunk);
      stderrWrites.write(child.stderr, process.stderr, chunk);
    });
    child.once("error", startFailed);
    child.once("close", async (code, signal) => {
      await Promise.all([stdoutWrites.wait(), stderrWrites.wait()]);
      if (signal) finish({ kind: "signal", signal });
      else finish({ kind: "exit", code: code ?? 1 });
    });
  });
}

function sendCallback(socketPath, frame) {
  const serialized = `${JSON.stringify(frame)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_CALLBACK_FRAME_BYTES) {
    return Promise.reject(new Error("callback frame exceeded its limit"));
  }
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let response = Buffer.alloc(0);
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };

    socket.setTimeout(CALLBACK_TIMEOUT_MS, () => finish(new Error("callback timed out")));
    socket.once("connect", () => socket.end(serialized, "utf8"));
    socket.on("data", (chunk) => {
      if (response.length + chunk.length > MAX_ACK_BYTES) {
        finish(new Error("callback acknowledgement exceeded its limit"));
        return;
      }
      response = Buffer.concat([response, chunk]);
    });
    socket.once("end", () => {
      const lines = response.toString("utf8").split("\n").filter((line) => line.length > 0);
      if (lines.length !== 1) {
        finish(new Error("callback acknowledgement was malformed"));
        return;
      }
      let acknowledgement;
      try {
        acknowledgement = JSON.parse(lines[0]);
      } catch {
        finish(new Error("callback acknowledgement was malformed"));
        return;
      }
      const keys = acknowledgement && typeof acknowledgement === "object"
        ? Object.keys(acknowledgement).sort()
        : [];
      if (keys.join(",") !== "ok,version"
        || acknowledgement.version !== PROTOCOL_VERSION
        || acknowledgement.ok !== true) {
        finish(new Error("callback was rejected"));
        return;
      }
      finish();
    });
    socket.once("error", (error) => finish(error));
  });
}

async function main() {
  let request;
  try {
    request = parseArguments(process.argv.slice(2));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }

  const result = request.payload
    ? await runPayload(request.payload)
    : {
        outcome: { kind: "heartbeat" },
        stdout: { preview: "", truncated: false },
        stderr: { preview: "", truncated: false },
      };
  const frame = {
    version: PROTOCOL_VERSION,
    capability: request.capability,
    submissionId: request.submissionId,
    wakeId: randomUUID(),
    reentryPrompt: request.reentryPrompt,
    outcome: result.outcome,
    stdout: result.stdout,
    stderr: result.stderr,
  };

  let callbackFailed = false;
  try {
    await sendCallback(request.socketPath, frame);
  } catch (error) {
    callbackFailed = true;
    process.stderr.write(`scheduler callback runner: callback unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
  }

  if (result.outcome.kind === "exit") {
    process.exitCode = result.outcome.code === 0 && callbackFailed ? 1 : result.outcome.code;
  } else if (result.outcome.kind === "start_error") process.exitCode = 127;
  else if (result.outcome.kind === "signal") {
    try {
      process.kill(process.pid, result.outcome.signal);
    } catch (error) {
      process.stderr.write(`scheduler callback runner: cannot preserve payload signal ${result.outcome.signal}: ${boundedError(error)}\n`);
      process.exitCode = 1;
    }
  } else if (callbackFailed) {
    process.exitCode = 1;
  }
}

await main();
