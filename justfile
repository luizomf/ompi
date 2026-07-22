default:
    @just --list

# Start Pi with only the personal skills directory
p:
    pi --no-skills --skill "${HOME}/.pi/agent/skills"

# Start Pi with its default discovery behavior
pi:
    pi
