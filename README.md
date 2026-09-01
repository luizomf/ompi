# ompi

A learning lab for building a small, explicit, and security-conscious
[Pi Coding Agent](https://github.com/earendil-works/pi-mono) workflow.

## Requirements

- Pi Coding Agent
- [just](https://github.com/casey/just)
- Git and GitHub CLI

## Recommended skills

The companion [omskills](https://github.com/luizomf/omskills) collection
provides the agent skills used by this repository's workflows and skill-enabled
launch profiles. Its README documents the available skills and installation
steps.

## Working in this repository

[`AGENTS.md`](AGENTS.md) is the orientation map for contributors and agents: it
makes the accepted outcome, repository state, lifecycle seam, and verification
evidence visible before a change. [`CONTEXT-MAP.md`](CONTEXT-MAP.md) routes work
to the canonical terminology and boundaries for each extension lifecycle. This
README remains the source for public setup and observable usage.

## Launch profiles

List the available recipes:

```sh
just
```

Start from the smallest profile and add only the capabilities needed for the
current task:

```sh
just bare         # Only the /exit alias extension
just core         # AGENTS.md and the /exit alias extension
just research     # Core plus research skill, Browser Fetch, and Codex Search
just orchestrate  # Core plus handoff, tmux-worker, and wormhole skills
just scheduler          # Core plus the OMQueue background runner and scheduler
just managed-processes  # Core plus session-scoped long-running processes
just subagents          # Core plus the asynchronous subagent extension
```

These profiles disable automatic discovery of agent-facing resources. Explicit
`--skill`, `--extension`, and `--append-system-prompt` paths still load, so
unrelated Claude, Codex, project, package, or global resources do not enter the
agent context.

### Browser fetch

The extension in `extensions/browser-fetch/` provides the read-only
`browser_fetch` tool used by `just research`. It launches a fresh headless
Chromium profile and browser context for each request. In print mode it waits
and returns the rendered result directly. In other modes it returns immediately
after a session-scoped background operation starts and may later deliver one
collapsible rendered-text result only while the owning Pi session remains live.
At most four Browser Fetch operations run concurrently. Output remains bounded,
best-effort Chromium cleanup is attempted on completion or cancellation, and
transport errors, HTTP failures, login, CAPTCHA, anti-bot, and unreadable-page
responses report what happened and the next exact-URL stage rather than
bypassing or hiding the failure. When multiple rendered-page or other background
research calls are independently useful, the orchestrator starts them in the
same turn so Pi can run
them concurrently; it does not await one result before starting another.

Browser Fetch attempts every valid user-authorized HTTP or HTTPS destination
through Chromium's ordinary networking. It does not classify or reject DNS
answers, IP ranges, loopback, private networks, or metadata addresses, and ompi
adds no replacement global network gate. The user remains responsible for
authorizing the destination; normal host, browser, and network controls still
apply.

For a specific user-authorized URL, the agent-facing guidance defines one
strict fallback chain: direct HTTP/curl on the original URL, `browser_fetch` on
the original URL, `codex_search` with `intent: exact_url` and an explicit
exact-URL extraction request, then `browser_fetch` through
`https://markdown.new/<absolute-URL>` and finally
`https://r.jina.ai/<absolute-URL>`. The Codex stage is fixed to Luna with high
reasoning. Transport errors, HTTP failures, blocked or login pages, unreadable
output, and failure to establish exact-URL access advance the chain. Transformed
fallback URLs never restart it. Helper/model-produced prose, snippets, and
related pages are not evidence that the supplied URL was read; if every safe
stage fails, the agent reports that it could not access or verify the page
rather than inventing page-specific facts.

`markdown.new` and `r.jina.ai` are third-party hosted services that receive the
submitted absolute URL. The guidance prohibits sending them credentials,
signed or private query parameters, or confidential identifiers without
explicit user authorization. Neither service is an ompi component or a trusted
local extension; each remains an external disclosure boundary.

The extension keeps its `playwright-core` dependency local. Install it after a
fresh checkout with:

```sh
npm ci --prefix extensions/browser-fetch
```

### Codex retrieval, research, and image generation

The extension in `extensions/codex-search/` provides one narrow `codex_search`
tool with three required task intents:

- `exact_url` retrieves and extracts one supplied URL through Luna with high
  reasoning;
- `research` performs independently complex source comparison or synthesis
  through Sol with high reasoning; and
- `image` requests image generation through Sol with high reasoning.

The caller supplies only a focused `query`, one `intent`, and an optional image
`destination`. It cannot select a model, reasoning level, workspace mode, or
approval behavior. The helper's `quick` and `research` profiles remain internal
invocation details rather than agent-facing effort choices. `just research`
enables this tool alongside Browser Fetch. To enable it in another isolated Pi
process:

```sh
pi --no-extensions --extension ./extensions/codex-search/index.ts
```

An authenticated `codex_search` helper and Codex CLI must be executable from
`PATH`, and the account must expose `gpt-5.6-luna` and `gpt-5.6-sol` with high
reasoning. Every invocation is direct and shell-free, uses the Pi session cwd,
sends its request through stdin, and includes the helper's accepted unsandboxed
mode. The extension fixes the routes explicitly instead of trusting helper or
machine defaults:

```text
exact_url: --profile quick --yolo --model gpt-5.6-luna --config model_reasoning_effort=high
research:  --profile research --yolo --model gpt-5.6-sol --config model_reasoning_effort=high
image:     --profile research --yolo --model gpt-5.6-sol --config model_reasoning_effort=high
```

All routes then add `--skip-git-repo-check --cd <pi-cwd> -`. The helper ignores
`~/.codex/config.toml` while retaining Codex authentication and ephemeral search
execution. Run `codex_search --list-models` (or `codex debug models`) outside Pi
to inspect the authenticated account's model catalog.

A direct `image` intent authorizes creation of that requested artifact; no
separate write-capability negotiation is required. When `destination` is
present, the extension includes the exact location in the stdin helper request.
Relative locations are interpreted from the Pi session cwd. Without a
destination, the returned text is only helper output: the calling agent must
inspect any reported artifact and place it where the task requires instead of
claiming final placement or delivery. The user's free-form image intent is not
rewritten into a mandatory visual template or post-processing pipeline. A
`destination` on `exact_url` or `research` is rejected before helper execution.
Those two intents authorize retrieval or research only, not unrelated workspace
mutation, even though the helper is mechanically unsandboxed.

In print mode the tool waits and returns its bounded result directly. In other
modes it returns immediately after a session-scoped background operation starts,
keeps a minimal live footer count, and may later deliver exactly one collapsible
completion or failure result while the owning Pi session remains live. After
start confirmation outside print mode, the orchestrator must not wait or poll;
it may continue independent work or end its response so the result can enter a
later turn. It must not inspect, move, or modify a pending image operation's
potential artifact paths before that live session delivers the result.

The background wrapper is limited to four concurrent Codex operations.
Independently useful Codex or other background calls can be started in the same
turn; the orchestrator does not await one result before starting another. Start
confirmations and delivered results preserve the owning-session lifetime.
Closing or reloading that Pi session aborts active work and suppresses stale
results; this path is intentionally not durable and does not use `bq` or
OMQueue.

Each process has a ten-minute timeout, captures at most 48,000 stdout bytes and a
2,000-byte stderr tail, and drains both streams. On cancellation, timeout, or
leader exit, it attempts best-effort process-group termination where supported
and falls back to signaling the direct child; cleanup is not guaranteed.
Startup, unavailable-helper, timeout, stdin, and nonzero-exit failures include
bounded diagnostics and actionable invocation context. A failure must be
mentioned in the next user-facing response without abandoning otherwise useful
work. An `exact_url` failure continues only
the remaining `markdown.new` and `r.jina.ai` stages of the strict fallback chain
and never restarts it.

Successful retrieval and research text is labeled as helper/model-produced
output, not a verified primary source, and includes a primary-source verification
reminder. Image output never receives that reminder and never claims more
placement or delivery than the helper reported. The extension is enabled
alongside Browser Fetch by `just research`; outside that explicit profile it is
not enabled by a package manifest or unrelated launch profile.

Browser Fetch and Codex Search share the single background wrapper maintained at
`extensions/background-tool.ts`. Their extension-local aliases preserve jiti
module resolution when each global extension directory is a symlink. To restore
the audited global installation from a fresh checkout, install Browser Fetch's
dependency as above, then create the links from the repository root:

```sh
ln -s "$(pwd)/extensions/browser-fetch" "${HOME}/.pi/agent/extensions/browser-fetch"
ln -s "$(pwd)/extensions/codex-search" "${HOME}/.pi/agent/extensions/codex-search"
```

Existing real directories or links must be moved or removed deliberately before
running these commands.

For comparison, start Pi with every user skill or its normal discovery
behavior:

```sh
just p
just pi
```

## Tmux status

The extension in `extensions/tmux-status/` publishes compact, best-effort Pi
metadata to the current tmux window. It sets `@pi_status` to an active glyph
while the agent is running or session-scoped work is still expected to return,
and to an idle glyph only after both have settled. Active subagent turns and
background tool operations such as browser fetches and Codex research
participate in that status. Durable scheduler submissions and managed processes
do not: their lifecycle is not a pending in-session automatic result. The name
is the native Pi session name when available, otherwise the current directory
name. The option is removed on shutdown.

When the published state changes from active to idle, the extension can invoke
`osalert` from `PATH` without a shell. The sound is disabled by default. Use
`/tmux-alert` to toggle it for the current Pi session, or start Pi with
`--tmux-alert` to enable it initially. This is best-effort: a missing or failing
command does not affect Pi.

The extension registers no tools, adds nothing to the agent context, invokes
commands directly without a shell, and is inert unless both `TMUX` and
`TMUX_PANE` are present. Tmux and alert failures do not affect the Pi lifecycle.
Install it globally from the repository root with:

```sh
ln -s "$(pwd)/extensions/tmux-status" "${HOME}/.pi/agent/extensions/tmux-status"
```

Consumers can render the window option directly with `#{@pi_status}`. Existing
real directories or links at the destination must be moved or removed
deliberately before creating the link.

## Theme

[`themes/omtheme.json`](themes/omtheme.json) contains the public Pi theme used
with the matching OMXTerm and dotfiles palette. To make this checkout the
canonical global copy while retaining Pi's normal theme discovery, link it from
the repository root:

```sh
mkdir -p "${HOME}/.pi/agent/themes"
ln -s "$(pwd)/themes/omtheme.json" "${HOME}/.pi/agent/themes/omtheme.json"
```

Move or remove an existing file at the destination deliberately before creating
the link. Select `omtheme` through `/settings`; Pi hot-reloads later edits to the
linked file.

## Managed processes

`just managed-processes` explicitly enables the extension in
`extensions/managed-process/`. It is a separate lifecycle from the finite
background-tool wrapper. Four tools start a long-running local process,
list retained process state, retrieve recent output, and stop a process:

| Tool | Purpose |
| --- | --- |
| `managed_process_start` | Start an executable with literal arguments and an optional cwd |
| `managed_process_list` | Take one snapshot of retained lifecycle state |
| `managed_process_output` | Retrieve bounded recent stdout and stderr tails |
| `managed_process_stop` | Terminate a known process and its owned Unix process group |

Start returns after the operating system accepts the spawn; it does not wait for
completion or prove that a server is ready. Commands run directly with no shell,
stdin is ignored, and no interactive TTY is allocated. The child inherits Pi's
current environment, including any credentials or SSH-agent authority, and is
not sandboxed. The extension does not load `.env` files or accept custom
environment values. Arguments are retained in the Pi session and may be visible
in the host process table, so do not put secrets in argv.

The manager cannot force an application to bind loopback. Inspect the
application and pass its verified host/listen option when network exposure
matters. On Unix, each child owns a detached process group. Stop, leader exit,
startup cancellation, and Pi session shutdown send SIGTERM, then SIGKILL after a
bounded grace period and verifies that the group is gone. Permission failures,
a surviving group, or a missing leader outcome are reported as cleanup failures.
Descendants that deliberately create another session or process group can escape
this mechanism. Starts are rejected on Windows because direct-child signaling
cannot satisfy the ownership contract.

State is session-local and in memory. At most eight processes are active, at
most sixty-four records are retained, and argument vectors are limited to 128
items, 8,000 UTF-8 bytes per item, and 64 KiB total. Each record keeps the
latest 64 KiB from each output stream. One output request returns at most 20 KiB
per stream and reports omitted earlier bytes. The extension does not inject automatic
completion turns or wakes; list and output calls are concrete snapshots, not
polling or wait operations. Use ordinary bash instead for finite work that should
complete synchronously in the current turn. Use `scheduler_submit` for fixed,
non-interactive finite work that should run through OMQueue and wake Pi after its
outcome. See [Managed Processes](docs/managed-processes/CONTEXT.md) for the
canonical lifecycle and security contract.

## OMQueue background runner and scheduler

`just scheduler` explicitly enables the extension in `extensions/scheduler/`.
Its `scheduler_submit` tool is Pi's unified OMQueue-backed background runner and
scheduler. When the extension is globally discovered but a process must not
open its callback endpoint—for example, when Pi itself runs inside OMQueue—pass
`--no-scheduler`. The flag removes `scheduler_submit` from that process's active
tools and skips callback endpoint startup:

```sh
pi --no-scheduler -p "Só teste. Responda OK"
```

A fixed, non-interactive payload runs immediately through the Queue when timing
is omitted, or after a delay, at an absolute time, as a finite
repeat, or on cron when timing is present. Omitting the payload creates a
heartbeat, reminder, or deferred-recheck wake.

Immediate Queue submission is not a blanket replacement for synchronous bash. A
trivial finite command such as `ls` is normally simpler to run directly. The
scheduler is useful when finite work should continue outside the current turn
and Pi should wake automatically after it terminates. Use managed processes
instead for genuinely long-running servers, watchers, tails, or development
processes that need explicit snapshots and stop operations and do not emit a
completion wake.

The extension invokes the existing global `bq` executable directly without a
shell and labels every Queue Job or Schedule as
`pi_scheduler_<submission-id>`. It does not set a concurrency key, so the label
has no effect on concurrency or execution order. The tool call returns as soon
as `bq` exits. A zero exit confirms acceptance, not payload completion. Any
other result leaves acceptance unknown
because finite submission may already have created durable work; do not blindly
retry an unknown result. Independently requested submissions can be issued in
the same turn so Pi handles their bounded acceptance requests concurrently; the
orchestrator never waits for one wake before submitting another. The tool call
never watches OMQueue, polls Job state, or exposes Queue administration. The
callback runner later waits for the heartbeat or payload outcome and attempts a
required best-effort wake into the live owning Pi session.

Every submission requires a complete, self-contained `reentryPrompt` delivered
back to Pi after the heartbeat fires or payload terminates. An optional payload
contains an executable, literal arguments, and a working directory; omitting it
creates a heartbeat-only wake. Timing fields are passed to `bq`, which remains
responsible for syntax and validation:

```json
{
  "reentryPrompt": "Inspect the command outcome and bounded previews, then report the next safe action without rerunning it.",
  "payload": {
    "executable": "./slow-check",
    "args": ["--format", "json"],
    "cwd": "./service"
  }
}
```

```json
{
  "reentryPrompt": "Recheck service health against the incident criteria and report the next safe action.",
  "timing": { "in": "15m" }
}
```

```json
{
  "reentryPrompt": "Review the check result and decide whether deployment may continue.",
  "timing": { "in": "1h", "every": "30m", "count": 4 },
  "payload": {
    "executable": "./check-service",
    "args": ["--format", "json"],
    "cwd": "./service"
  }
}
```

```json
{
  "reentryPrompt": "Run the weekday review, summarize failures, and identify the owner for each next action.",
  "timing": { "cron": "0 9 * * 1-5", "tz": "America/Sao_Paulo" },
  "payload": { "executable": "./weekday-review" }
}
```

The queued callback runner forwards payload stdout and stderr for OMQueue capture
while retaining only 4,000-byte previews for the wake. The required reentry
prompt is limited to 8,000 UTF-8 bytes. The tool response preserves bounded `bq`
stdout (16,000 bytes), stderr (8,000 bytes), and exit status. No shell command
strings or custom payload environment are accepted. `bq` receives an explicit
allowlist of normal process settings; payloads receive only `HOME`, locale,
user/shell, `PATH`, `PROJECTS_DIR`, temporary-directory, and time-zone settings.
The callback runner prepends the captured Pi Node runtime directory to payload
`PATH`, so child commands that invoke `node` use the same runtime as the runner.
Credentials and arbitrary submitting-shell variables are not forwarded.

Callbacks use a mode-`0600` Unix socket inside a private temporary directory and
a versioned, bounded frame correlated with session capability material carried
explicitly in the queued argument vector. The endpoint exists only for the live
owning Pi session and is removed on session shutdown. A wake is therefore best
effort: Pi shutdown, host loss, a missing callback runner, forced runner
termination, or failure before the runner starts can prevent delivery. Durable
OMQueue payloads and recurring schedules may continue after Pi closes, but their
callbacks cannot reopen the session. Manage or cancel such schedules outside
this extension through explicitly requested ordinary shell or OMQueue
administration.

The wrapper captures the active Pi process's absolute Node runtime because Queue
Jobs do not inherit the submitting shell or NVM environment. That runtime is the
literal executable submitted to `bq`, with the callback runner's absolute path as
its first argument. Both paths are stored in each accepted Job or Schedule and
must remain executable at those locations for long-lived schedules. Scheduler
submissions inherit the user's command authority and are not sandboxed. This
extension is not enabled by any unrelated launch profile or by package discovery
in this repository. When loaded through global discovery, `--no-scheduler`
disables its tool and callback endpoint for the current Pi process without
disabling other extensions. Equivalent `bq` syntax supplied as an example does
not by itself select ordinary bash; route by whether the requested work should run
through the Queue and wake Pi. For `bq`-related requests, use ordinary bash only
when the user explicitly asks to invoke, test, debug, or inspect the raw `bq` CLI
or administer OMQueue.

## Subagents

`just subagents` explicitly enables the extension in
`extensions/subagents/`. It starts clean, persistent Pi conversations and
derives effective delivery mechanically from the current Pi mode and managed
lineage depth for both start and continuation. A root depth-1 TUI always returns
after child RPC prompt acceptance and later queues exactly one completion,
failure, or interruption pong, even when caller input requests `"direct"`.
Print and managed nested lineage (`depth > 1`) always wait for terminal
completion and return one bounded direct result without a pong, even when
caller input requests `"async"` or omits delivery. This keeps the root TUI
responsive and retains a nested parent runtime through descendant settlement.
A root depth-1 RPC remains async by default and honors explicit `"direct"`.
Child transport follows Pi's strict JSONL framing without a smaller
ompi-specific record cap; parent-visible terminal text remains bounded
separately.

The normal widget remains compact and shows only direct current activity. The
compact footer summarizes the active ownership subtree as `direct: N • nested:
N • total: N`; it does not add recursive widget lines. Neither surface streams
child transcripts into the parent conversation or renders a recursive
dashboard. When a user asks to inspect nesting, `subagent_status` or `/subtree`
returns the active ownership subtree relative to the invoking parent: `self`,
depth, state, parent runtime, and owner-local numeric ID. A nested parent
therefore sees itself and descendants, not its parent, siblings, idle
conversations, unrelated controllers, or other sessions.
Descendant paths explain ownership but are not new action identifiers; existing
steer and interrupt operations still accept only the direct owner's local ID.

After asynchronous acceptance, the parent must not sleep, run a wait loop, or
repeatedly call `subagent_list` for completion. When multiple independent
delegations are useful, it starts them in the same turn so Pi can run them
concurrently rather than awaiting an earlier pong. It may then continue useful
work independent of the subagent results; otherwise it must end its response so
user input and later pongs can enter the conversation.

For daily use, link this audited extension into Pi's global extension directory:

```sh
ln -s "$(pwd)/extensions/subagents" "${HOME}/.pi/agent/extensions/subagents"
```

A normal `pi` process then discovers it automatically, and `/reload` picks up
source changes. Explicit profiles using `--no-extensions` remain isolated unless
they also pass `--extension ./extensions/subagents/index.ts`.

The extension exposes these tools and matching commands:

| Tool | Command | Purpose |
| --- | --- | --- |
| `subagent_start` | `/sub` | Start a clean conversation |
| `subagent_continue` | `/subcont` | Continue a settled conversation |
| `subagent_steer` | `/substeer` | Steer an active turn |
| `subagent_interrupt` | `/substop` | Interrupt an active turn |
| `subagent_status` | `/subtree` | Show the active ownership subtree on demand |
| `subagent_list` | `/sublist` | List direct session-scoped known conversations |

Use plain command arguments for common operations, or JSON with `/sub` and
`/subcont` for delivery, lineage ceilings, routing, working-directory, tool, and
name options. `delivery` remains exposed on both tool schemas and JSON command
surfaces, but a root-TUI command cannot block on conflicting `"direct"` input;
print and managed nested calls cannot become async through conflicting input.
Each omitted routing value inherits the parent's active value when that turn is
dispatched. An explicit `model` override must use the qualified
`provider/model` form; bare or malformed values are rejected before child
launch. Optional `model` and `reasoning` overrides apply to one dispatch only
and must be supplied only when the user explicitly requests that routing. The
live subagent widget and `/sublist` output show the effective routing values.
At each start or continuation, omitted `tools` inherit the parent's full
then-active set, including extension tools; an explicit array can only narrow
that snapshot, and `tools: []` selects no tools. A subagent name is descriptive
and does not silently change capabilities or delivery. `maxDepth` and
`maxChildren` may tighten the child's inherited managed-lineage ceilings; a
continuation keeps the same depth and may tighten its prior ceilings again, but
neither value can be raised. For example:

```text
/sub Inspect the authentication flow and report risks.
/sub {"prompt":"Run the focused tests","name":"tests","tools":["read","bash"]}
/sub {"prompt":"Inspect memory handling","model":"openai-codex/gpt-5.6-luna","reasoning":"high"}
/sub {"prompt":"Record a delivery preference; root TUI remains async","delivery":"direct","maxDepth":2,"maxChildren":0}
/subcont {"id":1,"prompt":"Continue; root TUI still remains async","delivery":"direct"}
/subcont 1 Check the newly changed files.
/substeer 1 Focus only on the parser.
/substop 1
/subtree
/sublist
```

Subagents inherit the current environment and working directory, including
credentials and SSH agent access. They are not sandboxed. Broad child extension
discovery is disabled; Pi loads only the extension providers required for the
inherited tools and verifies the exact tool/provider set before accepting the
prompt. Normal skill and repository-instruction discovery still applies from
the child working directory.

A fresh child stores only its explicit prompt in a new native Pi JSONL
conversation; it never imports the parent transcript, summaries, or hidden
continuation state. Continuation resumes only that child's conversation at the
same one-based delegation depth while capturing the parent's current
capabilities again. The root is depth 1, its coordinator is depth 2, a leaf is
depth 3, and the default maximum is 3. The root owns at most 12 active direct
children; each nested parent defaults to 2. Handshaking, running, finalizing,
and direct-wait runtimes occupy the responsible parent's local slot until their
process exits.

A coordinator RPC process remains alive through dependent direct leaf calls and
exits only after its enclosing Pi turn settles. Parent interruption, process
closure, and session shutdown recursively close active descendants created
through this extension and await their process exit. Independently shell-launched
Pi or other processes are outside that managed lineage. Caller-requested
interruption returns the distinct `interrupted` terminal outcome rather than a
spontaneous `failed` outcome. Every bounded terminal result retains the native
session reference for complete inspection, including truncated, failed,
interrupted, and missing-assistant-message cases. The registry is intentionally
in memory; native Pi JSONL sessions remain after processes and the orchestrator
exit.

Standard `select`, `confirm`, `input`, and `editor` dialogs requested by a
headless child relay mechanically through direct owners to a root TUI. Parent
models never receive or answer the dialog content. Relay requests remain
correlated and settle within thirty seconds; process cleanup cancels pending
dialogs. If the root is print, JSON, RPC without a TUI, absent, or unresponsive,
the child receives the standard cancellation value instead of hanging. Pi's
TUI-only `ctx.ui.custom()` remains unavailable in RPC children and the extension
does not emulate it. Fire-and-forget child UI components are not turned into a
root dashboard.

Install dependencies and verify the extension with:

```sh
npm install
npm run typecheck
npm test
```

## Exploration notes

- [Pi orchestration exploration](docs/orchestration-exploration.md) records
  findings about wormholes, tmux workers, subagents, cross-machine messaging,
  reliability boundaries, and historically reviewed extensions.

## Safety defaults

- No automatic `.env` loading.
- No default bundle of third-party extensions.
- Short, intent-based launch recipes.
- Third-party code is reference material until explicitly reviewed and adopted.
