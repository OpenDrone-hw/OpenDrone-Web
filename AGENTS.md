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
- Prices, availability, and catalog state: the backend configured by
  `CATALOG_URL`, with Odoo as the production target. Treat migrated Odoo data
  as authoritative only after the migration cutover gate is approved. This
  app only reads the feed. Customer-facing SKUs come from
  `../../stock/product_skus.json` and are set on Odoo products by the ERP
  repository's import.
- Stock quantities: InvenTree (`../../stock`) remains authoritative until the
  migration cutover gate transfers that role to Odoo. Never set inventory from
  this repository.
- The contract between this app and Odoo, including the catalog JSON shape and
  the `/incutec/add` hand-off: `erp/docs/storefront-contract.md`.
- Legal text: the Markdown under `app/content/legal/`, reviewed before
  publication. `npm run sync:legal` overwrites four Dutch pages only when
  `COMPLIANCE_SRC` names a source directory; unset, it keeps the snapshots.
- Board art, schematics and specs: exported from the board checkouts beside
  this repository (`../hardware`, or `OPENDRONE_HARDWARE`).
- Branch and work status: Git itself, not prose coordination files.

Do not publish planned specifications as measured facts. Do not copy product
claims into several files when one content source can serve them. Keep draft
copy clearly marked and out of production paths.

## Live systems and credentials

This repository maintains a route-free Cloudflare preview configuration in
`wrangler.toml`, a custom-domain production configuration in
`wrangler.production.toml`, and separate deployment workflows. Configuration
in Git does not prove that a host or DNS cutover has happened; verify external
state before making a deployment claim. Hydrogen remains the Vite/application
toolchain, but loaders and actions do not call Shopify APIs.

`RUNTIME_PROFILE=production` fails closed unless every required runtime value
passes `npm run check:runtime-env -- production`. Preview uses isolated
credentials, including a preview session secret and the staging catalog's
server-side Basic authentication. Keep secrets in the corresponding GitHub
environment and Cloudflare Worker secrets; use the gitignored `.env` locally.
Public backend endpoints and launch flags live in the two Wrangler configs.
`GOALS_URL` is build-time only for `goals:update`. InvenTree credentials live
in `../../stock/.env`; company Notion, DNS and carrier credentials live in
`../../operations/.env`. Name variables, never print values.

## Verification

Use the narrowest relevant package commands first, then `npm run typecheck`,
`npm run lint`, `npm run test`, and `npm run build` as appropriate. For visual changes, inspect
the affected responsive states and record any checks that could not be run.
Never claim a deployment or external integration succeeded without observing
the result.
