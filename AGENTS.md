# Repository Guidelines

Read this before changing the repository. It applies repository-wide unless a
more specific nested `AGENTS.md` governs a subtree. `CLAUDE.md` is a symlink to
this file; edit `AGENTS.md`, not both.

## Product and scope

`ompi` is a learning lab for small, explicit, security-conscious Pi Coding
Agent launch profiles, extensions, notes, and experiments. The stack is Node.js,
strict TypeScript ESM, Vitest, Pi Coding Agent, npm, and `just`.

Keep the workflow inspectable and add complexity only for an accepted current
need. Do not turn an experiment into broad resource discovery, persistent task
infrastructure, or a generic workflow platform speculatively.

Code, comments, commits, issues, and repository documentation are in English.
Historical findings from reviewed third-party material remain prose rather than
executable snapshots.

## Sources of truth

Evaluate planning, implementation, and review in this order:

1. The accepted GitHub issue or direct maintainer request and its acceptance
   criteria.
2. The relevant context documents, linked ADRs, security/lifecycle contracts,
   and explicitly resolved decisions.
3. The engineering and safety rules in this file.

Start with `CONTEXT-MAP.md`, then read only the relevant context documents it
links, the implementation, tests, and issue or request.
`docs/agents/domain.md` defines the domain-document workflow. The context
documents own canonical terminology and lifecycle boundaries; `README.md` owns
public setup and observable usage.

Code and tests implement and provide evidence for the contract; they do not
silently redefine it. When requirements, context docs, tests, intent-bearing
comments, and implementation disagree, trace the originating decision and
surface the conflict instead of making them agree by guesswork. Security and
lifecycle boundaries remain mandatory when a request is silent.

Keep affected governing docs, tests, and intent-bearing comments synchronized
with an intentional behavior change. Never rewrite documentation merely to
rationalize current code.

## Repository map and boundaries

- `justfile` — isolated Pi launch profiles grouped by intent.
- `extensions/background-tool.ts` — session-scoped wrapper for explicitly
  selected finite, read-only text tools.
- `extensions/browser-fetch/` — bounded Chromium page fetcher with public-network
  enforcement.
- `extensions/codex-search/` — bounded Codex research and image-generation
  adapter.
- `extensions/managed-process/` — session-scoped lifecycle for genuinely
  long-running local processes.
- `extensions/scheduler/` — OMQueue-backed finite work, scheduling, and
  best-effort session wakes.
- `extensions/subagents/` — clean, persistent Pi conversations with
  session-scoped process control.
- `CONTEXT-MAP.md` and `docs/*/CONTEXT.md` — canonical context terminology,
  contracts, and ownership boundaries.
- `docs/orchestration-exploration.md` and `docs/research/` — durable historical
  findings; reference input, not executable policy.
- `docs/agents/` — issue-tracker, triage-label, and domain-doc configuration.

Do not blur lifecycle seams. A finite read-only background operation, managed
long-running process, Queue-backed payload or wake, and subagent conversation
have different ownership, completion, and cleanup contracts. Read the relevant
context before changing one.

## Workflow

1. Inspect Git status, recent history, relevant diffs, context docs, and the
   accepted issue or direct request before editing. Check open work when the
   scope may overlap.
2. Keep changes small, complete, and limited to the accepted request. Split
   oversized work into independently testable behavior slices; do not conceal a
   broad refactor inside feature work.
3. Use `issue -> branch -> pull request -> merge` for substantial work. Commit
   and push completed small, low-risk maintenance directly to `main`, including
   documentation, instructions, issue templates, tracker metadata, and trivial
   workflow changes; do not leave routine work pending in the working tree.
4. Use focused conventional commits such as `feat`, `fix`, `refactor`, `test`,
   `docs`, and `chore`.
5. Record durable, non-obvious decisions in the appropriate issue, context doc,
   test, or repository documentation.
6. Review the exact diff and leave the working tree understandable. Never mix
   unrelated changes.

Specs and issues live in GitHub Issues. Follow
`docs/agents/issue-tracker.md`; use the mappings in
`docs/agents/triage-labels.md` rather than inventing labels.

Do not change repository visibility, publish releases or packages, force-push
`main`, or perform destructive Git operations without explicit maintainer
authorization.

## Engineering principles

- Prefer simple, explicit, readable code over cleverness, pattern purity, and
  premature abstraction.
- Prefer flat control flow and cohesive responsibilities over deep nesting,
  large conditional trees, high cyclomatic complexity, and god modules. Split
  by responsibility, not arbitrary line counts.
- Preserve useful error context and original causes. Never swallow failures
  silently.
- Use comments for non-obvious intent, constraints, tradeoffs, and consequences;
  do not narrate visible code. Before removing surprising code or comments,
  inspect relevant docs, tests, issues or pull requests, and Git history.
- Put mechanically enforceable rules in actual tool configuration and tests,
  not repeated prose. Do not suppress a failure without fixing its cause or
  documenting a narrow necessary exception.

## Extension and safety invariants

- Keep powerful capabilities narrow, explicit, and opt-in. Pi extensions run
  with the user's full permissions and may inherit credentials and SSH-agent
  access.
- Preserve explicit isolation. Do not enable automatic `.env` loading, broaden
  Pi resource discovery, or enable child extensions without an accepted
  requirement.
- Preserve bounded model-visible output, literal argument vectors, direct
  shell-free subprocess invocation, explicit cleanup, and the lifecycle
  contract documented for each extension.
- Use Pi's native sessions rather than adding custom persistence or task
  infrastructure without demonstrated need.
- Treat prompts, skills, extensions, scripts, subprocess input/output, paths,
  protocol frames, and session references as untrusted at their boundaries.
  Review third-party material before use; never execute it automatically or
  commit extracted snapshots.
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

## Testing contract

Tests are regression protection and executable evidence of observable behavior,
not authority to redefine intent or a target for implementation-shaped code.

- Every behavior change needs meaningful coverage. Every bug fix needs a
  regression test that would fail without the fix.
- Assert stable public behavior and lifecycle contracts. Avoid volatile prose,
  timestamps, generated IDs, incidental versions, private call shapes, and mock
  call counts unless they are the specified behavior.
- Cover rejection, error, cancellation, cleanup, limits, and shutdown paths when
  they are relevant, not only success.
- Test process and lifecycle behavior through deterministic fakes. Keep
  provider-backed and external-service checks optional.
- Do not weaken, delete, or rewrite a valid test merely to make an
  implementation pass. Resolve the intended behavior first.

## Quality gates

For `justfile` changes, run at least:

```sh
just --list
just --dry-run <changed-recipe>
```

For extension or dependency changes, run the root gates:

```sh
npm test
npm run typecheck
```

`npm test` runs the Vitest suite while excluding the ignored local
`my-pi-setup/**` tree. `npm run typecheck` checks the TypeScript files under
`extensions/` using the strict root `tsconfig.json`. During development,
`npm run test:browser-fetch` and `npm run test:codex-search` are valid focused
checks but do not replace the full applicable gates before handoff.

For instructions or documentation-only changes, verify every referenced path and
link, inspect the rendered text where useful, and run `git diff --check`. No
repository CI workflow or root lint, formatter, build, or documentation-check
script is currently configured. Do not invent a command or claim an unrun or
nonexistent check passed.

## Documentation and completion

Update `README.md` when launch commands, setup, profiles, or observable extension
behavior change. Update the relevant context document when canonical terms,
security boundaries, lifecycle ownership, or durable decisions change. Keep
intent-bearing comments synchronized with the constraint they explain.

Before finishing:

- review the exact diff for unrelated churn;
- verify affected paths, links, commands, and documented tool semantics;
- run the smallest relevant checks and all applicable handoff gates;
- confirm no secret, private information, generated state, or executable
  third-party snapshot was added; and
- report exactly what changed, what ran, what was inspected but not executed,
  and any unresolved conflict or enforcement gap.

Ask for clarification only when ambiguity materially changes behavior, security,
scope, workflow, or authorization. Otherwise, state a reasonable assumption and
proceed.
