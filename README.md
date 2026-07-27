# ompi

A learning lab for building a small, explicit, and security-conscious
[Pi Coding Agent](https://github.com/earendil-works/pi-mono) workflow.

## Requirements

- Pi Coding Agent
- [just](https://github.com/casey/just)
- Git and GitHub CLI

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
just research     # Core plus research skill and browser extension
just orchestrate  # Core plus handoff, tmux-worker, and wormhole skills
just scheduler    # Core plus the fire-and-forget scheduler wake extension
just subagents    # Core plus the asynchronous subagent extension
```

These profiles disable automatic discovery of agent-facing resources. Explicit
`--skill`, `--extension`, and `--append-system-prompt` paths still load, so
unrelated Claude, Codex, project, package, or global resources do not enter the
agent context.

### Browser fetch

The extension in `extensions/browser-fetch/` provides the read-only
`browser_fetch` tool used by `just research`. It launches a fresh headless
Chromium profile for each request, returns immediately after a session-scoped
background operation starts, and later delivers one collapsible rendered-text
result. At most four Browser Fetch operations run concurrently. Output remains
bounded, Chromium is closed on completion or cancellation, and login, CAPTCHA,
anti-bot, and unreadable-page responses are reported rather than bypassed.
An ephemeral loopback proxy resolves every navigation, redirect, HTTP
subresource, and WebSocket destination, rejects any non-public result, and
connects to the exact validated IP so Chromium cannot re-resolve it. The proxy
preserves the original hostname and TLS verification. Service workers are
disabled so they cannot bypass this network boundary.

The extension keeps its `playwright-core` dependency local. Install it after a
fresh checkout with:

```sh
npm ci --prefix extensions/browser-fetch
```

### Codex search fallback

The extension in `extensions/codex-search/` provides a narrow
`codex_search` tool for difficult web research when normal browser fetching is
blocked or insufficient, or when an independent second research path is useful.
Enable it explicitly for one Pi process:

```sh
pi --no-extensions --extension ./extensions/codex-search/index.ts
```

It invokes `codex_search --skip-git-repo-check -` directly without a shell and
sends the research query through stdin. The tool returns immediately after a
session-scoped background operation starts, keeps a minimal live footer count,
and later delivers exactly one collapsible completion or failure result. After
start confirmation, the orchestrator must not wait or poll; it may continue
independent work or end its response so the result can enter a later turn.

The background wrapper is limited to four concurrent Codex searches. Closing or
reloading the owning Pi session aborts active searches and suppresses stale
results; this path is intentionally not durable and does not use `bq` or
OMQueue. The narrow trust-check bypass allows research from new or untrusted
working directories without using `--yolo` or changing sandbox or approval
behavior. Each process retains its fixed ten-minute timeout and bounded captured
output. Model and reasoning defaults remain controlled by the `codex_search`
executable resolved from `PATH`; the extension passes no model, reasoning,
`--yolo`, ephemeral-container, or arbitrary Codex flags. Its model-produced
result is not a verified primary source, so requests should ask for URLs or
citations where relevant and verify those sources separately. The extension is
not enabled by any launch profile or package manifest.

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

## Scheduler wakes

`just scheduler` explicitly enables the extension in `extensions/scheduler/`.
It exposes one `scheduler_submit` tool for immediate heartbeats, delayed or
absolute-time work, finite repetition, and cron schedules. The extension invokes
the existing global `bq` executable directly without a shell and returns as soon
as `bq` exits. A zero exit confirms acceptance. Any other result leaves acceptance
unknown because finite submission may already have created durable work; do not
blindly retry an unknown result. The extension never waits for payload completion,
watches OMQueue, polls Job state, or exposes Queue administration.

Every submission requires a complete, self-contained `reentryPrompt`. An
optional payload contains an executable, literal arguments, and a working
directory; omitting it creates a heartbeat-only wake. Timing fields are passed to
`bq`, which remains responsible for syntax and validation:

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
in this repository. When a
user explicitly asks to invoke or inspect raw `bq`, use ordinary bash rather
than `scheduler_submit`.

## Asynchronous subagents

`just subagents` explicitly enables the extension in
`extensions/subagents/`. It starts clean, persistent Pi conversations and returns
as soon as the child RPC process accepts a prompt. Each accepted turn later
queues exactly one completion, failure, or interruption pong in the orchestrator
conversation.

After acceptance, the orchestrator must not sleep, run a wait loop, or repeatedly
call `subagent_list` for completion. It may continue useful work independent of
the subagent result; otherwise it must end its response so user input and the
later pong can enter the conversation.

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
| `subagent_list` | `/sublist` | List session-scoped known conversations |

Use plain command arguments for common operations, or JSON with `/sub` and
`/subcont` for working-directory, tool, and name options. Every start and
continuation inherits the orchestrator's active model and thinking level at the
moment that turn is dispatched; agent and command inputs cannot override either
choice. The live subagent widget and `/sublist` output show both inherited
routing values. For example:

```text
/sub Inspect the authentication flow and report risks.
/sub {"prompt":"Run the focused tests","name":"tests","tools":["read","bash"]}
/subcont 1 Check the newly changed files.
/substeer 1 Focus only on the parser.
/substop 1
/sublist
```

Subagents inherit the current environment, including credentials and SSH agent
access. They are not sandboxed. Child extensions are disabled, only the user's
Pi skills directory is loaded, and at most twelve child processes run at once.
The registry is intentionally in memory; native Pi JSONL sessions remain after
the orchestrator exits.

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
