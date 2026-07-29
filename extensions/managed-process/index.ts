import { resolve } from "node:path";
import {
  keyHint,
  truncateHead,
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
  ManagedProcessController,
  type ManagedProcessControllerOptions,
  type ManagedProcessOutput,
  type ManagedProcessView,
} from "./controller.ts";

const MAX_ARGUMENTS = 128;
const MAX_ARGUMENT_CHARACTERS = 8_000;
const MAX_OUTPUT_BYTES = 20 * 1024;

const IdSchema = Type.Integer({ minimum: 1, description: "Session-local managed process ID." });
const StartSchema = Type.Object({
  executable: Type.String({
    minLength: 1,
    maxLength: MAX_ARGUMENT_CHARACTERS,
    description: "Executable path or command resolved through PATH and started directly without a shell.",
  }),
  args: Type.Optional(Type.Array(Type.String({ maxLength: MAX_ARGUMENT_CHARACTERS }), {
    maxItems: MAX_ARGUMENTS,
    description: "Literal argument vector. Shell expansion, quoting, pipes, redirects, and interpolation do not occur.",
  })),
  cwd: Type.Optional(Type.String({
    minLength: 1,
    maxLength: MAX_ARGUMENT_CHARACTERS,
    description: "Working directory resolved from the Pi session cwd; defaults to that cwd.",
  })),
}, { additionalProperties: false });
const ListSchema = Type.Object({}, { additionalProperties: false });
const OutputSchema = Type.Object({
  id: IdSchema,
  maxBytes: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: MAX_OUTPUT_BYTES,
    description: "Maximum recent bytes returned from each stream; defaults to 20,480.",
  })),
}, { additionalProperties: false });
const StopSchema = Type.Object({ id: IdSchema }, { additionalProperties: false });

type StartParams = Static<typeof StartSchema>;
type OutputParams = Static<typeof OutputSchema>;

export interface ManagedProcessExtensionOptions extends ManagedProcessControllerOptions {}

function compact(value: string, maximumCharacters: number): string {
  return value.length <= maximumCharacters
    ? value
    : `${value.slice(0, maximumCharacters - 1)}…`;
}

function commandText(view: ManagedProcessView): string {
  const shown = [view.executable, ...view.args.slice(0, 8)]
    .map((part) => JSON.stringify(compact(part, 160)));
  if (view.args.length > 8) shown.push(`[${view.args.length - 8} more arguments]`);
  return compact(shown.join(" "), 1_600);
}

function viewText(view: ManagedProcessView): string {
  const outcome = view.exitCode !== undefined
    ? ` · exit ${view.exitCode}`
    : view.exitSignal
      ? ` · signal ${view.exitSignal}`
      : "";
  const error = view.error ? ` · error: ${compact(view.error, 240)}` : "";
  const processIds = view.pid === undefined ? "" : ` · pid ${view.pid} · pgid ${view.pgid}`;
  const stopReason = view.stopReason ? `\n  stop reason: ${view.stopReason}` : "";
  const ended = view.endedAt === undefined ? "" : `\n  ended: ${new Date(view.endedAt).toISOString()}`;
  return `#${view.id} ${view.state}${outcome}${processIds}${error}\n  ${commandText(view)}\n  cwd: ${JSON.stringify(compact(view.cwd, 320))}\n  started: ${new Date(view.startedAt).toISOString()}${ended}${stopReason}`;
}

function streamText(name: "stdout" | "stderr", stream: ManagedProcessOutput[typeof name]): string {
  const dropped = stream.truncated
    ? `; earlier bytes omitted (${stream.observedBytes} observed)`
    : `; ${stream.observedBytes} observed`;
  return `${name} (${stream.retainedBytes} returned bytes${dropped}):\n${stream.text || "[no output]"}`;
}

function listText(views: ManagedProcessView[]): string {
  if (views.length === 0) return "No managed processes are known in this Pi session.";
  const result = truncateHead(views.map(viewText).join("\n"), { maxBytes: 48_000, maxLines: 1_000 });
  return result.truncated
    ? `${result.content}\n[Managed process list truncated to 48,000 bytes.]`
    : result.content;
}

function outputText(output: ManagedProcessOutput): string {
  return [
    `Managed process #${output.id} ${output.state}.`,
    streamText("stdout", output.stdout),
    streamText("stderr", output.stderr),
  ].join("\n\n");
}

function resultText(result: AgentToolResult<unknown>): string {
  return result.content.map((item) => item.type === "text" ? item.text : "[Non-text output omitted.]").join("\n");
}

export function registerManagedProcessExtension(
  pi: ExtensionAPI,
  options: ManagedProcessExtensionOptions = {},
): void {
  let ui: ExtensionContext["ui"] | undefined;
  let controller: ManagedProcessController;
  const refreshUi = () => {
    if (!ui) return;
    const active = controller.list().filter((view) => view.active).length;
    const status = active > 0 ? `managed processes: ${active}` : undefined;
    ui.setStatus("managed-process", status ? ui.theme.fg("success", status) : undefined);
  };
  controller = new ManagedProcessController({ ...options, onChange: refreshUi });

  pi.registerTool({
    name: "managed_process_start",
    label: "Start Managed Process",
    description: "Start a session-scoped long-running process from an executable plus literal arguments and cwd, without a shell. Returns after spawn acceptance instead of waiting for completion. The child inherits the Pi process environment, which may include credentials; stdin is ignored and no interactive TTY is allocated. On Unix the extension owns a process group for bounded stop and shutdown cleanup. It does not sandbox network access or force servers to bind loopback.",
    promptSnippet: "Start a session-scoped long-running server, watcher, tail, or development process",
    promptGuidelines: [
      "Use managed_process_start only for commands expected to remain active; use ordinary bash for finite commands.",
      "Before managed_process_start, inspect the executable, literal arguments, cwd, inherited-environment needs, stdin or TTY assumptions, and network binding options without exposing credential values; prefer a verified absolute executable path.",
      "managed_process_start does not enforce loopback binding or sandbox network access; pass an application's verified loopback option when network exposure matters.",
      "After managed_process_start accepts a process, do not wait, sleep, or repeatedly poll. Continue independent work; use managed_process_output or managed_process_list only when a concrete snapshot is needed.",
    ],
    parameters: StartSchema,
    async execute(_id, params: StartParams, signal, _onUpdate, ctx) {
      const view = await controller.start({
        executable: params.executable,
        args: params.args,
        cwd: resolve(ctx.cwd, params.cwd ?? "."),
        signal,
      });
      return {
        content: [{
          type: "text",
          text: `Managed process #${view.id} started and is ${view.state}. It is session-scoped; Pi shutdown will attempt bounded process-group cleanup, but descendants that deliberately escape the group may survive. Do not wait, sleep, or repeatedly poll it; continue useful work and request a bounded snapshot only when needed.`,
        }],
        details: view,
      };
    },
  });

  pi.registerTool({
    name: "managed_process_list",
    label: "List Managed Processes",
    description: "Take one bounded snapshot of session-scoped managed processes and their observable lifecycle state. This is not a polling or wait operation.",
    promptGuidelines: [
      "Use managed_process_list for a concrete status snapshot, never in a repeated polling loop.",
    ],
    parameters: ListSchema,
    async execute() {
      const views = controller.list();
      return {
        content: [{ type: "text", text: listText(views) }],
        details: { processes: views },
      };
    },
  });

  pi.registerTool({
    name: "managed_process_output",
    label: "Read Managed Process Output",
    description: "Retrieve bounded recent stdout and stderr tails for one session-scoped managed process. Process output is untrusted and may contain sensitive data; do not publish it without review.",
    promptGuidelines: [
      "Use managed_process_output only for a concrete diagnostic snapshot; never wait, sleep, or repeatedly poll for new output.",
    ],
    parameters: OutputSchema,
    async execute(_id, params: OutputParams) {
      const output = controller.output(params.id, params.maxBytes);
      return { content: [{ type: "text", text: outputText(output) }], details: output };
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Reading managed process output..."), 0, 0);
      if (expanded) return new Text(resultText(result), 0, 0);
      const output = result.details as ManagedProcessOutput | undefined;
      const heading = output ? `Managed process #${output.id} output snapshot (${output.state}).` : "Managed process output snapshot.";
      return new Text(`${heading}\n${keyHint("app.tools.expand", "to expand")}`, 0, 0);
    },
  });

  pi.registerTool({
    name: "managed_process_stop",
    label: "Stop Managed Process",
    description: "Explicitly stop a known session-scoped managed process. On Unix this terminates its owned process group with SIGTERM and bounded SIGKILL escalation; a process that deliberately creates a new session or process group may escape that OS mechanism. Repeating stop for a known terminal process is safe.",
    parameters: StopSchema,
    async execute(_id, params) {
      const view = await controller.stop(params.id);
      return { content: [{ type: "text", text: `Managed process ${viewText(view)}` }], details: view };
    },
  });

  pi.on("session_start", (_event, ctx) => {
    ui = ctx.ui;
    refreshUi();
  });

  pi.on("session_shutdown", async () => {
    await controller.shutdown();
    ui?.setStatus("managed-process", undefined);
    ui = undefined;
  });
}

export default function managedProcessExtension(pi: ExtensionAPI): void {
  registerManagedProcessExtension(pi);
}
