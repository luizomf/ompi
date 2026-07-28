# Pi Scheduler

Language and boundaries for the opt-in Pi extension that submits
fire-and-forget scheduler wakes through the existing global `bq` wrapper.

## Language

**Scheduler extension**:
The Pi-facing adapter that owns scheduler submission, the live session callback
endpoint, and visible scheduler wake delivery. It delegates timing and durable
execution to `bq` and OMQueue.
_Avoid_: OMQueue client, Queue administrator, watcher, workflow engine

**Scheduler submission**:
One immediate `bq` acceptance request containing timing options, a required
reentry prompt, and an optional payload. The extension returns when `bq` exits;
it does not wait for the queued payload.
_Avoid_: Job completion, synchronous scheduler run, Queue watch

**Reentry prompt**:
The required self-contained instruction carried by every scheduler submission
and repeated in its wake. It preserves the deferred context, checks,
constraints, and next decision after delay or context compaction.
_Avoid_: Label, short notification, implicit conversation memory

**Payload**:
The optional executable, literal argument vector, and working directory run by
the callback runner before waking Pi. Omitting it creates a heartbeat-only wake.
Payloads are never shell command strings.
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
callback. It contains the complete reentry prompt, the callback runner's
mechanical payload outcome, and bounded stream previews. It is not an official
terminal OMQueue Job state.
_Avoid_: Queue completion event, watcher result, durable notification

## Boundary Contract

- `bq` owns timing syntax, timing validation, durable Job or Schedule
  acceptance, and OMQueue integration.
- OMQueue remains opaque to the scheduler extension.
- A scheduler submission invokes `bq` directly with a literal argument vector.
  It forwards valid XDG configuration, state, and runtime roots so `bq` reaches
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
  created and must not be retried blindly.
- Independently requested scheduler submissions may be issued as sibling tool
  calls so Pi can run their bounded acceptance requests concurrently. The
  orchestrator never waits for one scheduler wake before submitting another.
- The extension never calls `omqueue watch`, polls Job state, reads the Queue
  database, or exposes cancellation, retry, history, output retrieval, or other
  Queue administration.
- Raw `bq` invocation or inspection requested by the user remains ordinary bash
  work, not a scheduler submission.
- Scheduler wakes are best effort and session-scoped. Closing Pi, host loss,
  forced runner termination, or failure before the runner starts can prevent a
  wake. Durable schedules and payloads may continue after the owning Pi session
  closes.
