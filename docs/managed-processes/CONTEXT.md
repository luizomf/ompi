# Managed Processes

Language and boundaries for the opt-in Pi extension that owns long-running local processes for one live session.

## Language

**Managed-process extension**:
The Pi-facing adapter that starts, observes, and terminates explicitly requested long-running local processes for the owning session.
_Avoid_: Background-tool wrapper, scheduler, daemon supervisor, sandbox

**Managed process**:
One executable with a literal argument vector and working directory accepted by the extension. It has a session-local numeric ID, captured output tails, and observable lifecycle state.
_Avoid_: Background operation, Queue Job, shell command, durable service

**Start confirmation**:
The immediate tool result emitted after the operating system accepts the spawn. It confirms neither application readiness nor eventual success.
_Avoid_: Health check, completion, successful server bind

**Process snapshot**:
One bounded list of retained managed-process records and their current observable state.
_Avoid_: Watch, polling loop, process table

**Output snapshot**:
Bounded recent stdout and stderr tails for one retained managed process. Earlier bytes may have been discarded.
_Avoid_: Complete log, streaming subscription, readiness probe

**Stop request**:
Explicit process-group termination with SIGTERM and bounded SIGKILL escalation on Unix. Repeating it for a retained terminal process is safe.
_Avoid_: Graceful application shutdown guarantee, arbitrary signal API

## Boundary contract

- The extension is separate from `extensions/background-tool.ts`. That wrapper owns finite read-only completion tasks; managed processes have explicit observation and termination lifecycles.
- A managed process is session-scoped and in memory. Records, output, and IDs do not survive reload, session replacement, or Pi exit.
- Start invokes the executable directly with a literal argument vector and `shell: false`. It does not perform shell expansion, interpolation, redirection, pipelines, or profile loading.
- The child inherits the active Pi process environment. That environment may include credentials, SSH-agent access, and other authority. The extension does not load `.env` files, accept environment overrides, or enumerate inherited values in diagnostics. Arguments are retained in the Pi session and may also be visible in the host process table, so secrets should not be passed through argv.
- Stdin is ignored and no interactive TTY is allocated. Programs that require prompts, terminal control, or interactive authentication are not supported managed-process candidates.
- The extension does not sandbox filesystem, subprocess, or network access. It cannot infer or force loopback binding; callers must inspect and pass the application's verified network-binding options. Start confirmation is not a readiness or health signal.
- On Unix, each child is a detached process-group leader. Explicit stop, natural leader exit, startup cancellation, and session shutdown signal the owned group with SIGTERM, then SIGKILL after a 750 ms grace period, followed by a bounded group-existence check. Signal permission failures, a surviving group, or a missing leader outcome become `cleanup_failed` rather than a false success. A descendant that deliberately creates a new session or process group can escape this OS mechanism. Starts are rejected on Windows because direct-child signaling cannot satisfy the ownership contract.
- Natural leader exit triggers group cleanup so ordinary descendants cannot keep a watcher or server alive after the managed leader ends.
- The extension retains at most eight active processes and sixty-four total records. Inputs allow at most 128 arguments, 8,000 UTF-8 bytes per argument, and 64 KiB across the full argument vector. Each process retains the latest 64 KiB from stdout and 64 KiB from stderr; each output snapshot returns at most 20 KiB per stream. Terminal records are evicted oldest-first without evicting active records.
- Output is untrusted and can contain control text or sensitive application data. It is returned as bounded text and must be reviewed before publication.
- The agent may start a managed process without separate confirmation whenever the user's existing task authorization and safety constraints already cover a genuinely required long-running local process. Expected lifecycle, not elapsed seconds, distinguishes it from finite work. Ordinary bash owns finite work that should complete synchronously in the current turn; `scheduler_submit` owns fixed, non-interactive finite work that should run through OMQueue and wake Pi after its outcome.
- The extension emits no automatic completion turn or wake. After start, one concrete bounded output/list snapshot or readiness probe is allowed when needed; later snapshots require a real diagnostic or decision need and must not become sleep or repeated polling loops.
- The agent explicitly stops a managed process once it is no longer needed. Session-shutdown cleanup is a fallback, not a reason to leave unnecessary processes active.
- Session shutdown awaits bounded termination attempts for active records, clears retained state, and removes its footer status.

## Implementation ownership

- `extensions/managed-process/controller.ts` owns process state, bounded buffers, process-group termination, limits, and shutdown.
- `extensions/managed-process/index.ts` owns Pi tool schemas, presentation, guidance, cwd resolution, and session lifecycle wiring.
- `just managed-processes` is the explicit isolated launch profile.
