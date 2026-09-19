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
- Prices, availability, SKUs, stock and catalog state: Odoo at
  `shop.incutec.com`, read through `GET /incutec/catalog.json`
  (`CATALOG_URL`). Nothing here writes them.
- Product facts: the board repositories and their evidence. Specs are
  mirrored from each board README by `npm run sync:specs`; board art and
  schematics are exported from the board checkouts (`../hardware`, or
  `OPENDRONE_HARDWARE`).
- What is public and buyable: the `status-*` topic on each board repository
  (`docs/product-status.md`).
- Legal text: `app/content/legal/`, reviewed before publication. `npm run
  sync:legal` overwrites four Dutch pages only when `COMPLIANCE_SRC` is set.
- Branch and work status: Git itself.

Do not publish planned specifications as measured facts. Keep one content
source per claim. Keep draft copy out of production paths.

## Live systems and credentials

Production is the Cloudflare Worker `opendrone-web`, deployed by
`.github/workflows/cloudflare-production.yml` on every push to `main`. The
app boots on `SESSION_SECRET` alone; `PUBLIC_SHOP_URL` and `CATALOG_URL` are
public values with production defaults. Every other runtime value is a Worker
secret (`wrangler secret put <NAME>`); the gitignored `.env` holds local
copies, named in `.env.example`. Name variables, never print values. This
repository holds no commerce credentials.

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
- Update the goal meters: `npm run goals:update` (dry run), then `npm run goals:update -- --write`, with `GOALS_URL` set in `.env`; commit `content/goals.json` as a normal PR.
- Refresh board art or specs after a hardware release: `npm run gen:board-art` (KiCad and cwebp installed), `npm run sync:specs`, then `npm run sync:specs:check` before the PR.
