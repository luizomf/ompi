# Context Map

Use this map to choose the domain context that owns the behavior being changed.
Read only the contexts that intersect the accepted request.

| Context | Read it when the work affects | Canonical document |
| --- | --- | --- |
| Session Background Tools | Selected finite tool work with synchronous print-mode results or one later session-scoped result outside print mode; each tool retains its own effect boundary | [Session Background Tools](./docs/background-tools/CONTEXT.md) |
| Managed Processes | Genuinely long-running local processes with explicit start, snapshot, output, and stop operations | [Managed Processes](./docs/managed-processes/CONTEXT.md) |
| Pi Scheduler | Immediate or timed finite OMQueue work, heartbeats, repeats, cron, and best-effort wakes into a live Pi session | [Pi Scheduler](./docs/scheduler/CONTEXT.md) |
| Pi Subagents | Independent native Pi conversations, routing inheritance, steering, interruption, and mode-dependent direct results or completion pongs | [Pi Subagents](./docs/subagents/CONTEXT.md) |

This file owns the current context inventory and one-line routing descriptions.
Each linked context document owns its canonical terms, lifecycle contract,
security boundaries, and implementation ownership. `AGENTS.md` explains how to
orient and verify repository work; `README.md` documents public setup and usage.

Do not turn this map into a duplicate specification. Add a context only when an
experiment develops its own durable language or boundaries, and update this map
in the same change.
