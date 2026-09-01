import { resolve } from "node:path";
import {
  keyHint,
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
  ManagedProcessController,
  type ManagedProcessCleanup,
  type ManagedProcessControllerOptions,
  type ManagedProcessOutput,
  type ManagedProcessView,
} from "./controller.ts";

const MAX_ARGUMENTS = 128;
const MAX_ARGUMENT_CHARACTERS = 8_000;
const MAX_OUTPUT_BYTES = 20 * 1024;
const MAX_SNAPSHOT_BYTES = 48_000;
const MAX_DETAIL_ARGUMENTS = 8;
const MAX_DETAIL_ARGUMENT_CHARACTERS = 160;
const MAX_DETAIL_PATH_CHARACTERS = 320;
const MAX_DETAIL_ERROR_CHARACTERS = 240;

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
  if (value.length <= maximumCharacters) return value;
  const suffix = `…[truncated from ${value.length} characters]`;
  return `${value.slice(0, Math.max(0, maximumCharacters - suffix.length))}${suffix}`;
}

function commandText(view: ManagedProcessView): string {
  const shown = [view.executable, ...view.args.slice(0, MAX_DETAIL_ARGUMENTS)]
    .map((part) => JSON.stringify(compact(part, MAX_DETAIL_ARGUMENT_CHARACTERS)));
  if (view.args.length > MAX_DETAIL_ARGUMENTS) {
    shown.push(`[${view.args.length - MAX_DETAIL_ARGUMENTS} arguments omitted]`);
  }
  return shown.join(" ");
}

function displayOutcome(value: string): string {
  return value.replaceAll("_", " ");
}

function cleanupText(cleanup: ManagedProcessCleanup): string {
  if (cleanup.status === "not_attempted") return "";
  const reason = displayOutcome(cleanup.reason ?? "reason unavailable");
  const outcome = `cleanup ${cleanup.status} (${reason}) · SIGTERM: ${displayOutcome(cleanup.sigterm)} · SIGKILL: ${displayOutcome(cleanup.sigkill)} · group: ${displayOutcome(cleanup.group)} · leader: ${displayOutcome(cleanup.leader)}`;
  const omittedErrors = cleanup.errorsOmitted > 0
    ? ` · ${cleanup.errorsOmitted} cleanup errors omitted`
    : "";
  const leftovers = cleanup.possibleEscapedDescendants
    ? "\n  possible leftovers: escaped descendants may remain outside the owned process group"
    : "";
  return `\n  ${outcome}${omittedErrors}${leftovers}`;
}

function viewText(view: ManagedProcessView): string {
  const outcome = view.exitCode !== undefined
    ? ` · exit ${view.exitCode}`
    : view.exitSignal
      ? ` · signal ${view.exitSignal}`
      : "";
  const error = view.error ? ` · error: ${compact(view.error, MAX_DETAIL_ERROR_CHARACTERS)}` : "";
  const processIds = view.pid === undefined ? "" : ` · pid ${view.pid} · pgid ${view.pgid}`;
  const stopReason = view.stopReason ? `\n  stop reason: ${view.stopReason}` : "";
  const ended = view.endedAt === undefined ? "" : `\n  ended: ${new Date(view.endedAt).toISOString()}`;
  return `#${view.id} ${view.state}${outcome}${processIds}${error}\n  ${commandText(view)}\n  cwd: ${JSON.stringify(compact(view.cwd, MAX_DETAIL_PATH_CHARACTERS))}\n  started: ${new Date(view.startedAt).toISOString()}${ended}${stopReason}${cleanupText(view.cleanup)}`;
}

function streamText(name: "stdout" | "stderr", stream: ManagedProcessOutput[typeof name]): string {
  const dropped = stream.truncated
    ? `; earlier bytes omitted (${stream.observedBytes} observed)`
    : `; ${stream.observedBytes} observed`;
  return `${name} (${stream.retainedBytes} returned bytes${dropped}):\n${stream.text || "[no output]"}`;
}

interface BoundedProcessView {
  id: number;
  executable: string;
  args: string[];
  omittedArguments: number;
  cwd: string;
  pid?: number;
  pgid?: number;
  state: ManagedProcessView["state"];
  active: boolean;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  exitSignal?: NodeJS.Signals;
  stopReason?: ManagedProcessView["stopReason"];
  error?: string;
  cleanup: ManagedProcessCleanup;
  truncatedFields: string[];
}

interface ProcessSnapshotDetails {
  processes: BoundedProcessView[];
  terminalHistory: {
    retained: number;
    included: number;
    omitted: number;
  };
}

function boundedView(view: ManagedProcessView): BoundedProcessView {
  const truncatedFields: string[] = [];
  if (view.executable.length > MAX_DETAIL_ARGUMENT_CHARACTERS) truncatedFields.push("executable");
  if (view.args.length > MAX_DETAIL_ARGUMENTS
    || view.args.some((arg) => arg.length > MAX_DETAIL_ARGUMENT_CHARACTERS)) {
    truncatedFields.push("args");
  }
  if (view.cwd.length > MAX_DETAIL_PATH_CHARACTERS) truncatedFields.push("cwd");
  if (view.error && view.error.length > MAX_DETAIL_ERROR_CHARACTERS) truncatedFields.push("error");
  if (view.cleanup.errors.some((error) => error.length > MAX_DETAIL_ERROR_CHARACTERS)) {
    truncatedFields.push("cleanup.errors");
  }

  return {
    id: view.id,
    executable: compact(view.executable, MAX_DETAIL_ARGUMENT_CHARACTERS),
    args: view.args.slice(0, MAX_DETAIL_ARGUMENTS)
      .map((arg) => compact(arg, MAX_DETAIL_ARGUMENT_CHARACTERS)),
    omittedArguments: Math.max(0, view.args.length - MAX_DETAIL_ARGUMENTS),
    cwd: compact(view.cwd, MAX_DETAIL_PATH_CHARACTERS),
    pid: view.pid,
    pgid: view.pgid,
    state: view.state,
    active: view.active,
    startedAt: view.startedAt,
    endedAt: view.endedAt,
    exitCode: view.exitCode,
    exitSignal: view.exitSignal,
    stopReason: view.stopReason,
    error: view.error ? compact(view.error, MAX_DETAIL_ERROR_CHARACTERS) : undefined,
    cleanup: {
      ...view.cleanup,
      errors: view.cleanup.errors.map((error) => compact(error, MAX_DETAIL_ERROR_CHARACTERS)),
    },
    truncatedFields,
  };
}

interface SnapshotProcess {
  text: string;
  details: BoundedProcessView;
}

function snapshotProcess(view: ManagedProcessView): SnapshotProcess {
  return { text: viewText(view), details: boundedView(view) };
}

function minimalActiveSnapshot(view: ManagedProcessView): SnapshotProcess {
  const truncatedFields = [
    "executable",
    "args",
    "cwd",
    ...(view.error ? ["error"] : []),
    ...(view.cleanup.errors.length > 0 ? ["cleanup.errors"] : []),
  ];
  const processIds = view.pid === undefined ? "" : ` · pid ${view.pid} · pgid ${view.pgid}`;
  const stopReason = view.stopReason ? `\n  stop reason: ${view.stopReason}` : "";
  const text = `#${view.id} ${view.state}${processIds}\n  [Command, cwd, and diagnostic text omitted to keep every active record visible within ${MAX_SNAPSHOT_BYTES.toLocaleString("en-US")} bytes.]${stopReason}${cleanupText(view.cleanup)}`;
  return {
    text,
    details: {
      id: view.id,
      executable: "[omitted for bounded active snapshot]",
      args: [],
      omittedArguments: view.args.length,
      cwd: "[omitted for bounded active snapshot]",
      pid: view.pid,
      pgid: view.pgid,
      state: view.state,
      active: view.active,
      startedAt: view.startedAt,
      endedAt: view.endedAt,
      exitCode: view.exitCode,
      exitSignal: view.exitSignal,
      stopReason: view.stopReason,
      error: view.error ? "[omitted for bounded active snapshot]" : undefined,
      cleanup: {
        ...view.cleanup,
        errors: [],
        errorsOmitted: view.cleanup.errorsOmitted + view.cleanup.errors.length,
      },
      truncatedFields,
    },
  };
}

function withinSnapshotBudget(snapshot: { text: string; details: ProcessSnapshotDetails }): boolean {
  return Buffer.byteLength(snapshot.text, "utf8") <= MAX_SNAPSHOT_BYTES
    && Buffer.byteLength(JSON.stringify(snapshot.details), "utf8") <= MAX_SNAPSHOT_BYTES;
}

function processSnapshot(views: ManagedProcessView[]): {
  text: string;
  details: ProcessSnapshotDetails;
} {
  if (views.length === 0) {
    return {
      text: "No managed processes are known in this Pi session.",
      details: { processes: [], terminalHistory: { retained: 0, included: 0, omitted: 0 } },
    };
  }

  const active = views.filter((view) => view.active);
  const terminal = views.filter((view) => !view.active).reverse();
  let activeSnapshots = active.map(snapshotProcess);
  const includedTerminal: SnapshotProcess[] = [];
  const build = () => {
    const omitted = terminal.length - includedTerminal.length;
    const omission = omitted > 0
      ? `[${omitted} terminal process records omitted from this bounded snapshot.]`
      : "";
    const included = [...activeSnapshots, ...includedTerminal];
    const text = [...included.map((process) => process.text), omission].filter(Boolean).join("\n");
    const details: ProcessSnapshotDetails = {
      processes: included.map((process) => process.details),
      terminalHistory: {
        retained: terminal.length,
        included: includedTerminal.length,
        omitted,
      },
    };
    return { text, details };
  };

  if (!withinSnapshotBudget(build())) {
    activeSnapshots = active.map(minimalActiveSnapshot);
  }

  for (const view of terminal) {
    includedTerminal.push(snapshotProcess(view));
    if (!withinSnapshotBudget(build())) {
      includedTerminal.pop();
      break;
    }
  }
  return build();
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
    description: "Start a session-scoped long-running process from an executable plus literal arguments and cwd, without a shell. Returns only after the operating system accepts the spawn; this does not confirm application readiness, successful binding, eventual completion, or automatic wake delivery. It does not send a completion wake or trigger a turn when the process exits; observation and stop are explicit snapshot operations. The child inherits the Pi process environment, which may include credentials; stdin is ignored and no interactive TTY is allocated. On Unix the extension owns a process group for bounded stop and shutdown cleanup. That cleanup is resource hygiene, not a sandbox, ownership proof, security boundary, or supervision guarantee. It does not sandbox network access or force servers to bind loopback.",
    promptSnippet: "Start and explicitly manage a session-scoped long-running server, watcher, tail, or development process without an automatic completion wake",
    promptGuidelines: [
      "Use managed_process_start whenever the current task genuinely requires a long-running local process with an explicit snapshot and stop lifecycle, such as a server, watcher, tail, or development process. No separate confirmation is required merely because it runs in the background when it remains within the user's existing task authorization and safety constraints. Expected lifecycle, not elapsed seconds, distinguishes managed processes from finite work.",
      "Use ordinary bash for finite work that should complete synchronously in the current turn. Use scheduler_submit for fixed, non-interactive finite work that should run through OMQueue and wake Pi after its outcome.",
      "Before managed_process_start, inspect the executable, its direct helpers, literal arguments, cwd, inherited-environment needs, stdin or TTY assumptions, and network binding options without exposing credential values; prefer a verified absolute executable path.",
      "managed_process_start does not enforce loopback binding or sandbox network access; pass an application's verified loopback option when network exposure matters.",
      "After managed_process_start accepts a process, do not wait, sleep, or repeatedly poll. Continue independent work. One concrete bounded output/list snapshot or readiness probe is allowed when needed; later snapshots require a real diagnostic or decision need rather than waiting for change.",
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
          text: `The operating system accepted the spawn for managed process #${view.id}; its current observable state is ${view.state}. This confirms only spawn acceptance and does not confirm application readiness, successful binding, eventual completion, or automatic wake delivery. It is session-scoped. Pi shutdown will attempt bounded best-effort process-group cleanup as resource hygiene, not a security guarantee; descendants that deliberately escape the group may survive. Do not wait, sleep, or repeatedly poll it; continue useful work and request a bounded snapshot only when needed.`,
        }],
        details: boundedView(view),
      };
    },
  });

  pi.registerTool({
    name: "managed_process_list",
    label: "List Managed Processes",
    description: "Take one bounded snapshot of session-scoped managed processes and their observable lifecycle state. Every retained active process remains visible; omitted terminal history and oversized fields are identified. This is not a polling or wait operation.",
    promptGuidelines: [
      "Use managed_process_list for a concrete status snapshot, never in a repeated polling loop.",
    ],
    parameters: ListSchema,
    async execute() {
      const snapshot = processSnapshot(controller.list());
      return {
        content: [{ type: "text", text: snapshot.text }],
        details: snapshot.details,
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
    description: "Explicitly stop a known session-scoped managed process. On Unix this attempts SIGTERM and bounded SIGKILL escalation for its owned process group and reports signal, group, leader, and possible-leftover outcomes. A process that deliberately creates a new session or process group may escape this best-effort resource-hygiene mechanism; it is not a sandbox or security guarantee. Repeating stop for a known terminal process is safe.",
    promptGuidelines: [
      "Use managed_process_stop once a managed process is no longer needed. Session-shutdown cleanup is a fallback, not a reason to leave unnecessary processes active.",
    ],
    parameters: StopSchema,
    async execute(_id, params) {
      const view = await controller.stop(params.id);
      return { content: [{ type: "text", text: `Managed process ${viewText(view)}` }], details: boundedView(view) };
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
