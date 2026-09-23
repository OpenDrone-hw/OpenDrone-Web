# OpenDrone web

The OpenDrone storefront (opendrone.be). Default to web development here. The
user's request is the task; do not pick work from comments, branches or notes.

## Start here

1. `git status --short --branch` and `git worktree list` before editing.
2. Read `README.md`, then the package scripts you will use.
3. Find the implementation and its tests. Reuse existing components and
   content sources.
4. Preserve unrelated work. Commits, pushes, pull requests and deployments
   need an explicit request. A merge to `main` deploys production.

## Sources of truth

- Application behaviour: source and tests in this repository.
- Catalog identity, prices and customer marketing consent: Shopify. The production storefront reads Shopify through server-held tokens. Checkout remains explicitly closed by `PUBLIC_COMING_SOON=1` and `SHOPIFY_CHECKOUT_WRITE_ENABLED=0`.
- Canonical customer-facing SKUs: the workspace `stock/product_skus.json`; every Shopify SKU also needs a fail-closed entry in `SHOPIFY_PREVIEW_POLICY_JSON`.
- Product facts: the board repositories and their evidence. Specs are
  mirrored from each board README by `npm run sync:specs`; board art and
  schematics are exported from the board checkouts (`../hardware`, or
  `OPENDRONE_HARDWARE`).
- Roadmap display and checkout gates: `docs/product-status.md`. Board
  `status-*` topics do not override server-side purchase authorization.
- Legal text: `app/content/legal/`, reviewed before publication. `npm run
  sync:legal` overwrites four Dutch pages only when `COMPLIANCE_SRC` is set.
- Branch and work status: Git itself.

Do not publish planned specifications as measured facts. Keep one content
source per claim. Keep draft copy out of production paths.

## Live systems and credentials

Production is the Cloudflare Worker `opendrone-web`, deployed by
`.github/workflows/cloudflare-production.yml` on every push to `main`. The app boots on `SESSION_SECRET` plus the Shopify catalog configuration named in `.env.example`. Production public gates live in `wrangler.production.toml`; tokens and the closed per-SKU policy are Worker secrets. The gitignored `.env` holds local copies. Name variables, never print values.

## Verification

Run the narrowest relevant package command first, then `npm run typecheck`,
`npm run lint`, `npm test` and `npm run build` as appropriate. For visual
changes inspect the affected responsive states. Never claim a deployment or
an external integration succeeded without observing the result.

## By task

- Run the site: `cp .env.example .env`, set `SESSION_SECRET`, `npm install`, `npm run dev`; the studio is at `/studio`.
- Check a change: `npm run typecheck && npm run lint && npm test`; add `npm run build` when routes, the server entry or the Vite config changed.
- Change copy or product chapters: edit through `/studio` or the JSON under `content/`; `npm run studio:coverage` lists copy still baked into code.
- Update the legal pages: edit `app/content/legal/{en,nl,fr}/`; run `COMPLIANCE_SRC=<dir> npm run sync:legal` only when a reviewed source directory is given.
- Refresh board art or specs after a hardware release: `npm run gen:board-art` (KiCad and cwebp installed), `npm run sync:specs`, then `npm run sync:specs:check` before the PR.
