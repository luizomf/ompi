# Local Job Queue

Language for the durable local runtime that accepts and tracks independently submitted executable work. The queue treats any coordination inside that work as opaque.

## Language

**Job queue**:
The durable execution boundary that records submitted Jobs, their eligibility for execution, attempts, and outcomes. It does not interpret or coordinate the workflow inside a Job.
_Avoid_: Workflow engine, orchestrator, agent coordinator

**Job**:
One independently submitted unit of executable work tracked by the Job queue under a stable identity.
_Avoid_: Workflow, pipeline, step

**Attempt**:
One execution of a Job. A Job may have multiple Attempts while retaining its identity and history.
_Avoid_: Duplicate Job, workflow step

**Runner**:
An execution adapter selected by a Job that interprets its runner-specific payload. Pi or another model integration is one Runner type rather than a property of the Job queue.
_Avoid_: Queue backend, workflow engine

**Workflow**:
Coordination logic contained within a Job or its invoked program and therefore opaque to the Job queue.
_Avoid_: Queue lifecycle, retry policy
