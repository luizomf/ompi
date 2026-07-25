# Local Job Queue

Language for the durable local runtime that accepts and tracks independently submitted executable work. The queue treats any coordination inside that work as opaque.

## Language

**Job queue**:
The durable execution boundary that records submitted Jobs, their eligibility for execution, attempts, and outcomes. It does not interpret or coordinate the workflow inside a Job.
_Avoid_: Workflow engine, orchestrator, agent coordinator

**Job**:
One independently submitted unit of executable work tracked by the Job queue under a stable identity.
_Avoid_: Workflow, pipeline, step

**Job payload**:
Opaque runner-specific input stored and delivered by the Job queue but interpreted only by the selected Runner. A command payload uses a structured executable, argument vector, working directory, and optional standard input rather than implicit shell text.
_Avoid_: Queue instruction, workflow definition, raw shell command

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
A Runner's normalized report of success, failure, timeout, cancellation, or an unknown result, with concise diagnostics and an output reference. A Runner may suggest whether a failure is recoverable, but the Job queue applies the Job's retry policy.
_Avoid_: Raw runner output, retry decision

**Cancellation**:
A durable request to prevent a waiting Job from starting or to make its Runner terminate an active Attempt and wait for confirmation. It targets the execution tree the Runner controls, does not undo completed effects, and produces an unknown outcome when termination cannot be confirmed.
_Avoid_: Abandonment, rollback, fire-and-forget kill

**Runner**:
An execution adapter selected by a Job that interprets its runner-specific payload. Each active Attempt receives its own Runner instance, which handles only that Job; Pi or another model integration is one Runner type rather than a property of the Job queue.
_Avoid_: Shared job processor, queue backend, workflow engine

**Concurrency key**:
A caller-declared resource identity that prevents Jobs with the same key from having active Attempts at the same time while unrelated Jobs remain eligible for parallel dispatch.
_Avoid_: Runner identity, schedule slot, queue partition

**Queue daemon**:
The single long-lived local process that hosts the Scheduler and Dispatcher for one operating-system user on one host while durable state remains outside the process. It inherits that user's authority, is not a privilege or sandbox boundary, and does not coordinate a cluster or shared network-filesystem queue.
_Avoid_: System service, multi-user service, clustered service, OS cron, workflow daemon, separate scheduler service

**Scheduler**:
The Queue daemon component that turns due Occurrences into Jobs. It accepts explicit instants or calendar rules with an IANA time zone, never relative or natural-language dates.
_Avoid_: Dispatcher, workflow coordinator, natural-language date parser

**Schedule**:
A durable one-time instant or recurring calendar rule with one-minute resolution that produces Occurrences in an explicit IANA time zone.
_Avoid_: Job, relative date, sub-minute timer

**Occurrence**:
One planned firing of a Schedule, uniquely identified by its Schedule and precise scheduled instant.
_Avoid_: Attempt, approximate time

**Missed occurrence**:
An Occurrence whose scheduled instant passed while the Queue daemon was unavailable. It is recorded as missed for inspection and never backfilled into a Job.
_Avoid_: Pending Job, catch-up work

**Dispatcher**:
The Queue daemon component that claims executable Jobs and invokes their selected Runners.
_Avoid_: Scheduler, workflow coordinator

**Workflow**:
Coordination logic contained within a Job or its invoked program and therefore opaque to the Job queue.
_Avoid_: Queue lifecycle, retry policy
