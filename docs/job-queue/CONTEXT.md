# Local Job Queue

Language for the durable local runtime that accepts and tracks independently submitted executable work. The queue treats any coordination inside that work as opaque.

## Language

**OMQueue**:
The canonical product, repository, and command name for this Job queue. Using one explicit name keeps model instructions, diagnostics, process discovery, paths, and examples mechanically aligned.
_Avoid_: omq, generic queue command, different package and executable names

**Job queue**:
The durable execution boundary that records submitted Jobs, their eligibility for execution, attempts, and outcomes. It does not interpret or coordinate the workflow inside a Job.
_Avoid_: Workflow engine, orchestrator, agent coordinator

**Job Definition**:
A registered reusable Runner configuration and payload stored as a Queue-protocol-managed durable record that remains inert until a Trigger creates a Job from it. Each accepted edit creates an immutable numbered revision under the definition's stable identity; future Triggers use the current revision, each Job identifies its captured revision, and reverting creates another revision rather than rewriting history. Files may be applied or exported as documents but are never watched as live configuration or treated as a second source of truth. Disabling prevents new Triggers, while archiving removes the definition from normal discovery without deleting history or changing existing Jobs.
_Avoid_: Job, running service, mutable revision, watched configuration file, inline Hook script, destructive deletion

**Definition readiness**:
A computed host-specific diagnostic separate from a Job Definition's durable identity and revisions. Structural validation is mandatory for storage, while a structurally valid but host-unready definition may be stored disabled with all missing executable, Path root, and secret references reported together. Enabling requires a successful readiness check at that instant; later host drift is reported without silently rewriting or disabling the definition.
_Avoid_: Invalid stored schema, hidden missing dependency, permanent host binding, automatic definition edit

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

**Attempt lease**:
A renewable fenced ownership claim bound to one Attempt supervisor. Expiry prompts reconciliation but never authorizes redelivery: a matching live supervisor remains running, a terminal packet is finalized, and missing execution evidence produces an unknown outcome requiring explicit recovery.
_Avoid_: Retry timer, duplicate-execution permission, success evidence

**Attempt outcome**:
A Runner's normalized mechanical report of running state or terminal success, failure, timeout, cancellation, or an unknown result, with process exit metadata, concise diagnostics, and Output or Result artifact references. It does not interpret service-specific content; a Runner may suggest whether a failure is recoverable, but the Job queue applies the Job's Retry policy. A terminal outcome is immutable: an unknown result cannot be manually relabeled as success or failure without mechanical evidence.
_Avoid_: Business-result interpretation, raw runner output, retry decision, operator-declared outcome

**Queue error code**:
A stable mechanical classification owned by the Job queue for its own validation, storage, lifecycle, resource, and Runner-control failures. Wrapper and service diagnostics remain opaque and are never promoted into provider-specific queue codes.
_Avoid_: Provider error catalog, model interpretation, raw error text

**Job state**:
The public lifecycle value `queued`, `running`, `retry_wait`, `succeeded`, `failed`, `cancel_requested`, `cancelled`, or `unknown`. Claims and leases remain Attempt details; a Dead Letter is a failed Job with no automatic progress remaining, not a separate state.
_Avoid_: Internal claim state, provider-specific status, Dead Letter as lifecycle value

**Job summary**:
The compact structured Queue-protocol view of a Job's definition revision, state, exact timestamps, Attempt count, next action, outcome code, concise diagnostic, bounded Output previews, and direct artifact or event references. It centralizes the evidence an operator or model needs to choose the next action without discovering or correlating host files.
_Avoid_: Raw log, prose reconstruction, filesystem scavenger hunt

**Output artifact**:
Runner stdout or stderr streamed outside memory and queryable queue state under a configurable per-Attempt size limit, then referenced by an Attempt outcome with bounded previews in the Job summary. It is diagnostic evidence, never the service result; exceeding the limit fails the Attempt explicitly, and retained bytes expire under configured retention while structured metadata remains.
_Avoid_: Service result, buffered process output, silently truncated success, database log blob, permanent raw history, status message

**Result artifact**:
An opaque service result that a wrapper may write atomically to the supervisor-provided result path and that the Job queue attaches when present. Absence is a normal null reference; the queue verifies only path ownership and resource bounds, never presence, schema, or service-specific meaning.
_Avoid_: Required result mode, parsed stdout, queue-generated business result, model response contract

**Retry policy**:
A Job Definition's limit and backoff for additional Attempts. It defaults to one Attempt, must be explicitly enabled for automatic retries, and never automatically retries an unknown outcome. Manual retry adds an Attempt from the failed or unknown Job's immutable snapshot; retrying an unknown Job requires explicit acknowledgement that external effects may be repeated, while the unknown Attempt remains unchanged in history. A new Trigger creates a new Job from the current definition.
_Avoid_: Runner decision, snapshot mutation, relabeled outcome, unconditional retry

**Execution timeout**:
An optional Job Definition limit that initiates Cancellation and records a timed-out Attempt when exceeded. Jobs have no mandatory or inferred timeout because valid execution duration is workload-dependent.
_Avoid_: Global deadline, duration guess, queue-stall prevention

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

**Queue installation**:
One independent Job queue owned by one operating-system user on one host, including its local configuration, database, artifacts, socket, and Attempt supervisors. macOS and Linux installations do not replicate runtime identity or state; portable Job Definition and Schedule documents may be applied independently and become local revisions after host readiness validation.
_Avoid_: Cluster member, replicated queue, copied runtime directory, shared supervisor

**Queue daemon**:
The single long-lived local process that hosts the Scheduler and Dispatcher for one Queue installation while durable state remains outside the process. Stopping or restarting it preserves active Attempt supervisors by default; terminating work always requires explicit Cancellation.
_Avoid_: System service, multi-user service, clustered service, OS cron, workflow daemon, separate scheduler service

**Startup adapter**:
An optional user-level platform integration that starts the portable Queue daemon through launchd or systemd without exposing Job Definitions or adding platform behavior to the core. Its convergent installation creates or updates and enables the user service, starts the daemon, and reports success only after Queue-protocol verification; failed verification leaves the adapter inspectable and returns actionable diagnostics.
_Avoid_: Queue daemon, mandatory installer, root service, adapter-only installation

**Queue protocol**:
The versioned structured local interface through which all clients manage and observe the Queue daemon. CLI and model integrations are presentation adapters and never read the database or artifact files directly.
_Avoid_: SQLite API, log scraping, model-specific backend

**Queue event**:
An append-only structured lifecycle record with a durable sequence, available for catch-up and live subscription through the Queue protocol.
_Avoid_: Log line, conversational notification

**Agent adapter**:
A model-specific Queue protocol client that owns its event cursor, target-session availability, delivery result, inbox behavior, and conversation wake-up without adding agent concepts to the Job queue. The Queue daemon records the scheduled Job and its mechanical outcome but does not keep a harness alive, launch a missing harness, or claim that a conversation received a message.
_Avoid_: Queue daemon, shared model backend, harness supervisor, assumed delivery

**Agent notification policy**:
An adapter-owned per-submission choice for whether terminal Queue events wake the originating conversation. `failure`, the default, delivers final failure or unknown outcomes; `terminal` delivers every terminal outcome; and `none` keeps execution silent. A submission unrelated to a conversation has no origin target, while Queue events remain durable and observable regardless of notification policy.
_Avoid_: Queue retry policy, mandatory wake-up, missing Queue event, assumed origin conversation

**Deferred agent prompt**:
An adapter-owned instruction captured durably as Trigger input and later delivered as a new user message to a target live conversation. It may be authored by the user or by a model acting within the user's granted authority, and its delivery envelope identifies the source request, Schedule, and exact due instant so compaction cannot erase the immediate task. Runner output can be referenced as untrusted evidence but never becomes or modifies an authorized prompt automatically.
_Avoid_: Queue-owned agent instruction, reconstructed context, stdout as prompt, implicit authority escalation

**Scheduler**:
The Queue daemon component that turns due Occurrences into Jobs. It accepts explicit instants or calendar rules with an IANA time zone, never relative or natural-language dates.
_Avoid_: Dispatcher, workflow coordinator, natural-language date parser

**Schedule**:
A durable one-time ISO 8601 instant or recurring five-field cron expression with one-minute resolution that produces Occurrences for one Job Definition in an explicit IANA time zone. It has a stable identity and immutable numbered revisions: editing its rule, target, Trigger input, or Late policy creates a revision used only by future Occurrences, while recorded Occurrences identify the revision that planned them. Each terminal Job leaves future recurrence unchanged; the Schedule permits at most one nonterminal Job at a time, disabling or archiving affects only future Occurrences, a nonexistent daylight-saving minute produces nothing, and a repeated local minute produces at most one Occurrence.
_Avoid_: Job, mutable revision, overlapping execution, failure-driven auto-disable, relative date, sub-minute timer, custom recurrence language, destructive deletion, implicit catch-up

**Schedule status**:
The administrative lifecycle value `enabled`, `disabled`, `completed`, or `archived`. A one-time Schedule becomes `completed` after its sole due instant is durably accounted for as fired or missed; its summary links directly to the Occurrence and resulting Job when one exists. A recurring Schedule remains enabled after a late or terminal Job and keeps its original calendar cadence.
_Avoid_: Job state, hidden one-time history, recurrence shifted by downtime

**Occurrence**:
One planned firing of a Schedule, uniquely identified by its Schedule, local calendar minute, and time zone, with the resolved precise instant retained for execution and audit.
_Avoid_: Attempt, duplicate daylight-saving instant, approximate time

**Late policy**:
A Schedule's explicit response when one or more due instants pass while the Queue daemon is unavailable or the host clock jumps forward. `skip`, the default, records them as missed without creating a Job. `fire_once` coalesces the due instants into one late Job for the newest Occurrence and records its lateness, preventing a catch-up burst.
_Avoid_: Silent late execution, one Job per missed recurrence, implicit backfill

**Missed occurrence**:
An Occurrence whose scheduled instant passed under a Schedule's `skip` Late policy, or an older due Occurrence coalesced by `fire_once`. It is retained as scheduling evidence and never becomes a pending Job.
_Avoid_: Pending Job, invisible gap, catch-up work

**Overlap-skipped occurrence**:
An Occurrence that does not create a Job because the same Schedule already has a nonterminal Job. It is retained as scheduling evidence rather than queued for later.
_Avoid_: Pending Job, concurrency-key wait

**Dispatcher**:
The Queue daemon component that claims executable Jobs in deterministic FIFO order by eligibility and identity, then invokes their selected Runners up to a configurable host-wide active-Attempt limit. It neither prioritizes nor preempts Jobs; the limit is a resource-exhaustion fuse, not submission or scheduling capacity.
_Avoid_: Scheduler, workflow coordinator, priority scheduler, schedule slot allocator

**Workflow**:
Coordination logic contained within a Job or its invoked program and therefore opaque to the Job queue.
_Avoid_: Queue lifecycle, retry policy
