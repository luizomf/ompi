# Pilearn

Private learning lab for building a small, explicit, and security-conscious
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
Pi skills directory is loaded, and at most four child processes run at once.
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
  reliability boundaries, and vendored extension risks.

## Reference repository

[`pi-vs-claude-code/`](pi-vs-claude-code/) is a vendored reference snapshot of
[`disler/pi-vs-claude-code`](https://github.com/disler/pi-vs-claude-code) at
commit `0ed11f44932fdef29bd98467700019762298f50d`.

The snapshot was statically reviewed before import, but its extensions are not
automatically trusted. Pi extensions execute arbitrary code with the current
user's permissions, so inspect and enable them individually.

## Safety defaults

- No automatic `.env` loading.
- No default bundle of third-party extensions.
- Short, intent-based launch recipes.
- Third-party code is reference material until explicitly reviewed and adopted.
