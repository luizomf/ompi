# Repository Working Context

This file is an orientation map for agents and humans. Its purpose is to make
the accepted outcome, relevant context, lifecycle boundary, and verification
evidence visible before a change is made—not to turn every preference into a
rule.

It applies repository-wide unless a more specific nested `AGENTS.md` governs a
subtree. `CLAUDE.md` is a symlink to this file; edit `AGENTS.md`, not both.

## What this repository is

`ompi` is a learning lab for small, explicit, security-conscious Pi Coding
Agent launch profiles, extensions, notes, and experiments. The stack is Node.js,
strict TypeScript ESM, Vitest, Pi Coding Agent, npm, and `just`.

Prefer an inspectable solution for a demonstrated need. Avoid turning an
experiment into broad resource discovery, persistent task infrastructure, or a
generic workflow platform before the repository has a concrete use for it.

Code, comments, commits, issues, and repository documentation are in English.
Reviewed third-party material remains cited prose; extracted executable
snapshots are not part of the repository.

## Get oriented before changing anything

Before editing, be able to identify:

1. **Accepted outcome** — the GitHub issue or direct maintainer request and its
   observable acceptance criteria.
2. **Current state** — Git status, relevant history and diffs, open overlapping
   work, and the implementation and tests at the affected seam.
3. **Relevant context** — the context selected through `CONTEXT-MAP.md`, plus any
   linked decisions or security/lifecycle documentation.
4. **Boundary being changed** — which component owns the behavior and which
   lifecycle, trust, cleanup, and user-visible contracts must remain intact.
5. **Evidence** — the focused check used while working and the applicable
   handoff gates.

Use sources in this order when they disagree:

1. the accepted request and its acceptance criteria;
2. relevant context documents, linked decisions, and security/lifecycle
   boundaries; and
3. the engineering and safety defaults in this file.

`docs/agents/domain.md` explains how repository contexts are maintained. Context
documents own canonical terminology and lifecycle boundaries. `README.md` owns
public setup and observable usage. Code and tests are implementation evidence;
they do not silently redefine intent. Git history, issues, pull requests, and
intent-bearing comments help explain why surprising behavior exists.

When those sources conflict, surface the mismatch and resolve intent instead of
making them agree by guesswork. Security and lifecycle boundaries remain in
force when a request is silent. Keep affected governing docs, tests, and
intent-bearing comments synchronized with an intentional behavior change.

## Repository and lifecycle map

- `justfile` — isolated Pi launch profiles grouped by intent.
- `extensions/background-tool.ts` — session-scoped wrapper for explicitly
  selected finite text-result tools; each wrapped tool owns its effect and
  authorization boundary.
- `extensions/browser-fetch/` — bounded Chromium page fetcher for explicitly
  authorized HTTP and HTTPS destinations, without extension-local network
  classification.
- `extensions/codex-search/` — bounded Codex research and image-generation
  adapter.
- `extensions/managed-process/` — explicit session lifecycle for genuinely
  long-running local processes.
- `extensions/scheduler/` — OMQueue-backed finite work, scheduling, and
  best-effort session wakes.
- `extensions/subagents/` — clean, persistent Pi conversations with
  session-scoped process control.
- `extensions/tmux-status/` — best-effort Pi session and running-state metadata
  for the current tmux window; outside tmux it is inert.
- `CONTEXT-MAP.md` — routing table for the current domain contexts.
- `docs/*/CONTEXT.md` — canonical context terminology, contracts, and ownership
  boundaries.
- `docs/orchestration-exploration.md` and `docs/research/` — historical findings
  and decision input, not a current feature inventory or executable policy.
- `docs/agents/` — issue-tracker, triage-label, and domain-doc configuration.

Keep the lifecycle seams visible:

- a **background operation** is finite and session-scoped; it waits in print
  mode or releases the tool call and later delivers one result outside print
  mode, while its wrapped tool retains responsibility for any effects;
- a **managed process** is genuinely long-running and has explicit snapshot and
  stop operations but no automatic completion wake;
- a **scheduler submission** is fixed finite work or a heartbeat routed through
  OMQueue with a best-effort wake; and
- a **subagent** is an independent Pi conversation whose process and
  conversation lifetimes are distinct.

Do not move behavior across these seams merely because the mechanisms all run
asynchronously. Read the selected context document before changing one.

## Change workflow

1. Keep the change small, complete, and tied to the accepted outcome. Split work
   into independently testable behavior slices when it becomes too large for
   meaningful human review.
2. Use `issue -> branch -> pull request -> merge` for substantial work. Commit
   and push completed small, low-risk maintenance directly to `main`, including
   documentation, instructions, issue templates, tracker metadata, and trivial
   workflow changes; do not leave routine work pending in the working tree.
3. Use focused conventional commits such as `feat`, `fix`, `refactor`, `test`,
   `docs`, and `chore`.
4. Record durable, non-obvious decisions in the appropriate issue, context doc,
   test, or repository documentation.
5. Review the exact diff and leave the working tree understandable. Do not mix
   unrelated changes.

Specs and issues live in GitHub Issues. Follow
`docs/agents/issue-tracker.md`; use the mappings in
`docs/agents/triage-labels.md` rather than inventing labels.

Do not change repository visibility, publish releases or packages, force-push
`main`, or perform destructive Git operations without explicit maintainer
authorization.

## Implementation defaults

- Prefer simple, explicit, readable code over cleverness, pattern purity, and
  premature abstraction.
- Prefer flat control flow and cohesive responsibilities over deep nesting,
  large conditional trees, high cyclomatic complexity, and god modules. Split
  by responsibility, not arbitrary line counts.
- Preserve bounded model-visible output, literal argument vectors, direct
  shell-free subprocess invocation, explicit cleanup, and the lifecycle
  contract documented for each extension.
- Preserve useful error context and original causes. Errors should not disappear
  silently.
- Use Pi's native sessions instead of adding custom persistence or task
  infrastructure without a demonstrated need.
- Use comments for non-obvious intent, constraints, tradeoffs, and consequences;
  do not narrate visible code. Inspect docs, tests, tracker history, and Git
  history before removing surprising code or comments.
- Put mechanically enforceable behavior in actual tool configuration and tests,
  not repeated prose. A missing gate is a visible gap, not permission to invent
  a command or claim enforcement.

## Safety boundaries

- Keep powerful capabilities narrow, explicit, and opt-in. Pi extensions run
  with the user's full permissions and may inherit credentials and SSH-agent
  access.
- Preserve explicit isolation. Do not enable automatic `.env` loading, broaden
  Pi resource discovery, or enable child extensions without an accepted need.
- Treat prompts, skills, extensions, scripts, subprocess input/output, paths,
  protocol frames, and session references as untrusted at their boundaries.
  Review third-party material before use; never execute it automatically.
- Never commit secrets, `.env` files, credentials, Pi sessions, conversations,
  logs, generated state, or local reference checkouts. Inspect `.gitignore`
  before adding generated or local files.
- Treat the repository and tracker as public. Remove private hostnames, network
  topology, account or subscription identifiers, personal financial details,
  unpublished project data, absolute home paths, and incidental local runtime
  details unless the maintainer explicitly authorizes publication.
- Do not expose environment values, authorization headers, private keys, hidden
  model reasoning, or unreviewed process output in logs, widgets, errors, tool
  results, fixtures, or public reports.
- Before recursive or batch deletion, inspect the fully expanded target and
  prefer reversible deletion when practical.

## Test intent

Tests are regression protection and executable evidence of observable behavior,
not authority to redefine intent or a target for implementation-shaped code.

- Prefer test-driven development (TDD) whenever practical.
- Give every behavior change meaningful coverage and every bug fix a regression
  test that would fail without the fix.
- Assert stable public behavior and lifecycle contracts. Avoid volatile prose,
  timestamps, generated IDs, incidental versions, private call shapes, and mock
  call counts unless they are the specified behavior.
- Cover relevant rejection, error, cancellation, cleanup, limit, and shutdown
  paths—not only success.
- Test process and lifecycle behavior through deterministic fakes. Keep
  provider-backed and external-service checks optional.
- Do not weaken a valid test merely to make an implementation pass. Resolve the
  intended behavior first.

## Verification map

For `justfile` changes:

```sh
just --list
just --dry-run <changed-recipe>
```

For extension or dependency changes:

```sh
npm test
npm run typecheck
```

`npm test` runs the Vitest suite while excluding the ignored local
`my-pi-setup/**` tree. `npm run typecheck` checks TypeScript under `extensions/`
using the strict root `tsconfig.json`. `npm run test:browser-fetch` and
`npm run test:codex-search` are useful focused checks during development but do
not replace the full applicable gates before handoff.

For instructions or documentation-only changes, verify referenced paths and
links, inspect the rendered text where useful, and run `git diff --check`.

The repository currently has no CI workflow or root lint, formatter, build, or
documentation-check script. Describe that absence accurately; do not claim an
unrun or nonexistent check passed.

## Documentation and handoff

Update `README.md` when launch commands, setup, profiles, or observable extension
behavior change. Update the relevant context document when canonical terms,
security boundaries, lifecycle ownership, or durable decisions change. Update
`CONTEXT-MAP.md` when a context is added, removed, or materially re-scoped.

Before finishing, make the result easy for the next human or agent to inspect:

- review the exact diff for unrelated churn;
- verify affected paths, links, commands, and documented tool semantics;
- run the smallest relevant checks and all applicable handoff gates;
- confirm no secret, private information, generated state, or executable
  third-party snapshot was added; and
- report the changed behavior or documentation, evidence inspected, checks run,
  checks not run, and any unresolved mismatch or enforcement gap.

Ask for clarification only when ambiguity materially changes behavior, security,
scope, workflow, or authorization. Otherwise, state a reasonable assumption and
proceed.
