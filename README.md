# OpenDrone Web

The storefront at [opendrone.be](https://opendrone.be): open-source FPV drone
hardware designed and sold from Belgium. Flight controllers (OpenFC), 4-in-1
ESCs (OpenESC), ExpressLRS receivers (OpenRX), carbon frames (OpenFrame) and
the OpenStack bundle.

It is a [Hydrogen](https://hydrogen.shopify.dev/) (React Router 7) app that
runs as a Cloudflare Worker. Commerce lives in Odoo at
[shop.incutec.com](https://shop.incutec.com): catalog, prices, availability,
cart, checkout, payment, orders, invoices and customer accounts. This app reads
one public catalog feed from Odoo (`GET /incutec/catalog.json`), hands every
buy click to the shop, and owns everything else the visitor sees, plus a
support desk inside the Worker and a local editing studio.

Hydrogen's Vite toolchain is build tooling only. No page, loader or action
calls a Shopify API; `@shopify/hydrogen` and `@shopify/mini-oxygen` are
build and dev dependencies.

Selling entity: Incutec BV. OpenDrone is the community project and product
brand. This repository is MIT; the hardware repositories are CERN-OHL-S.

Deep dives in `docs/`: `product-status.md` (the status system that decides
what is public and buyable), `hero-studio.md` (the homepage 3D pipeline),
`growth-architecture.md` (analytics, attribution, mail), `store-compliance.md`
(EU and Belgian requirements the store meets).

## Run it locally

```sh
git clone https://github.com/OpenDrone-hw/OpenDrone-Web.git
cd OpenDrone-Web
npm install
cp .env.example .env       # SESSION_SECRET is the only required value
npm run dev                # http://localhost:3000
```

`CATALOG_URL` and `PUBLIC_SHOP_URL` default to production, so a fresh clone
shows the live catalog with working buy links. Set `PUBLIC_COMING_SOON=0` to
see prices while the shop is closed. Without the support and mail credentials
the support desk shows an "unavailable" notice and everything else runs.

Node 22 (what CI uses).

## Commands

| Command | Does |
|---|---|
| `npm run dev` | dev server with the studio at `/studio` |
| `npm run typecheck` | `react-router typegen` then `tsc --noEmit` |
| `npm run lint` | ESLint over the repository |
| `npm test` | `node --test` over `app/**/*.test.ts`, no test framework |
| `npm run build` | `sync:legal`, then the production build into `dist/` |
| `npm run preview` | build, then serve the build locally |
| `npm run check:registry` | the product registry's data invariants (CI runs it; lint and tsc never evaluate them) |
| `npm run check:status` | fails when a static roadmap status is ahead of its repo's `status-*` topic |
| `npm run sync:legal` | copies four Dutch legal pages from `COMPLIANCE_SRC`; with it unset, keeps the committed snapshots |
| `npm run goals:update` | dry run of the goal meters from `GOALS_URL`; `-- --write` writes `content/goals.json` |
| `npm run gen:board-art` | export every PCB as layered SVG and copper rasters (needs KiCad and cwebp) |
| `npm run gen:schematics` | render the schematic sheets from the board checkouts |
| `npm run sync:specs` / `sync:specs:check` | mirror each board README's `## Specifications` table into `content/products/<handle>.json`, or diff |
| `npm run sync:downloads` | diff the latest GitHub release assets against the product JSON (`--check` only; the downloads chapter is not switched on) |
| `npm run sync:timeline` | append releases, new repos and status flips to the timeline ledger |
| `npm run sync:contributors` | refresh `content/contributors.json` from GitHub |
| `npm run studio:coverage` | which files still have copy baked into code |
| `npm run audit:perf`, `audit:lh`, `audit:mobile` | performance lab, Lighthouse, mobile screenshots |
| `node scripts/launch-blast.mjs <handle>` | dry run of the launch mail to the `notify-<handle>` Resend segment; `--create` drafts, `--send` sends |

The PR gate is typecheck, lint and test. `scripts/smoke.mjs` hits the main
routes of any base URL and asserts status and content invariants.

## Layout

```
app/
  root.tsx                 shell, head, Organization JSON-LD
  entry.server.tsx         CSP and security headers
  routes/                  file-based routes
  components/              shared React components
  content/legal/{en,nl,fr} legal Markdown
  lib/                     catalog, i18n, SEO, product content, support bridge, growth
  studio/                  the studio's editor panels
  styles/app.css           the single CSS file (Tailwind v4)
content/                   editable copy, product chapters, posts, theme tokens, goals, votes
public/                    models (GLB), board art, schematics, logos
scripts/                   board art export, hero build, sync and audit scripts
studio/                    the dev-only Vite plugin (the studio's write endpoint)
test/fixtures/catalog.json the catalog contract the mapper tests read
docs/                      the deep dives listed above
```

## How the site works

**Catalog and buying.** `app/lib/catalog.ts` fetches `CATALOG_URL`
server-side with a five minute cache and serves the last good copy for up to
an hour when the fetch fails. The buy button is a form that POSTs `sku`, `qty`
and `next` to `<PUBLIC_SHOP_URL>/incutec/add`; the shop adds the lines to the
visitor's own Odoo cart and redirects there. The stack builder sends both SKUs
as one `lines=A:1,B:1` field. The shop refuses a GET, so a link or crawler
cannot fill a cart. Accounts, orders, invoices and addresses are the Odoo
portal (`/my`, `/my/orders`, `/my/invoices`, `/my/addresses`); `/account/*`
redirects there. Nothing in this repository writes prices, SKUs or stock.

**Product lines.** OpenESC 20x20 / 30x30 and the four OpenRX variants are one
Odoo product with a `Model` attribute; the page renders a tier ladder matched
to the catalog's variants by option name and value.

**Product images** are proxied same-origin at
`/img/odoo/<model>/<id>/<field>?unique=<hash>` (`app/lib/odoo-image.ts`),
cached in the Workers Cache API, with a placeholder only when nothing was
ever cached.

**Status.** What is public and buyable is decided by the `status-*` GitHub
topic on each board repository, resolved per request and cached; the static
fallback in `app/lib/roadmap-data.ts` must lag the topic, never lead it.
`/roadmap`, the product pages, the feeds and the README badge endpoint
`/api/status/<Repo>.json` all read the same resolution. Read
`docs/product-status.md` before touching that chain.

**Product pages** are a sequence of typed chapters (teardown, schematics, open
source, specs, in the box, downloads, firmware, reviews, contributors, prose)
ordered and toggled per product in `content/products/*.json`. The teardown is a
layered SVG of the real PCB exported from KiCad; scrolling peels the copper
layers apart.

**Board art and specs come from the board repositories.** `npm run
gen:board-art` shells out to `kicad-cli` and KiCad's `pcbnew` Python to export
each PCB (`scripts/boards.config.json` maps handles to `.kicad_pcb` paths
relative to the directory holding the board checkouts, `../hardware` by default,
`OPENDRONE_HARDWARE` overrides). `npm run sync:specs` reads each mapped
README's `## Specifications` table (`scripts/repo-sync.config.json`) into the
product JSON. OpenRX stays hand-maintained.

**Homepage hero.** A three.js scene (`app/components/HeroDroneScene.tsx`) plays
the Onshape assembly, exported as one GLB and chunked by
`scripts/hero-assets/build-hero.mjs` into `public/models/<design>/`. It loads
only on desktop with `prefers-reduced-motion: no-preference`; everyone else
gets a static splash, and every beat's copy is plain DOM text. Pipeline and
tuning: `docs/hero-studio.md`.

**Timeline.** `/timeline` combines a curated list in `app/routes/timeline.tsx`
with `timeline-ledger.json` on this repository's unprotected `data` branch,
appended daily by `.github/workflows/timeline-ledger.yml` from releases, new
repos and `status-*` flips across the public OpenDrone-hw repositories.

**Support.** `/support` is a stateless web-to-Discord bridge inside the
Worker: a ticket (form gated by Turnstile) becomes a thread in a Discord forum
channel, staff type in the thread, the browser polls. Ticket identity is a
signed HttpOnly cookie; resume links are HMAC-signed magic links sent through
Resend. Everything from Discord passes an outbound scrubber and an optional
moderation gate; PII goes to a private staff channel. Every ticket and message
is mirrored into Odoo (module `incutec_support`, endpoints
`POST /incutec/support/ticket`, `/ticket/<ref>/message`, `/ticket/<ref>/state`,
`/tickets/search`, header `X-Incutec-Support-Token`), which is the permanent
record, the cross-device lookup index and the only place lifecycle state is
written. Each Odoo call retries once and then logs a warning; an Odoo outage
never blocks the Discord flow. UI in `app/components/Support*.tsx`, server in
`app/lib/support/`, endpoints in `app/routes/api.support.*.tsx`. Two
scheduled workflows call the Worker with `SUPPORT_CLEANUP_SECRET`:
`support-notify.yml` every 15 minutes mails customers the replies they did
not see, `support-cleanup.yml` nightly deletes stale Discord threads and marks
the Odoo ticket `thread_deleted`.

**Newsletter.** Posts are Markdown in `content/posts/` (`published: true` in
the front matter publishes at `/newsletter/<slug>` and in `/newsletter.rss`);
images go in both `content/posts/images/` and `public/posts/`. The footer
signup posts to Odoo (`app/lib/growth/odoo-newsletter.ts`, header
`X-Newsletter-Dispatch-Secret`), single opt-in: Odoo records consent, sends
the welcome mail and owns unsubscribing. Sending an issue happens in Odoo;
publishing a post here mails nobody. `scripts/launch-blast.mjs` is an older,
separate per-product launch mail against a Resend segment.

**Legal.** The legal documents in `app/content/legal/{en,nl,fr}/` serve at
`/{en,nl,fr}/<slug>`; the bare `/<slug>` redirects to the visitor's cached
locale, and `LangToggle` appears only on legal paths. `npm run sync:legal`
(run by `prebuild`) overwrites four Dutch pages only when `COMPLIANCE_SRC`
names a source directory. The site UI is English-only.

**Other routes.** `/products` is the one browse page; `/collections/*`,
`/search`, `/cart/*` and `/discount/*` redirect to it. `/open-source`,
`/production`, `/wholesale`, `/firmware-partners` and `/contact` are content
pages; `/account/support` is the signed-in ticket history. `robots.txt`, `sitemap.xml`,
`security.txt`, `healthz`, `llms.txt` and `products.json` are generated live
from the catalog. `/blog*`, `/releases*`, `/contribute`, `/incutec` are 301
stubs.

## The studio

`npm run dev`, open `/studio`: a local mirror of the site where everything
editable is outlined. Click a string, type, save. No database, no publish
step; `git diff` is the changelog.

| Tab | Edits | Files |
|---|---|---|
| Words | page and product copy | `content/copy/*.json`, `content/products/*.json` |
| Chapters | product page sections: order, titles, on or off | `content/chapters.json` (created on first save) |
| Design | design tokens | `content/theme.json` |
| Media | browse images and where each is used | read-only, `public/` |
| Legal | policy pages in en, nl, fr | `app/content/legal/**` |
| Hero | the 3D scene: lighting, timeline, camera, materials | `public/models/<design>/studio.json` |
| Goals | goal meters and vote tallies | `content/goals.json`, `content/votes.json` |

The studio cannot reach production: the write endpoint is a Vite plugin with
`apply: 'serve'`, `app/routes.ts` excludes the route from the build, and a
build-stage plugin deletes the studio HTML from the output.

Editable copy: create `content/copy/<page>.json` with `$route` and `$title`,
render strings with `<Txt id="<page>.<key>" />` (`app/components/Txt.tsx`) or
`copyText(id)` for attributes. Inline markup is `[label](/path)`, `*emphasis*`
and `**strong**` only. Catalog data is edited in Odoo, synced Dutch legal pages
are read-only, board art comes from KiCad and the hero model from Onshape.

## Theming and i18n

Light and dark through CSS custom properties. Every colour is a semantic token
(`--color-bg`, `--color-text`, `--color-gold`, ...); dark is the default in the
Tailwind `@theme` block, light overrides the same names under `html.light`, and
an inline head script resolves the theme before first paint. Never hardcode a
hex that changes between themes. Brand assets and the one gold literal:
`brand/README.md`. `resolveLegalLoader` in `app/lib/i18n.ts` picks the legal
Markdown by URL prefix and each legal route emits hreflang for en, nl, fr.

## Environment variables

The annotated list is [`.env.example`](.env.example). Groups:

- Required: `SESSION_SECRET`, signs the locale and support cookies.
- Commerce: `PUBLIC_SHOP_URL` and `CATALOG_URL`, both public, both defaulted
  to production; `CATALOG_HTTP_USER` and `CATALOG_HTTP_PASSWORD` for a
  protected catalog origin (the preview Worker's staging catalog).
- Legal entity: `PUBLIC_COMPANY_*`, shown on every page (WER Art. VI.45).
- Launch switch: `PUBLIC_COMING_SOON`.
- Support: Discord bot and channels, Turnstile, Resend, moderation gate,
  `SUPPORT_ODOO_URL` and `SUPPORT_ODOO_TOKEN` for the ticket mirror, and the
  `SUPPORT_LOOKUP_IP_LIMITER` and `SUPPORT_LOOKUP_EMAIL_LIMITER` Workers Rate
  Limiting bindings in `wrangler.production.toml`. All optional.
- Newsletter: `NEWSLETTER_ODOO_URL`, `NEWSLETTER_DISPATCH_SECRET`.
- Goal meter: `GOALS_URL`, the shop's aggregate totals (`GET
  /incutec/goals.json`), read by `goals:update` and the community-sync
  workflow.
- Ops: `SUPPORT_CLEANUP_SECRET`, `COMPLIANCE_SRC`, `GITHUB_STATUS_TOKEN`
  (roadmap API headroom).

`PUBLIC_*` values reach the client bundle; nothing secret does.

## Hosting and deploy

Production (`opendrone.be`, `www.opendrone.be`) is the Cloudflare Worker
`opendrone-web`: `wrangler.production.toml` declares both hostnames as Custom
Domains and points the Worker at `dist/server/index.js` and the static assets
in `dist/client`. `server.ts` redirects `www` to the apex. The `opendrone.be`
zone is on Cloudflare nameservers.

Two workflows, one Worker each:

- `.github/workflows/cloudflare-production.yml`: every push to `main` builds
  and runs `wrangler deploy --config wrangler.production.toml`. A merge to
  `main` is a production deploy.
- `.github/workflows/cloudflare-preview.yml`: every push to
  `feat/cloudflare-hosting` deploys the isolated `opendrone-web-preview`
  Worker (`wrangler.toml`): no custom domains, staging catalog,
  `PUBLIC_COMING_SOON=1`.

Both use the repository secrets `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` and pin wrangler 4, which understands
`custom_domain = true`. `CATALOG_URL` and `PUBLIC_SHOP_URL` are plain `[vars]`
in the wrangler files. Every other runtime value is a Worker secret set with
`npx wrangler secret put <NAME>`, one value per Worker, never committed:
`SESSION_SECRET`, `RESEND_API_KEY`, `SUPPORT_FROM_EMAIL`, the `DISCORD_*` and
`SUPPORT_*` values, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`,
`SUPPORT_ODOO_TOKEN`, `NEWSLETTER_DISPATCH_SECRET`, `SUPPORT_CLEANUP_SECRET`,
`GITHUB_STATUS_TOKEN`.

Other scheduled workflows: `community-sync.yml` (weekly: goal meters when
`GOALS_URL` is set, contributor roster; opens a PR because the numbers are
committed content), `timeline-ledger.yml` (daily, pushes to the `data`
branch), `support-notify.yml`, `support-cleanup.yml`. Dependabot runs weekly,
grouped, no major bumps.

## Security

- Headers (`app/entry.server.tsx`): nonce-based CSP, HSTS with preload,
  `X-Frame-Options: DENY`, nosniff, strict referrer policy, restrictive
  Permissions-Policy, COOP and CORP.
- Rate limits: a per-isolate sliding window on every public POST, plus the
  Workers Rate Limiting bindings on `/api/support/lookup`.
- Input caps on every support field; uploads capped at 5 files, 8 MB each,
  24 MB total, MIME and extension allowlist.
- Support privacy: scrubbed public thread, PII in a private staff channel,
  moderation gate; the poll endpoint is the trust boundary.
- No commerce credentials in this app; the catalog feed is public and
  read-only. `.env` is gitignored. Rotate the session secret, the Discord bot
  token, the Resend key and the Turnstile secret annually or on suspicion.
- Disclosure: GitHub private vulnerability reporting, `/.well-known/security.txt`,
  policy at `/security`, default embargo 90 days.

## Contributing

1. Branch from fresh `main`: `<type>/<topic>` (`feat`, `fix`, `chore`,
   `refactor`, `docs`).
2. Commit with DCO sign-off (`git commit -s`), Conventional Commits, subject
   at most 60 characters.
3. `npm run typecheck && npm run lint && npm test` locally; CI enforces them
   plus build, `check:registry` and `check:status`.
4. `gh pr create`. Maintainers squash-merge; `main` is protected with linear
   history, and a merge is a production deploy.

Rules: no new npm dependency without an issue first; mobile-first (375 px,
enhance at 768 and 1440); WCAG 2.1 AA; bundle additions over 50 KB gzipped
need justification; no `console.log` in production code.

## License

[MIT](LICENSE) for this repository. The hardware lives at
[OpenDrone-hw](https://github.com/OpenDrone-hw) under CERN-OHL-S.
