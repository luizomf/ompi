# Domain Documentation

This repository contains several Pi experiments with different lifecycle and
security boundaries. Domain documentation helps an agent or human select the
right vocabulary and contract before changing behavior.

## Orientation

1. Identify the accepted issue or direct request and its observable outcome.
2. Start at `CONTEXT-MAP.md` and select only the contexts touched by the work.
3. Read each selected `CONTEXT.md`, then the affected implementation and tests.
4. Read decisions or ADRs linked by those documents when present. Do not assume
   a decision directory must exist.
5. Use the selected context's canonical terms in issues, plans, code, tests, and
   documentation. Do not apply one experiment's language to another lifecycle.

## Document ownership

- `CONTEXT-MAP.md` owns the current context inventory and short routing
  descriptions.
- Each context's `CONTEXT.md` owns its terminology, lifecycle contract, security
  boundaries, and implementation ownership.
- The accepted issue or direct maintainer request owns the desired outcome and
  acceptance criteria.
- `README.md` owns public setup and observable usage.
- Code and tests provide implementation evidence; they do not silently override
  the accepted outcome or context contract.

When these sources disagree, record and resolve the mismatch rather than
copying one version into every file. Update all affected intent-bearing
artifacts once the decision is clear.

## Adding or changing a context

Create a context lazily when an experiment develops durable language, boundaries,
or ownership that no existing context can express cleanly. Keep its document
focused on those non-inferable facts rather than general engineering advice.

Add, remove, rename, or materially re-scope a context in `CONTEXT-MAP.md` in the
same change. Do not duplicate the current context list here; the map is the
single inventory.
