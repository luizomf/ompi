# Local Job Queue

Language for the durable local runtime that accepts and tracks independently submitted executable work. The queue treats any coordination inside that work as opaque.

## Language

**Job queue**:
The durable execution boundary that records submitted Jobs, their eligibility for execution, attempts, and outcomes. It does not interpret or coordinate the workflow inside a Job.
_Avoid_: Workflow engine, orchestrator, agent coordinator

**Job Definition**:
A registered reusable Runner configuration and payload that remains inert until a Trigger creates a Job from it. Disabling prevents new Triggers, while archiving removes it from normal discovery without deleting history or changing existing Jobs.
_Avoid_: Job, running service, inline Hook script, destructive deletion

**Job**:
One execution created from a Job Definition and tracked by the Job queue under a stable identity. It owns an immutable snapshot of the definition accepted by its Trigger, so later definition edits affect only future Jobs.
_Avoid_: Job Definition, mutable execution plan, Workflow, pipeline, step

**Trigger**:
A durable request that creates a Job from a Job Definition. A Trigger may be manual, produced by a Schedule Occurrence, or produced by a Hook.
_Avoid_: Job, inline execution, workflow transition

**Trigger input**:
A JSON value validated against the Job Definition's declared schema and captured in the Job snapshot. Command mappings may pass complete input values as argument or standard-input values but never evaluate shell or textual templates.
_Avoid_: Definition edit, shell interpolation, unvalidated form field

**Hook**:
A registered reaction to a terminal Job event that durably Triggers another Job Definition without changing or waiting on the source Job's outcome.
_Avoid_: Dependency, callback script, workflow edge

**Hook cascade**:
A causal sequence of Hook-triggered Jobs bounded by a configurable depth fuse. The Job queue carries only the current depth and does not build or validate a workflow graph.
_Avoid_: Dependency graph, cycle detection, Schedule

**Job payload**:
Opaque runner-specific input stored and delivered by the Job queue but interpreted only by the selected Runner. A command payload uses a structured executable, argument vector, working directory, and optional standard input rather than implicit shell text.
_Avoid_: Queue instruction, workflow definition, raw shell command

**Job environment**:
The explicit environment assembled for one Job from a small daemon baseline, declared non-secret values, named secret references, and an isolated per-Attempt temporary directory exposed through standard temporary-directory variables. It never inherits the submitting client's environment or loads `.env` automatically; sensitive values are redacted, and undeclared temporary files are removed after termination or confirmed orphan recovery.
_Avoid_: Client environment snapshot, shared temporary directory, automatic `.env`, logged secret

**Path root**:
A named host-local mapping used by Job Definitions to resolve portable executable, working-directory, and input paths. Absolute paths remain valid but are reported as host-specific.
_Avoid_: Embedded home directory, shell tilde expansion, hidden path rewrite

**Job submission**:
The atomic durable acceptance of a Job that returns its identity and initial status without waiting for a Runner to start or finish.
_Avoid_: Job completion, synchronous execution

**Idempotency key**:
A caller-chosen identity for retrying one uncertain Job submission. Reusing it with the same payload returns the original Job; reusing it with a different payload is a conflict.
_Avoid_: Job ID, timestamp deduplication

**Attempt**:
One execution of a Job. A Job may have multiple Attempts while retaining its identity and history.
_Avoid_: Duplicate Job, workflow step

**Attempt supervisor**:
The independent single-Attempt process that owns its Runner process tree, control channel, output capture, and atomic terminal packet. It can outlive and reconnect to a restarted Queue daemon but never writes queue state directly.
_Avoid_: Worker pool, Queue daemon, direct database writer

**Attempt outcome**:
A Runner's normalized mechanical report of running state or terminal success, failure, timeout, cancellation, or an unknown result, with process exit metadata, concise diagnostics, and Output or Result artifact references. It does not interpret service-specific content; a Runner may suggest whether a failure is recoverable, but the Job queue applies the Job's Retry policy.
_Avoid_: Business-result interpretation, raw runner output, retry decision

**Job summary**:
The compact structured view of a Job's current state, exact timestamps, Attempt count, next action, outcome code, and concise diagnostic.
_Avoid_: Raw log, prose reconstruction

**Output artifact**:
Runner stdout or stderr streamed outside memory and queryable queue state under a configurable per-Attempt size limit, then referenced by an Attempt outcome with bounded previews in the Job summary. It is diagnostic evidence, never the service result; exceeding the limit fails the Attempt explicitly, and retained bytes expire under configured retention while structured metadata remains.
_Avoid_: Service result, buffered process output, silently truncated success, database log blob, permanent raw history, status message

**Result artifact**:
An opaque service result that a wrapper may write atomically to the supervisor-provided result path and that the Job queue attaches when present. Absence is a normal null reference; the queue verifies only path ownership and resource bounds, never presence, schema, or service-specific meaning.
_Avoid_: Required result mode, parsed stdout, queue-generated business result, model response contract

**Retry policy**:
A Job Definition's limit and backoff for additional Attempts. It defaults to one Attempt, must be explicitly enabled for automatic retries, and never automatically retries an unknown outcome.
_Avoid_: Runner decision, unconditional retry

**Dead Letter**:
A failed Job that has no automatic Attempts remaining and stays inspectable until an explicit recovery decision.
_Avoid_: Deleted failure, automatic retry queue

**Cancellation**:
A durable request to prevent a waiting Job from starting or to make its Runner terminate an active Attempt and wait for confirmation. It targets the execution tree the Runner controls, does not undo completed effects, and produces an unknown outcome when termination cannot be confirmed.
_Avoid_: Abandonment, rollback, fire-and-forget kill

**Runner**:
An execution adapter selected by a Job that interprets its runner-specific payload. Each active Attempt receives its own Runner instance, which handles only that Job.
_Avoid_: Shared job processor, queue backend, workflow engine

**Command Runner**:
The generic Runner that invokes one structured executable with arguments, working directory, standard input, Job environment, and an optional supervisor-provided result path while treating nested tools and services as opaque. Harness and container integrations belong behind invoked wrappers, and a command remains responsible for result validation and cleaning up external resources it creates.
_Avoid_: Shell evaluator, stdout parser, model adapter, Docker adapter

**Concurrency key**:
A caller-declared resource identity that prevents Jobs with the same key from having active Attempts at the same time while unrelated Jobs remain eligible for parallel dispatch.
_Avoid_: Runner identity, schedule slot, queue partition

**Queue daemon**:
The single long-lived local process that hosts the Scheduler and Dispatcher for one operating-system user on one host while durable state remains outside the process. Stopping or restarting it preserves active Attempt supervisors by default; terminating work always requires explicit Cancellation.
_Avoid_: System service, multi-user service, clustered service, OS cron, workflow daemon, separate scheduler service

**Startup adapter**:
An optional user-level platform integration that starts the portable Queue daemon through launchd or systemd without exposing Job Definitions or adding platform behavior to the core.
_Avoid_: Queue daemon, mandatory installer, root service

**Queue protocol**:
The versioned structured local interface through which all clients manage and observe the Queue daemon. CLI and model integrations are presentation adapters and never read the database or artifact files directly.
_Avoid_: SQLite API, log scraping, model-specific backend

**Queue event**:
An append-only structured lifecycle record with a durable sequence, available for catch-up and live subscription through the Queue protocol.
_Avoid_: Log line, conversational notification

**Agent adapter**:
A model-specific Queue protocol client that owns its event cursor, inbox behavior, and conversation wake-up without adding agent concepts to the Job queue.
_Avoid_: Queue daemon, shared model backend

**Scheduler**:
The Queue daemon component that turns due Occurrences into Jobs. It accepts explicit instants or calendar rules with an IANA time zone, never relative or natural-language dates.
_Avoid_: Dispatcher, workflow coordinator, natural-language date parser

**Schedule**:
A durable one-time ISO 8601 instant or recurring five-field cron expression with one-minute resolution that produces Occurrences for one Job Definition in an explicit IANA time zone. Disabling or archiving affects only future Occurrences; a nonexistent daylight-saving minute produces nothing, and a repeated local minute produces at most one Occurrence.
_Avoid_: Job, relative date, sub-minute timer, custom recurrence language, destructive deletion, daylight-saving catch-up

**Occurrence**:
One planned firing of a Schedule, uniquely identified by its Schedule, local calendar minute, and time zone, with the resolved precise instant retained for execution and audit.
_Avoid_: Attempt, duplicate daylight-saving instant, approximate time

**Missed occurrence**:
An Occurrence whose scheduled instant passed while the Queue daemon was unavailable. It is recorded as missed for inspection and never backfilled into a Job.
_Avoid_: Pending Job, catch-up work

**Dispatcher**:
The Queue daemon component that claims executable Jobs in deterministic FIFO order by eligibility and identity, then invokes their selected Runners up to a configurable host-wide active-Attempt limit. It neither prioritizes nor preempts Jobs; the limit is a resource-exhaustion fuse, not submission or scheduling capacity.
_Avoid_: Scheduler, workflow coordinator, priority scheduler, schedule slot allocator

**Workflow**:
Coordination logic contained within a Job or its invoked program and therefore opaque to the Job queue.
_Avoid_: Queue lifecycle, retry policy
