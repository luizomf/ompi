# Issue Tracker: GitHub

Specs, tickets, and issues for this repository live in GitHub Issues. Use the `gh` CLI from this repository so it infers the repository from the Git remote.

A direct maintainer request can authorize small, low-risk maintenance without
creating a duplicate issue. Use an issue when durable acceptance
criteria, triage, coordination, or substantial implementation work needs to be
visible beyond the current conversation.

## Operations

- Create an issue with `gh issue create`; use a heredoc or body file for multiline content.
- Read an issue and its discussion with `gh issue view <number> --comments`.
- List work with `gh issue list` and request JSON fields when filtering is needed.
- Update labels with `gh issue edit <number> --add-label <label>` or `--remove-label <label>`.
- Comment with `gh issue comment <number> --body <text>`.
- Close with `gh issue close <number> --comment <text>`.

## Skill Conventions

- When a skill says to publish a spec, ticket, issue, or wayfinder map, create a GitHub issue.
- When a skill says to fetch a ticket, read the issue body, labels, and comments.
- Apply the labels mapped in `triage-labels.md`; do not invent synonyms.
- Pull requests are not a request or triage surface for this repository.
- GitHub issues and pull requests share a number space; resolve an ambiguous number before acting.

## Wayfinding

A wayfinder map is one GitHub issue whose child investigations are linked as sub-issues when GitHub supports them. Use native issue dependencies for blocking edges; otherwise record explicit `Blocked by: #<number>` lines. Claim work by assigning the issue before modifying the repository.
