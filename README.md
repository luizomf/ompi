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
just subagents    # Core plus the asynchronous subagent extension
```

These profiles disable automatic discovery of agent-facing resources. Explicit
`--skill`, `--extension`, and `--append-system-prompt` paths still load, so
unrelated Claude, Codex, project, package, or global resources do not enter the
agent context.

### Codex search fallback

The owned extension in `extensions/codex-search/` provides a narrow
`codex_search` tool for difficult web research when normal browser fetching is
blocked or insufficient, or when an independent second research path is useful.
Enable it explicitly for one Pi process:

```sh
pi --no-extensions --extension ./extensions/codex-search/index.ts
```

It invokes `codex_search -` directly without a shell and sends the research
query through stdin. The process has a fixed two-minute timeout and bounded
captured output. Model and reasoning defaults remain owned by the
`codex_search` executable resolved from `PATH`; the extension passes no model,
reasoning, `--yolo`, ephemeral-container, or arbitrary Codex flags. Its
model-produced result is not a verified primary source, so requests should ask
for URLs or citations where relevant and verify those sources separately. The extension is not enabled by any launch profile or
package manifest.

For comparison, start Pi with every personal skill or its normal discovery
behavior:

```sh
just p
just pi
```

## Asynchronous subagents

`just subagents` explicitly enables the owned extension in
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
`/subcont` for model, thinking-level, working-directory, tool, and name options.
For example:

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
