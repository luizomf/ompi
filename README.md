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

Start Pi with only the personal skills directory:

```sh
just p
```

This expands to:

```sh
pi --no-skills --skill "${HOME}/.pi/agent/skills"
```

`--no-skills` disables automatic skill discovery. The explicit `--skill` path
is still loaded, preventing unrelated Claude, Codex, project, or package skills
from entering the session.

Start Pi with its normal discovery behavior:

```sh
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
