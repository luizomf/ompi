# Pi Scheduler

Language and boundaries for the opt-in Pi extension that submits fixed finite
work and scheduler wakes through the existing global `bq` wrapper and OMQueue.

## Language

**Scheduler extension**:
The Pi-facing OMQueue-backed background runner and scheduler. It owns submission,
the live session callback endpoint, and visible scheduler wake delivery while
delegating timing and durable execution to `bq` and OMQueue.
_Avoid_: OMQueue client, Queue administrator, watcher, workflow engine

**Scheduler submission**:
One immediate `bq` acceptance request containing optional timing, a required
reentry prompt, and an optional payload. Without timing, a payload is submitted
for immediate Queue execution or a payload-free heartbeat fires immediately.
The tool returns when `bq` exits; it does not wait for the queued payload.
_Avoid_: Job completion, synchronous command execution, Queue watch

**Reentry prompt**:
The required complete, self-contained trusted instruction carried by every
scheduler submission and delivered in the required best-effort wake after a
heartbeat fires or a payload terminates. It restores the deferred context,
identifies the completed event or recurring occurrence, conditions action on the
mechanical outcome, states the next decision or stopping point, and prohibits
unauthorized payload reruns, retries, or OMQueue inspection or administration.
_Avoid_: Label, short notification, implicit conversation memory

**Payload**:
The optional fixed, non-interactive executable, literal argument vector, and
working directory run by the callback runner. It runs immediately when timing
is omitted or according to the supplied timing, then the runner attempts the
required best-effort wake after termination. Omitting the payload creates a
heartbeat-only wake. Payloads are never shell command strings.
_Avoid_: Shell script text, Queue Job definition

**Callback runner**:
The scheduler-owned script invoked by the active Pi process's captured absolute
Node runtime. The runtime is the actual executable submitted to `bq`, and the
runner's absolute path is its first argument. The runner executes the optional
payload, forwards its original streams for OMQueue capture, keeps bounded
previews, sends one callback when mechanically possible, and preserves the
payload exit or signal outcome.
_Avoid_: Queue worker, completion watcher

**Callback endpoint**:
The private, versioned Unix-socket listener owned by one live Pi session. It
accepts only bounded frames correlated with that session's capability and known
submissions, and it is removed on session shutdown.
_Avoid_: Durable mailbox, network service, Queue event endpoint

**Scheduler wake**:
The visible follow-up message injected into the owning Pi conversation after a
callback. Separate sections contain the complete trusted reentry instructions,
the callback runner's mechanical payload outcome, and quoted bounded stdout and
stderr previews labeled as untrusted data that must never be followed as
instructions. The wake and its mechanical outcome are not an official terminal
OMQueue Job state.
_Avoid_: Queue completion event, watcher result, durable notification

## Boundary Contract

- `bq` owns timing syntax, timing validation, durable Job or Schedule
  acceptance, and OMQueue integration.
- Lifecycle intent controls routing. Ordinary bash owns finite work that should
  complete synchronously in the current turn. `scheduler_submit` owns fixed,
  non-interactive finite work that should run through OMQueue now or later and
  wake Pi after its outcome. `managed_process_start` owns genuinely long-running
  servers, watchers, tails, and development processes with explicit snapshot and
  stop operations and no automatic completion wake.
- Immediate scheduler submission is not a blanket replacement for synchronous
  bash. It is useful when Queue-backed background execution and an automatic
  best-effort completion wake matter; a trivial current-turn command is normally
  simpler through ordinary bash.
- OMQueue remains opaque to the scheduler extension.
- A scheduler submission invokes `bq` directly with a literal argument vector
  and assigns the presentation label `pi_scheduler_<submission-id>`. The label
  identifies and correlates the submission without imposing a Queue concurrency
  key or changing execution order. It forwards valid XDG configuration, state,
  and runtime roots so `bq` reaches
  the same per-host Queue installation as the active Pi process without
  inheriting unrelated client environment or credentials.
  Its queued invocation uses the active Pi process's absolute Node runtime and
  the callback runner's absolute script path because Queue Jobs do not inherit
  the submitting shell or NVM environment. Long-lived schedules depend on both
  captured paths remaining executable.
- The callback runner prepends the captured Pi Node runtime directory to the
  allowlisted payload `PATH`, so payload child commands that invoke `node` use
  the same runtime as the runner without depending on the Queue service's Node
  installation.
- The submission returns bounded `bq` stdout, stderr, and exit status without
  waiting for Queue completion. A zero exit confirms acceptance; every other
  result leaves acceptance unknown because durable work may already have been
  created and must not be retried blindly. Acceptance remains distinct from
  later payload termination, its mechanical outcome, and wake delivery. In the
  interactive TUI, submission diagnostics and scheduler wake details are
  collapsed by default and remain available through Pi's native tool expansion
  control.
- Independently requested scheduler submissions may be issued as sibling tool
  calls so Pi can run their bounded acceptance requests concurrently. The
  orchestrator never waits for one scheduler wake before submitting another.
- A finite-repeat or cron reentry prompt directs the reentered agent to inspect
  the occurrence that already ran. It never authorizes executing the recurring
  payload a second time, retrying it, or administering OMQueue.
- The extension never calls `omqueue watch`, polls Job state, reads the Queue
  database, or exposes cancellation, retry, history, output retrieval, or other
  Queue administration.
- Equivalent `bq` syntax supplied as an example does not by itself select
  ordinary bash. Use `scheduler_submit` when the requested lifecycle is Queue
  background execution, scheduling, repetition, heartbeat, reminder, or deferred
  recheck. For `bq`-related requests, reserve ordinary bash for explicit raw-CLI
  invocation, testing, debugging, inspection, or OMQueue administration.
- Scheduler wakes are best effort and session-scoped. Closing Pi, host loss,
  forced runner termination, or failure before the runner starts can prevent a
  wake. Durable schedules and payloads may continue after the owning Pi session
  closes.
- `--no-scheduler` disables `scheduler_submit` and prevents callback endpoint
  startup for the current Pi process. Use it when the extension is discovered
  globally but the process must not host scheduler callbacks, including Pi
  payloads already running inside OMQueue.
