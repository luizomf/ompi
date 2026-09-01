# Session Background Tools

Language and boundaries for the small internal wrapper that lets selected finite
Pi tools release the current tool call outside print mode while their work
continues in the live session.

## Language

**Background tool wrapper**:
The reusable mechanical interface that adapts an explicitly selected finite,
text-result Pi tool definition for session-scoped execution. It preserves the
tool's schema and execution function while owning mode behavior, lifecycle,
concurrency, status, and result delivery. The wrapped tool still owns its effect
and authorization boundary.
_Avoid_: Scheduler, generic tool executor, workflow engine

**Background operation**:
One invocation accepted by the wrapper. Outside print mode it runs independently
of the originating agent turn; in print mode the original tool call remains
pending. It has a session-local numeric ID and a dedicated abort signal.
_Avoid_: Queue Job, cron run, subagent

**Start confirmation**:
The immediate outside-print-mode tool result stating that the wrapper accepted a
background operation. It is not evidence that the underlying operation will
succeed, and it states that later delivery is possible only while the owning Pi
session remains live.
_Avoid_: Completion, scheduler acceptance

**Background result**:
Outside print mode, the wrapper's single follow-up message after an accepted
operation completes or fails, delivered only by the owning live Pi session and
worded to preserve that boundary. Full text remains in model context while the
TUI collapses it by default. In print mode, the same underlying result returns
directly from the original tool call instead.
_Avoid_: Scheduler wake, pong, polling response

## Boundary contract

- The wrapper is opt-in through `wrapTool`; it is not an agent-facing tool that
  can execute arbitrary registered tools.
- Only definitions available to the owning extension can be wrapped. Pi's tool
  metadata API does not expose third-party execution functions.
- Wrapped work is finite, session-scoped, and in memory. It does not use `bq`,
  OMQueue, cron, persistence, or durable callbacks.
- The wrapper owns execution mechanics, not permission. Each wrapped tool remains
  responsible for validating its input, authorization, filesystem and network
  effects, bounded output, process cleanup, and timeout behavior.
- Read-only tools are the safest default. A tool with an optional mutating mode
  is eligible only when its default remains non-mutating, the capability is
  explicit in its schema and guidance, the user authorizes it, and its effect
  scope or lack of isolation is documented. Prefer constrained effects;
  unsandboxed modes require their own specific authorization. Arbitrary or
  implicitly mutating file tools must not use the wrapper.
- Outside print mode, delayed effects can race with later turns. After start
  confirmation the agent may continue only independent work and must not read or
  modify overlapping paths until the background result arrives.
- Outside print mode, the wrapper supplies a dedicated abort signal after
  acceptance, so later cancellation of the originating agent turn does not
  accidentally cancel independent work. In print mode, caller cancellation
  remains attached to the synchronous operation.
- Eligible tool implementations capture required plain context such as `cwd`
  before their first asynchronous boundary and do not retain session-bound `ctx`
  objects for later use.
- Session shutdown aborts active operations, clears visible status, and
  suppresses late results from the stale extension instance.
- Eligible tools return text and do not depend on synchronous `usage`,
  `addedToolNames`, `terminate`, image delivery, or a custom result renderer. An
  underlying tool may create an explicitly authorized artifact and return its
  path as text; the wrapper itself does not deliver image content. Structured
  result details are retained for inspection, and non-text content is marked as
  omitted rather than silently discarded.
- A live success-themed footer count exposes active operations without transcript
  polling. Each owner supplies the tool-facing status label used by that count.
  The same count is published through the shared extension event bus so
  session-level status integrations remain active until the background result.

## Implementation ownership

The canonical wrapper source is `extensions/background-tool.ts`. Eligible
extension directories expose relative `background-tool.ts` symlink aliases so
imports remain loadable when those directories are themselves reached through
Pi's global extension symlinks. Browser Fetch uses the wrapper as a read-only
tool. It attempts valid user-authorized HTTP and HTTPS destinations through a
fresh Chromium profile without imposing DNS or IP-range classification; it does
not own a replacement global network boundary. Codex Search is read-only by
default and exposes separately authorized workspace-write, image-generation,
and unsandboxed modes; each tool's schema and guidance own those permissions.

## Mode contract

In print mode, wrapped calls retain their normal bounded concurrency but remain
pending until their underlying operations complete or fail. Independent sibling
tool calls still run concurrently, and dependent work consumes their direct
results in the next model turn. This keeps one-shot Pi processes alive until the
requested work is terminal.

Outside print mode, after start confirmation the orchestrator must not wait,
sleep, or poll for the background result. When multiple operations are
independently useful and have non-overlapping effects, it starts their calls
without awaiting earlier results so Pi can run sibling tool calls concurrently.
It may then continue useful independent work; otherwise it ends its response so
the later results can enter the conversation as follow-up turns.
