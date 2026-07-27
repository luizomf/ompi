# Session Background Tools

Language and boundaries for the small internal wrapper that lets selected Pi tools release the current tool call while read-only work continues in the live session.

## Language

**Background tool wrapper**:
The reusable mechanical interface that adapts an explicitly selected read-only Pi tool definition for session-scoped asynchronous execution. It preserves the tool's input schema and execution function while owning lifecycle, concurrency, status, and result delivery.
_Avoid_: Scheduler, generic tool executor, workflow engine

**Background operation**:
One invocation accepted by the wrapper and running independently of the originating agent turn. It has a session-local numeric ID and uses a dedicated abort signal.
_Avoid_: Queue Job, cron run, subagent

**Start confirmation**:
The immediate tool result stating that the wrapper accepted a background operation. It is not evidence that the underlying operation will succeed.
_Avoid_: Completion, scheduler acceptance

**Background result**:
The wrapper's single follow-up message after an accepted operation completes or fails. Full text remains in model context while the TUI collapses it by default.
_Avoid_: Scheduler wake, pong, polling response

## Boundary contract

- The wrapper is opt-in through `wrapReadOnly`; it is not an agent-facing tool that can execute arbitrary registered tools.
- Only definitions available to the owning extension can be wrapped. Pi's tool metadata API does not expose third-party execution functions.
- Wrapped work is session-scoped and in-memory. It does not use `bq`, OMQueue, cron, persistence, or durable callbacks.
- The wrapper supplies a dedicated abort signal after acceptance, so later cancellation of the originating agent turn does not accidentally cancel independent work.
- Eligible tool implementations capture required plain context such as `cwd` before their first asynchronous boundary and do not retain session-bound `ctx` objects for later use.
- Session shutdown aborts active operations, clears visible status, and suppresses late results from the stale extension instance.
- The wrapped tool remains responsible for bounded output, process cleanup, timeout behavior, and safe read-only operation.
- Eligible tools produce text and do not depend on synchronous `usage`, `addedToolNames`, `terminate`, image delivery, or a custom result renderer. Structured result details are retained for inspection; non-text content is marked as omitted rather than silently discarded.
- Mutating tools must not use this wrapper because their delayed effects could race with later agent turns and file operations.
- A live footer count exposes active operations without transcript polling.

## Implementation ownership

The canonical wrapper source is `extensions/background-tool.ts`. Eligible extension directories expose relative `background-tool.ts` symlink aliases so imports remain loadable when those directories are themselves reached through Pi's global extension symlinks. Browser Fetch and Codex Search must import those aliases rather than maintain copies.

## Turn-release contract

After start confirmation, the orchestrator must not wait, sleep, or poll for the background result. It may continue useful work independent of that result; otherwise it ends its response so the later result can enter the conversation as a follow-up turn.
