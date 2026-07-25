# Local Job Queue

Language for the durable local runtime that accepts and tracks independently submitted executable work. The queue treats any coordination inside that work as opaque.

## Language

**Job queue**:
The durable execution boundary that records submitted Jobs, their eligibility for execution, attempts, and outcomes. It does not interpret or coordinate the workflow inside a Job.
_Avoid_: Workflow engine, orchestrator, agent coordinator

**Job Definition**:
A registered reusable Runner configuration and payload that remains inert until a Trigger creates a Job from it.
_Avoid_: Job, running service, inline Hook script

**Job**:
One execution created from a Job Definition and tracked by the Job queue under a stable identity.
_Avoid_: Job Definition, Workflow, pipeline, step

**Trigger**:
A durable request that creates a Job from a Job Definition. A Trigger may be manual, produced by a Schedule Occurrence, or produced by a Hook.
_Avoid_: Job, inline execution, workflow transition

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
The explicit environment assembled for one Job from a small daemon baseline, declared non-secret values, and named secret references. It never inherits the submitting client's environment or loads `.env` automatically, and sensitive values are redacted from the Queue protocol and diagnostics.
_Avoid_: Client environment snapshot, automatic `.env`, logged secret

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

**Attempt outcome**:
A Runner's normalized report of success, failure, timeout, cancellation, or an unknown result, with concise diagnostics and an Output artifact reference. A Runner may suggest whether a failure is recoverable, but the Job queue applies the Job's Retry policy.
_Avoid_: Raw runner output, retry decision

**Job summary**:
The compact structured view of a Job's current state, exact timestamps, Attempt count, next action, outcome code, and concise diagnostic.
_Avoid_: Raw log, prose reconstruction

**Output artifact**:
Runner output stored outside the queryable queue state and referenced by an Attempt outcome, with bounded previews available through the Job summary.
_Avoid_: Database log blob, status message

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
The foundational Runner that invokes one structured executable with arguments, working directory, standard input, and Job environment while treating nested tools and services as opaque. A command remains responsible for cleaning up external resources it creates.
_Avoid_: Shell evaluator, model adapter, Docker adapter

**Concurrency key**:
A caller-declared resource identity that prevents Jobs with the same key from having active Attempts at the same time while unrelated Jobs remain eligible for parallel dispatch.
_Avoid_: Runner identity, schedule slot, queue partition

**Queue daemon**:
The single long-lived local process that hosts the Scheduler and Dispatcher for one operating-system user on one host while durable state remains outside the process. It inherits that user's authority, is not a privilege or sandbox boundary, and does not coordinate a cluster or shared network-filesystem queue.
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
A durable one-time ISO 8601 instant or recurring five-field cron expression with one-minute resolution that produces Occurrences for one Job Definition in an explicit IANA time zone.
_Avoid_: Job, relative date, sub-minute timer, custom recurrence language

**Occurrence**:
One planned firing of a Schedule, uniquely identified by its Schedule and precise scheduled instant.
_Avoid_: Attempt, approximate time

**Missed occurrence**:
An Occurrence whose scheduled instant passed while the Queue daemon was unavailable. It is recorded as missed for inspection and never backfilled into a Job.
_Avoid_: Pending Job, catch-up work

**Dispatcher**:
The Queue daemon component that claims executable Jobs and invokes their selected Runners up to a configurable host-wide active-Attempt limit. The limit is a resource-exhaustion fuse, not submission or scheduling capacity.
_Avoid_: Scheduler, workflow coordinator, schedule slot allocator

**Workflow**:
Coordination logic contained within a Job or its invoked program and therefore opaque to the Job queue.
_Avoid_: Queue lifecycle, retry policy
