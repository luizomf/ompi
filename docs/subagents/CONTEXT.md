# Pi Subagents

Language for the small internal Pi extension that lets one conversation start and observe independent agent conversations.

## Language

**Orchestrator agent**:
The root Pi agent conversation in one extension-managed delegation lineage. It delegates work, receives asynchronous pongs or direct terminal results, and decides what happens next.
_Avoid_: Product, service, platform, mechanical controller

**Parent agent**:
The agent conversation that directly starts a subagent. A parent may itself be a subagent; the orchestrator is the root parent at delegation depth 1.
_Avoid_: Manager process, supervisor service

**Subagent**:
An independent headless Pi agent conversation started by its parent and owned by that parent's current session. Its native Pi JSONL conversation persists across turns, while one RPC process exists only during an accepted active turn.
_Avoid_: Worker service, task, job, daemon

**Headless child runtime**:
The live RPC process that hosts one subagent turn with its normal Pi agent loop, inherited tools and extension providers, and managed descendants but no TUI. It remains alive through every model and tool step in that turn, including direct nested delegations, then exits after terminal settlement or parent-requested closure. A later continuation starts another process over the preserved native session at the same delegation depth.
_Avoid_: Detached daemon, TUI pane, persistent idle service

**Direct runtime owner**:
The parent agent that opened one active headless child runtime. Each parent owns only its direct extension-managed children; ancestor closure cascades through that ownership chain, while normal process exit ends ownership automatically.
_Avoid_: Semantic task owner, remote lifecycle controller, shell-process owner

**Inherited runtime baseline**:
The parent's active operating environment projected into a subagent by default: active Pi and extension tools, the extension providers required to reproduce those tools, normal skill discovery, applicable repository instructions, working directory, routing defaults, and environment. Inheritance is launch mechanics rather than a model-visible negotiation tool. Explicit caller restrictions are opt-in; omission means inherit the baseline.
_Avoid_: Conversation fork, ambient extension discovery, role profile, inheritance prompt

**Capability snapshot**:
The exact set of tools active in the parent when a start or continuation dispatch is accepted. A subagent inherits this snapshot by default, including extension tools, without gaining inactive or undiscovered tools. The caller may explicitly narrow the snapshot; assigning a writer, reviewer, coordinator, or other name does not silently change it. Required provider loading and validation happen mechanically before prompt acceptance.
_Avoid_: Installed tool catalog, role profile, automatic capability discovery

**Delegation depth**:
The one-based position of an agent in one managed delegation lineage: root orchestrator 1, coordinator 2, and leaf 3 by default. The default maximum is 3. Continuation preserves a subagent's depth. An agent at its maximum keeps the subagent tools available, but a further start is rejected before process launch. A caller may tighten the inherited maximum for a child or later continuation but cannot raise it.
_Avoid_: Process count, task phase, permission role

**Direct active-child ceiling**:
The maximum number of direct child processes one parent may own concurrently. The root default is 12 and a nested parent defaults to 2. A nested ceiling may be tightened to 0, 1, or 2 but never raised above what the parent inherited. Handshaking, running, finalizing, and direct-wait runtimes hold a local slot until their owned process has exited. Each controller enforces only its direct children; this is not a global or tree-wide semaphore.
_Avoid_: Global process limit, queue capacity, lifetime spawn count, known conversation count

**Managed delegation lineage**:
The parent-child process tree created through this subagent extension. Parent interruption, direct runtime closure, and session shutdown recursively close active descendants and await owned process exit. Pi or other processes launched independently through shell tools remain outside this lineage and are not intercepted or claimed by the extension.
_Avoid_: Operating-system process tree, process sandbox, security boundary

**Runtime closure**:
The direct parent's termination of an active headless child runtime. Closure interrupts its current turn, cascades through managed descendants, confirms owned process exit before releasing local capacity, and preserves native session files for inspection or continuation.
_Avoid_: Session deletion, semantic completion, idle release

**Clean start**:
A new subagent conversation that receives the inherited runtime baseline and its explicit prompt but none of the parent transcript, compaction summary, hidden continuation state, or prior messages. A continuation preserves only that subagent's native Pi conversation; runtime inheritance never implies conversation sharing.
_Avoid_: Context fork, implicit transcript inheritance, automatic conversation sharing

**Subagent extension**:
The mechanical Pi extension that connects each parent agent to direct subagents and owns their managed process lifecycle, message transport, local limits, and status for the current session. Its child transport follows Pi's strict JSONL record semantics and does not terminate valid records at a smaller extension-specific byte cap; bounded terminal results and status metadata remain separate parent-visible limits. It does not decide or interpret delegated work.
_Avoid_: Agent, daemon, orchestration platform, scheduler, workflow engine

**Steering**:
A new instruction queued for a running subagent and delivered at Pi's next safe boundary, before its next model call.
_Avoid_: Real-time chat, process interruption, follow-up

**Interruption**:
Aborting a subagent's current turn without deleting its conversation, so that conversation remains available for later instructions. A matching caller-requested interruption produces the mechanically distinct `interrupted` terminal outcome; a spontaneous process or provider failure remains `failed`, even when no current-turn assistant message exists.
_Avoid_: Removal, reset, steering, generic failure

**Delivery mode**:
The caller-selected return contract for one dispatch. `async` is the default outside print mode: acceptance returns immediately and terminal settlement produces one later pong. Explicit `direct` keeps the tool call pending and returns one bounded terminal result without a later pong. Print mode is always direct. Role, name, and delegation depth never select direct delivery implicitly.
_Avoid_: Coordinator profile, leaf profile, hidden topology mode

**Terminal result**:
The mechanically classified `completed`, `failed`, or `interrupted` outcome of one bounded subagent turn. It includes the current turn's bounded final assistant text when one exists and always retains the native session reference needed to inspect complete persisted evidence after truncation, failure, interruption, or a missing assistant message.
_Avoid_: Workflow decision, semantic success, transcript copy

**Start confirmation**:
The immediate response that a subagent process accepted an asynchronous prompt and began an active turn. It does not wait for that turn to finish.
_Avoid_: Pong, completion

**Pong**:
The subagent extension's single deterministic asynchronous notification that an accepted subagent turn completed, failed, or was interrupted. It carries the bounded terminal result and its native session reference; delivery never depends on the subagent producing an assistant message. Direct delivery never emits a pong.
_Avoid_: Direct result, model callback, polling, status check

**Ownership subtree**:
One parent agent plus every active descendant runtime reachable through that parent's direct children. An on-demand snapshot identifies the invoking parent as `self`; descendant runtime paths are relative to it, while each `#ID` remains scoped to the direct owner named on that line. A parent can inspect only its own subtree, never its parent, siblings, unrelated controllers, idle conversations, or other sessions. Existing direct-owner steering and interruption operations continue to accept their local numeric IDs; the status view adds no tree action API, and closing an ancestor retains recursive managed-lineage cleanup.
_Avoid_: Global agent registry, session inventory, machine process tree, globally actionable runtime ID

**Live status**:
A compact Pi widget near the editor that shows only direct current subagent activity without adding streaming updates to the parent conversation. The default stays non-recursive, and a minimal footer count remains visible while a direct subagent turn is active. The same direct active count is published through the shared extension event bus so session-level status integrations do not mistake a settled parent turn for an idle session. `subagent_status` and `/subtree` provide a user-requested, active-only ownership subtree; status propagation contains bounded runtime metadata, never prompts, transcript text, final text, unrelated sessions, or a permanent dashboard.
_Avoid_: Transcript message, progress polling, full output, recursive default widget

**Headless UI relay**:
The mechanical owner-chain transport for standard RPC dialogs: `select`, `confirm`, `input`, and `editor`. Each direct owner forwards the request through RPC UI rather than exposing it to its model, and only a root TUI may ask the user. The correlated user response returns along the same chain. Every relay is capped at thirty seconds and process cleanup cancels pending requests; absent, unresponsive, non-TUI, print, JSON, or root RPC surfaces return the protocol's method-appropriate cancellation instead of hanging. Pi's TUI-only `custom()` remains unavailable in headless RPC children and is not represented or emulated by this extension.
_Avoid_: Child TUI, model-authored user response, automatic approval, custom-component emulation

## Routing selection

Every clean start and continuation independently inherits each omitted routing
value from the parent's active model and current Pi thinking level when that
turn is dispatched. Agent-facing tools and command JSON may provide an
explicit model override only as a qualified `provider/model` selector, such as
`openai-codex/gpt-5.6-luna`. Bare or malformed model overrides are rejected
before child launch. A supported `reasoning` level may also be provided for that
dispatch only. The parent agent must omit these overrides unless the user
explicitly requests that routing. An override never becomes a default for later
continuations.

## Mode contract

In print mode, start and continuation tool calls remain pending until their subagent turns reach a terminal outcome, then return the bounded terminal result directly without a pong. Outside print mode, asynchronous delivery remains the default and `delivery: "direct"` must be selected explicitly for dependent work. Independently issued direct sibling calls still run concurrently. Caller cancellation interrupts the matching active direct runtime and returns `interrupted` with its native session reference.

After an asynchronous start confirmation, the parent must never keep its current turn alive merely to await the pong. It must not use sleeps, shell wait loops, or repeated status snapshots. When multiple independent delegations are useful, it starts their subagent calls without awaiting earlier pongs so Pi can run sibling tool calls concurrently. It may then continue useful work that does not depend on the subagents' results; otherwise it ends its response immediately. Ending the response returns control to the caller and lets queued pongs enter the parent conversation in later turns.

A depth-2 parent remains alive while dependent direct depth-3 tool calls run and exits only after its enclosing Pi turn settles. Its native session persists for later inspection or continuation; the extension adds no persistent idle runtime or workflow store. Runtime closure and session shutdown recursively clean only the active managed lineage.

## Root session boundary

The subagent extension does not replace, rotate, or automatically continue the root native Pi session. Pi's user-initiated session operations keep their existing contracts, and one print-mode invocation retains one root conversation until it terminates.
