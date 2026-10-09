# OpenDrone web

The OpenDrone storefront (opendrone.be). Default to web development here. The
user's request is the task; do not pick work from comments, branches or notes.

## Start here

1. `git status --short --branch` and `git worktree list` before editing.
2. Read `README.md`, then the package scripts you will use.
3. Find the implementation and its tests. Reuse existing components and
   content sources.
4. Preserve unrelated work. Commits, pushes, pull requests and deployments
   need an explicit request.

**A merge to `main` deploys production** (`cloudflare-production.yml`). Merge
only on an explicit request; "merge" includes the cleanup of the branch and
worktree.

## Sources of truth

- Campaign strategy and regulatory research: the team's private knowledge
  base (team members only). Keep private strategy and regulatory research
  there, not in storefront docs or in this public repository.
- Application behaviour: source and tests in this repository.
- Catalog identity, prices and customer marketing consent: Shopify. The storefront reads Shopify through server-held tokens. Checkout is open only while `PUBLIC_COMING_SOON=0` and `SHOPIFY_CHECKOUT_WRITE_ENABLED=1` in `wrangler.production.toml`; changing either needs the founder's go.
- Prices: EUR prices live in Shopify. The US price is the EUR VAT-inclusive price plus `priceUpliftPct` from `content/us-sales.json`, converted by Shopify's US price list (README "US prices"). `npm run us:prices` compares the file with Shopify; `--apply` writes and needs the founder's go.
- Canonical customer-facing SKUs: the workspace `stock/product_skus.json`; every Shopify SKU also needs a fail-closed entry in `SHOPIFY_PREVIEW_POLICY_JSON`.
- Product facts: the board repositories and their evidence. Specs are
  mirrored from each board README by `npm run sync:specs`; board art and
  schematics are exported from the board checkouts (`../hardware`, or
  `OPENDRONE_HARDWARE`).
- Roadmap display and checkout gates: `docs/product-status.md`. Board
  `status-*` topics do not override server-side purchase authorization.
- Support: conversations with site and Discord customers live in Discord
  threads, ticket state in D1 (`SUPPORT_DB`), the customer in Shopify. A
  customer who emails is answered by email, from a Gmail draft the Worker
  prepares (README "Mail"); a person sends it and the Worker never sends mail.
  Do not add a support email address to pages or chrome. Turning on
  `SUPPORT_EMAIL_NOTIFY_ENABLED` or `SUPPORT_MAIL_INTAKE_ENABLED` needs the
  founder's go.
- Legal text: drafted and reviewed in the private `operations` repository
  (`documents/storefront-legal/`). `app/content/legal/` holds only approved,
  published text, copied in by one `legal: publish vX` PR after the founder's
  go. Never open a draft, redline or review PR for legal text here: this
  repository and its Discord feed are public.
- Branch and work status: Git itself.

Do not publish planned specifications as measured facts. Keep one content
source per claim. Keep draft copy out of production paths.

## Live systems and credentials

Production is the Cloudflare Worker `opendrone-web`, deployed by
`.github/workflows/cloudflare-production.yml` on every push to `main`. The app boots on `SESSION_SECRET` plus the Shopify catalog configuration named in `.env.example`. Production public gates live in `wrangler.production.toml`; tokens, the per-SKU policy and the webhook secret are Worker secrets. The staging Worker (`wrangler.toml`) deploys from the `staging` branch and shares the production Shopify store. The gitignored `.env` holds local copies. Name variables, never print values.

## Shopify admin

The agent has Shopify Admin API access through the server tokens and the
Shopify MCP, and can drive the Shopify admin in Chrome. Do not tell the founder
it has no access; try the API, then Chrome. A setting changed in the admin UI
counts only after it is saved and read back (reload the page or query the API).
B2B VAT or reverse-charge handling has no documentation in this repository:
read the order, customer and tax settings in Shopify before changing anything.

## Verification

Run the narrowest relevant package command first, then `npm run typecheck`,
`npm run lint`, `npm test` and `npm run build` as appropriate. For visual
changes inspect the affected responsive states. Never claim a deployment or
an external integration succeeded without observing the result.

## Visual changes

- Earlier approved visuals (header, hero, pill heights, logo colour in dark mode) must not regress. Before the change, screenshot the same routes and states from the live site (`BASE=https://opendrone.be node scripts/shot.mjs <route> light|dark`, output in `.mobile-audit/shots/`); after the change, shot again and compare. `npm run audit:mobile` captures all routes on three phones.
- Use only real product photos and renders from the repository sources (`public/`, `npm run gen:board-art`, `npm run gen:box-art`). No invented decorative elements, icons or illustrations.

## By task

- Run the site: `cp .env.example .env`, set `SESSION_SECRET`, `npm install`, `npm run dev`; the studio is at `/studio`.
- Check a change: `npm run typecheck && npm run lint && npm test`; add `npm run build` when routes, the server entry or the Vite config changed.
- Change copy or product chapters: edit through `/studio` or the JSON under `content/`; `npm run studio:coverage` lists copy still baked into code; `npm run studio:keys` fails when code uses a copy id missing from `content/copy/`.
- Publish approved legal text: copy it from `operations/documents/storefront-legal/{en,nl,fr}/` into `app/content/legal/{en,nl,fr}/` unchanged, three languages in step, in one PR. The studio Docs tab is for that copy only.
- Open or close the shop, run a preorder campaign, release a batch or mail buyers: the README sections of those names. Every order script is a dry run until `--apply` or `--send`; those need an explicit request.
- Work on support tickets: README "Support tickets". Local runs use `npm run support:sandbox` (README "Test support locally"), never the real Discord or Shopify writes. Parallel dev servers need `VITE_CACHE_DIR=.vite-cache`.
- Check the live site: `BASE=https://opendrone.be node scripts/smoke.mjs` (read-only GETs) and `/api/status/campaign`.
- Refresh board art or specs after a hardware release: `npm run gen:board-art` (KiCad and cwebp installed), `npm run sync:specs`, then `npm run sync:specs:check` before the PR.
- Update the lab walkthrough on `/visit`: its source and tests live outside this repository; `npm run sync:lab-visit -- <game dir>` copies the runtime files into `public/lab-visit/` and refuses any file over the 25 MiB static asset limit. Never edit `public/lab-visit/` by hand.
- Refresh the in-the-box renders after a CAD export or a box-list change: `npm run gen:box-art` (Blender 4.2 or newer, cwebp and ImageMagick installed; about 1 to 2.5 min per image on an M3 Pro; the Incutec wordmark comes from the workspace `design/` repo, set `INCUTEC_DESIGN_DIR` outside the main checkout). It rewrites `public/boxes/` and each product's `inTheBoxImage`; parts and box items per image are in `scripts/in-the-box/specs/`.
