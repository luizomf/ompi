# Project Guidelines

## Repository Context

Pilearn is a private learning lab for improving our Pi Coding Agent workflow.
It contains small, explicit launch profiles, notes, and experiments that we own,
plus audited third-party material used only as reference.

`pi-vs-claude-code/` is a vendored snapshot of
<https://github.com/disler/pi-vs-claude-code> at commit
`0ed11f44932fdef29bd98467700019762298f50d`. Its nested Git metadata was removed
so this repository owns the snapshot. Do not treat its code as trusted merely
because it is present here.

## Working Agreements

- Keep the workflow small, explicit, and easy to inspect.
- Prefer short `just` recipes grouped by intent instead of loading every feature.
- Keep powerful extensions opt-in. Pi extensions execute with the user's full
  permissions and may inherit credentials from the environment.
- Review third-party prompts, skills, extensions, and scripts before running
  them. Never execute reference material automatically.
- Put experiments we own outside `pi-vs-claude-code/` unless the task explicitly
  updates the vendored snapshot.
- Do not commit `.env` files, credentials, sessions, logs, or generated state.
- Do not enable automatic `.env` loading in the `justfile`.
- Make the smallest useful change and avoid abstractions without a current need.
- Use English for code, comments, and repository documentation.

## Git and GitHub

- Keep the GitHub repository private.
- Use conventional commits: `type(scope): imperative description`.
- Use issues and short-lived branches for substantial features. Tiny workflow or
  documentation adjustments may be committed directly when the owner requests
  them.
- Never force-push `main` or perform destructive Git operations without explicit
  approval.

## Verification

For `justfile` changes, run at least:

```sh
just --list
just --dry-run <recipe>
```

For code experiments, use the relevant formatter, type checker, and tests. State
clearly when something was inspected but not executed.
