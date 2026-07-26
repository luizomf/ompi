# `my-pi-setup` Orchestration UI Assessment

## Executive conclusion

The reference has two different full-screen TUI overlays, not one generic “background window.” `/subagents` opens a dashboard and then an **interactive takeover** view backed by normalized live agent events; it is not read-only because it contains an input, sends/steers or restarts the selected agent, and can abort the run. (`my-pi-setup/extensions/subagents/src/ui/takeover.ts:56-99`, `my-pi-setup/extensions/subagents/src/ui/takeover.ts:364-415`, `my-pi-setup/extensions/subagents/src/ui/takeover.ts:452-480`)

`/ps` opens a terminal dashboard and then a **read-only output inspector**. “Read-only” means that the process has no stdin and the detail view has no text input; users can still toggle stdout/stderr, scroll, and kill the process. (`my-pi-setup/extensions/background-terminals/src/ui/ps.ts:1-7`, `my-pi-setup/extensions/background-terminals/src/ui/ps.ts:362-488`, `my-pi-setup/extensions/background-terminals/src/manager.ts:554-565`)

Pilearn should not replace its nearly complete native RPC subagent mechanism. The smallest potentially useful adoption is a TUI-only `/subagents` inspection surface over the existing controller, initially without takeover input; the reference’s background-terminal subsystem should remain a separate opt-in feature and should be built only after a concrete repeated need appears. The current implementation already has asynchronous prompt acceptance, persistent native sessions, steering, interruption, exactly-one pong delivery, and compact live status. (`extensions/subagents/index.ts:99-162`, `extensions/subagents/index.ts:193-264`, `extensions/subagents/controller.ts:246-348`)

**No implementation should be chosen to fix the owner’s unnamed small defect until that defect is described and reproduced.**

## Exact reference user flows

### `/subagents`

1. The command is TUI-only; with no tracked subagents it notifies the user, otherwise it opens the picker. (`my-pi-setup/extensions/subagents/index.ts:724-743`)
2. A full-screen overlay lists every tracked run with status, title/id, backend/model, context utilization, elapsed time, and terminal status. Up/down or `j`/`k` moves, Enter selects, `x` aborts a running selection, and the configured cancel key closes. (`my-pi-setup/extensions/subagents/src/ui/takeover.ts:123-207`, `my-pi-setup/extensions/subagents/src/ui/takeover.ts:221-343`)
3. Enter opens another full-screen overlay for that subagent. It renders finalized transcript items plus live assistant text, thinking, tool activity, and queued messages, with throttled live repaint and bottom-relative scrolling. (`my-pi-setup/extensions/subagents/src/ui/transcript.ts:67-166`, `my-pi-setup/extensions/subagents/src/ui/takeover.ts:417-449`, `my-pi-setup/extensions/subagents/src/ui/takeover.ts:507-561`)
4. Submitting text calls `requestSend`: it steers an active run or starts another turn in a settled session; the clear binding aborts the active run, interrupt/cancel returns to the dashboard, and cursor/page keys scroll. (`my-pi-setup/extensions/subagents/src/ui/takeover.ts:409-415`, `my-pi-setup/extensions/subagents/src/ui/takeover.ts:450-493`, `my-pi-setup/extensions/subagents/src/manager.ts:625-654`, `my-pi-setup/extensions/subagents/src/manager.ts:701-712`)
5. Leaving takeover reopens the dashboard; leaving the dashboard closes `/subagents`. (`my-pi-setup/extensions/subagents/src/ui/takeover.ts:73-100`)

The overlay is implemented with the documented `ctx.ui.custom(..., { overlay: true })` API; Pi documents custom TUI as terminal-only and requires `ctx.mode === "tui"` guards. (`<pi-package>/docs/tui.md:89-130`, `<pi-package>/docs/extensions.md:940-946`)

### `/ps`

1. While at least one process runs, a widget above the editor shows the count and `/ps to view`; it is cleared when the count reaches zero. (`my-pi-setup/extensions/background-terminals/index.ts:81-117`; installed widget API: `<pi-package>/docs/tui.md:794-818`)
2. `/ps` gives an informational listing outside TUI mode, reports the empty state when needed, or opens the TUI picker. (`my-pi-setup/extensions/background-terminals/index.ts:421-444`)
3. The dashboard lists tracked terminals with status, title/id, PID, elapsed time, and exit state. Up/down or `j`/`k` moves, Enter inspects, `x` kills a running selection, and cancel closes. (`my-pi-setup/extensions/background-terminals/src/ui/ps.ts:123-207`, `my-pi-setup/extensions/background-terminals/src/ui/ps.ts:221-359`)
4. The detail view defaults to stdout; `t` toggles stdout/stderr, arrows or `j`/`k` and page keys scroll, `g`/`G` jump to top/bottom, `x` kills, and cancel returns to the dashboard. It live-tails when the bottom-relative offset is zero. (`my-pi-setup/extensions/background-terminals/src/ui/ps.ts:366-488`, `my-pi-setup/extensions/background-terminals/src/ui/ps.ts:540-615`)
5. Captured output is ANSI/control-sanitized only for rendering, retained in memory as a bounded newest tail, and optionally spilled to owner-only files; the implementation caps each in-memory stream at 2 MiB and each spill at 256 MiB. (`my-pi-setup/extensions/background-terminals/src/ui/output-view.ts:1-56`, `my-pi-setup/extensions/background-terminals/src/manager.ts:38-55`, `my-pi-setup/extensions/background-terminals/src/manager.ts:457-520`)

## Architectural comparison

| Feature | Reference | Current Pilearn | Recommendation |
|---|---|---|---|
| Child transport | Normalized manager over an in-process Pi SDK session, Claude Agent SDK, or Codex app-server; global cap 4. (`my-pi-setup/extensions/subagents/src/backend.ts:24-69`, `my-pi-setup/extensions/subagents/src/runtime.ts:14-28`, `my-pi-setup/extensions/subagents/src/manager.ts:45-46`) | One native Pi RPC subprocess per active turn; strict JSONL request/response and event handling; cap 12. (`extensions/subagents/rpc-child.ts:68-145`, `extensions/subagents/controller.ts:84-85`, `extensions/subagents/controller.ts:368-375`) | Keep RPC: it is simpler and matches Pilearn’s explicit native-Pi scope. |
| Conversation lifetime | A live backend session can accept further sends and remains manager-owned until pruning/shutdown. (`my-pi-setup/extensions/subagents/src/manager.ts:625-654`, `my-pi-setup/extensions/subagents/src/manager.ts:658-683`) | Process exists only for an active turn; the native session file persists and continuation starts a new RPC process with `--session`. (`docs/subagents/CONTEXT.md:11-18`, `extensions/subagents/controller.ts:149-190`, `extensions/subagents/rpc-child.ts:35-46`) | Keep current lifecycle; dormant subprocesses are unnecessary. |
| Completion | Unconsumed results are deferred, then injected as follow-ups with `triggerTurn`; wait/cancel can consume them. (`my-pi-setup/extensions/subagents/index.ts:180-244`, `my-pi-setup/extensions/subagents/src/result-delivery.ts:1-20`) | `agent_settled` triggers final-text retrieval, process close, and one pong sent as a follow-up with `triggerTurn`. (`extensions/subagents/controller.ts:285-348`, `extensions/subagents/index.ts:150-162`) | Keep current deterministic pong contract; do not add blocking wait. |
| Live UI | Footer status plus `/subagents` dashboard and interactive takeover. (`my-pi-setup/extensions/subagents/index.ts:162-178`, `my-pi-setup/extensions/subagents/src/ui/takeover.ts:56-100`) | Compact active-only widget and footer count; `/sublist` is notification text. (`extensions/subagents/index.ts:99-145`, `extensions/subagents/index.ts:330-350`) | Consider a read-only picker/detail overlay only if compact status is insufficient. |
| Transcript data | Manager folds assistant deltas, finalized messages, tools, queues, usage, and metadata into bounded snapshots. (`my-pi-setup/extensions/subagents/src/manager.ts:286-380`) | Controller retains current tool, a 240-character visible-text tail, metadata, and final pong text bounded to 8,000 characters. (`extensions/subagents/controller.ts:286-310`, `extensions/subagents/index.ts:87-125`) | If inspection is requested, first add a bounded event transcript; do not read arbitrary session files in the renderer. |
| Background commands | Separate no-stdin process manager with four model tools, widget, `/ps`, tree kill, and output spills. (`my-pi-setup/extensions/background-terminals/index.ts:1-28`, `my-pi-setup/extensions/background-terminals/index.ts:207-353`) | No background-terminal extension exists in the current repository; current orchestration docs distinguish visible tmux workers from headless subagents. (`docs/orchestration-exploration.md:20-37`, `extensions/subagents/index.ts:1-350`) | Keep separate from subagents; add only for demonstrated long-running server/watcher use. |

The current RPC design follows Pi’s protocol semantics: successful `prompt` response means acceptance rather than completion, `agent_settled` is the no-more-automatic-work boundary, and `get_last_assistant_text` returns the final assistant text. (`<pi-package>/docs/rpc.md:42-76`, `<pi-package>/docs/rpc.md:752-770`, `<pi-package>/docs/rpc.md:836-887`)

## Security and maintenance risks

- Pi extensions execute with the user’s full system permissions, so either imported subsystem becomes trusted local code. (`<pi-package>/docs/extensions.md:107-113`)
- Both current and reference subprocess paths inherit `process.env`; Pilearn’s durable notes correctly warn that this may expose API keys, SSH-agent access, and other credentials to children. (`extensions/subagents/rpc-child.ts:49-63`, `my-pi-setup/extensions/subagents/src/backends/codex.ts:319-329`, `docs/orchestration-exploration.md:249-255`)
- The reference deliberately gives Claude bypassed permissions and Codex `danger-full-access` with no approval prompts; adopting those backends would materially enlarge Pilearn’s attack surface beyond its native Pi-only RPC worker. (`my-pi-setup/extensions/subagents/src/backends/claude.ts:326-344`, `my-pi-setup/extensions/subagents/src/backends/codex.ts:882-899`)
- Reference Pi children do apply project-trust handling and exclude orchestration/user-question tools, while current children disable extensions, load user skills explicitly, and allow only native tools when an allowlist is supplied. (`my-pi-setup/extensions/subagents/index.ts:119-138`, `my-pi-setup/extensions/subagents/src/backends/pi.ts:37-46`, `my-pi-setup/extensions/subagents/src/backends/pi.ts:280-305`, `extensions/subagents/rpc-child.ts:21-46`)
- Full-screen live overlays add subscriptions, timers, repaint throttling, width/sanitization rules, and disposal obligations. Pi explicitly requires bounded line widths, rerenders after state changes, and fresh component instances after overlay disposal. (`<pi-package>/docs/tui.md:3-20`, `<pi-package>/docs/tui.md:179-196`, `<pi-package>/docs/tui.md:922-930`)
- Background-terminal spills can contain secrets, consume substantial temporary disk, and become stale pointers after shutdown; the reference bounds spills, clears invalid pointers on failure/cap, and recursively removes its session spill directory during disposal. (`my-pi-setup/extensions/background-terminals/src/manager.ts:43-55`, `my-pi-setup/extensions/background-terminals/src/manager.ts:478-520`, `my-pi-setup/extensions/background-terminals/src/manager.ts:830-854`)
- Long-lived child resources must be started lazily and closed in an idempotent `session_shutdown` handler; both reference subsystems implement that lifecycle. (`<pi-package>/docs/extensions.md:220-225`, `my-pi-setup/extensions/subagents/index.ts:250-264`, `my-pi-setup/extensions/background-terminals/index.ts:181-203`)

## Smallest useful adaptations

### Subagent inspection UI

1. **Do not port the backend manager.** Keep `SubagentController` and `RpcSubprocess`; they already implement Pilearn’s clean-start, persistent-conversation, turn-release, and deterministic-pong contracts. (`docs/subagents/CONTEXT.md:11-18`, `docs/subagents/CONTEXT.md:31-45`, `extensions/subagents/controller.ts:125-190`)
2. If the owner wants richer inspection, add a TUI-only `/subagents` picker over `controller.list()`, preserving the current widget. A first version should be read-only and show metadata, current tool, bounded visible preview, error, and session reference; this uses information already exposed by `SubagentView`. (`extensions/subagents/controller.ts:38-53`, `extensions/subagents/index.ts:69-83`)
3. Only if that view is insufficient, extend the controller with a bounded normalized event transcript and port the reference’s sanitize/wrap/scroll logic. Do not add takeover input merely to match the reference: Pilearn already exposes explicit `subagent_steer`, `subagent_continue`, and `subagent_interrupt` operations. (`extensions/subagents/index.ts:214-254`, `my-pi-setup/extensions/subagents/src/ui/transcript.ts:13-44`)

### Background-terminal support

Treat this as an independent capability, not a subagent fix. The minimum honest version still needs no-stdin spawning, separate bounded stdout/stderr, process-tree termination, async completion delivery, shutdown cleanup, and a read-only viewer; omitting those safeguards would misrepresent process control or leak resources. (`my-pi-setup/extensions/background-terminals/src/manager.ts:243-267`, `my-pi-setup/extensions/background-terminals/src/manager.ts:554-613`, `my-pi-setup/extensions/background-terminals/index.ts:119-179`)

Do not adopt it preemptively. If repeated dev-server/watcher work demonstrates a need, implement it as an opt-in `extensions/background-terminals/` package and begin with `bg_start`, `bg_status`, `bg_kill`, the running-count widget, and `/ps`; defer multi-backend reuse, Effect-specific architecture, and elaborate spill retention unless concrete output volumes require them. The official extension guidance requires truncating model-visible tool output, with 50 KB/2,000 lines as the built-in ceiling and a pointer to full output when truncated. (`<pi-package>/docs/extensions.md:2109-2160`)

## Decision boundary

This assessment identifies optional UI improvements, not a defect remedy. **The owner must describe the small defect before any implementation is selected, because neither an inspection overlay nor a background-process manager can be justified as its fix without the defect’s observable behavior and expected outcome.**
