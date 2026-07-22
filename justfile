default:
    @just --list

# Start Pi with only the exit alias extension
bare:
    pi --no-skills --no-extensions --extension "${HOME}/.pi/agent/extensions/exit-alias.ts" --no-prompt-templates --no-context-files

# Start Pi with AGENTS.md and the exit alias extension
core:
    pi --no-skills --no-extensions --extension "${HOME}/.pi/agent/extensions/exit-alias.ts" --no-prompt-templates --no-context-files --append-system-prompt ./AGENTS.md

# Start Pi with the research skill and browser extension
research:
    pi --no-skills --skill "${HOME}/.pi/agent/skills/research" --no-extensions --extension "${HOME}/.pi/agent/extensions/browser-fetch/index.ts" --no-prompt-templates --no-context-files --append-system-prompt ./AGENTS.md

# Start Pi with the handoff and tmux orchestration skills
orchestrate:
    pi --no-skills --skill "${HOME}/.pi/agent/skills/handoff" --skill "${HOME}/.pi/agent/skills/tmux-worker" --skill "${HOME}/.pi/agent/skills/wormhole" --no-extensions --no-prompt-templates --no-context-files --append-system-prompt ./AGENTS.md

# Start Pi with only the personal skills directory
p:
    pi --no-skills --skill "${HOME}/.pi/agent/skills"

# Start Pi with its default discovery behavior
pi:
    pi
