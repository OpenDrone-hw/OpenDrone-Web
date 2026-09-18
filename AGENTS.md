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
- Prices, availability, and catalog state: Odoo at `shop.incutec.com`, read
  through `GET /incutec/catalog.json` (`CATALOG_URL`). Nothing here writes
  them. Customer-facing SKUs come from `../../stock/product_skus.json` and are
  set on the Odoo products by the ERP repository's import.
- Stock quantities: InvenTree (`../../stock`) is the stock authority and Odoo
  mirrors it. Never set inventory from this repository.
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

Production (`opendrone.be`, `www.opendrone.be`) is the Cloudflare Worker
`opendrone-web`, deployed by `.github/workflows/cloudflare-production.yml` on
every push to `main` (`wrangler deploy --config wrangler.production.toml`).
Hydrogen's Vite toolchain builds it; no page, loader or action calls a
Shopify API. See README `## Hosting` for the deploy, DNS and secrets detail.

The app boots on `SESSION_SECRET` alone. `PUBLIC_SHOP_URL`
(`https://shop.incutec.com`) and `CATALOG_URL`
(`https://erp.incutec.com/incutec/catalog.json`) default to production and are
the only commerce values; both are public, and this repository holds no
commerce credentials. `GOALS_URL` is build-time only, for `goals:update`.
Runtime secrets are Worker secrets, set per environment with `wrangler secret
put <NAME>`, never committed; the gitignored `.env` holds local copies, named
in `.env.example`. InvenTree credentials live in `../../stock/.env`; company
Notion, DNS and carrier credentials live in `../../operations/.env`. Name
variables, never print values.

## Verification

Use the narrowest relevant package commands first, then `npm run typecheck`,
`npm run lint`, `npm run test`, and `npm run build` as appropriate. For visual changes, inspect
the affected responsive states and record any checks that could not be run.
Never claim a deployment or external integration succeeded without observing
the result.
