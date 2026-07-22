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
just bare         # No discovered resources or context files
just core         # Only this project's AGENTS.md
just research     # AGENTS.md, research skill, and browser extension
just orchestrate  # AGENTS.md, handoff, tmux-worker, and wormhole skills
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
