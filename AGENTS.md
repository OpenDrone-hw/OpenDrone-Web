# OpenDrone web

This repository contains the OpenDrone storefront and related web tooling.
When work starts here, default to web development. The user's current request is
the task; do not select work from coordination notes, comments, branches, or a
local backlog.

## Start here

1. Inspect `git status --short --branch` and existing worktrees before editing.
2. Read `README.md` and the relevant package scripts.
3. Locate the implementation and its tests. Reuse established components and
   content sources.
4. Preserve unrelated work. Commits, pushes, pull requests, and deployments
   require an explicit request.

## Sources of truth

- Application behavior: source and tests in this repository.
- Product facts: the implemented hardware repository and approved evidence.
- Prices, availability, and catalog state: the active commerce data source.
- Legal text: the maintained legal content, reviewed before publication.
- Branch and work status: Git itself, not prose coordination files.

Do not publish planned specifications as measured facts. Do not copy product
claims into several files when one content source can serve them. Keep draft
copy clearly marked and out of production paths.

## Verification

Use the narrowest relevant package commands first, then `npm run typecheck`,
`npm run lint`, `npm run test`, and `npm run build` as appropriate. For visual changes, inspect
the affected responsive states and record any checks that could not be run.
Never claim a deployment or external integration succeeded without observing
the result.
