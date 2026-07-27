# Domain Docs

This is a multi-context repository for Pi experiments and workflows maintained here.

## Before Working

1. Read `CONTEXT-MAP.md` at the repository root.
2. Read only the `CONTEXT.md` files relevant to the work.
3. Read relevant ADRs under the context's `docs/adr/`, plus root `docs/adr/` for repository-wide decisions.
4. Proceed silently when a referenced ADR directory does not exist.

Use each context glossary's canonical terms in issues, plans, code, tests, and documentation. Do not apply one experiment's language to unrelated Pi work.

Create a new context lazily when another experiment develops domain-specific language. Add it to `CONTEXT-MAP.md`; do not turn the map into a specification.

## Current Layout

- `docs/scheduler/CONTEXT.md` — Pi scheduler wake extension language and Queue boundary
- `docs/subagents/CONTEXT.md` — Pi subagent extension language
- `docs/subagents/docs/adr/` — future context-specific ADRs
- `docs/adr/` — future repository-wide ADRs
