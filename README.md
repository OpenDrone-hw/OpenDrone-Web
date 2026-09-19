# OpenDrone Web

The storefront at **[opendrone.be](https://opendrone.be)**: open-source FPV drone
hardware, designed and sold from Belgium. Flight controllers (OpenFC), 4-in-1 ESCs
(OpenESC), ExpressLRS receivers (OpenRX), carbon frames (OpenFrame), and the OpenStack
bundle.

Under the hood it is a headless **[Hydrogen](https://hydrogen.shopify.dev/)**
app deployed as a **Cloudflare Worker**. The commerce backend is
**Odoo**, at [shop.incutec.com](https://shop.incutec.com): it owns the catalog,
prices, availability, cart, checkout, payment, orders, invoices, addresses and
customer accounts. This repo reads one public catalog JSON from it, hands every
buy click to it, and owns everything else the visitor looks at, plus a support
desk that lives inside the Worker and a local editing studio that makes the
whole site editable without touching code.

Hydrogen's Vite toolchain is build tooling only; nothing in `app/` calls a
Shopify API at runtime.

Selling entity is **Incutec BV**; OpenDrone is the community project and product
brand. This storefront is MIT; the hardware repos are CERN-OHL-S.

This README is the single source of truth for the project. There are no other docs to
chase, apart from three deep dives in `docs/` (hero pipeline, growth architecture,
store compliance).

---

## Contents

- [The site, page by page](#the-site-page-by-page)
- [The studio](#the-studio)
- [How it is built](#how-it-is-built)
- [Run it locally](#run-it-locally)
- [Environment variables](#environment-variables)
- [Operations](#operations)
- [Security](#security)
- [Hosting](#hosting)
- [Going live](#going-live)
- [Contributing](#contributing)
- [License](#license)

---

## The site, page by page

### Homepage: the assembling drone

`/` opens on a wordmark splash while a 3" drone streams in behind it, piece by piece.
The model is the real Onshape CAD assembly, exported as one GLB and split into chunks
(frame, FC, ESC, RX, motors) so the drone visibly builds up as parts arrive: the
assembly itself is the loading indicator.

Then you scroll. Each scroll snaps to the next beat of a guided tour: the whole
drone, then the flight controller, the ESC, the receiver lineup, motor and
propeller, and finally the airframe, each with a short pitch and a camera move.
The teardown choreography (what flies apart when) lives in code; everything
tunable (lighting, materials, camera paths, timing) lives in
`public/models/od3/studio.json`, written by the hero tab of the studio.

The scene is plain three.js inside `app/components/HeroDroneScene.tsx`. It loads
only on desktop with `prefers-reduced-motion: no-preference`; everyone else gets a
static splash. Every beat's copy is also plain DOM text, so search engines and
screen readers see the whole story without WebGL.

How the model gets from Onshape to the site: `docs/hero-studio.md`.

### Product pages: editorial, not template

`/products/<handle>` reads like a magazine feature about the board, not a spec
dump with an add-to-cart button. A page is a sequence of typed chapters, ordered
and toggled by data (`content/products/*.json`):

- **Teardown**: a layered SVG of the actual PCB, exported from KiCad. Scrolling
  peels the copper layers apart; numbered pins call out the key parts; a toggle
  flips to the back side, and a KiCanvas link opens the real board files.
- **Schematics**: the board's schematic sheets, rendered from the same hardware repo.
- **Open source**: live cards showing the latest commit on the board's GitHub repo.
- **Specs**: written for buyers, not copied from the BOM.
- **In the box, Downloads, Firmware, Reviews, Contributors**: what they say on the tin.
- **Prose**: the escape hatch chapter type whose whole content comes from the copy
  store, for when a page just needs a few extra paragraphs.

Product lines (OpenESC 20×20 / 30×30, the four OpenRX variants) are one Odoo
product with a `Model` attribute. The page renders the line as a tier-card ladder
that doubles as the buy selector, matched to the catalog's variants by option
name and value.

### Roadmap: status straight from GitHub

`/roadmap` is the product board: every project with one of five statuses
(launched / beta / alpha / in progress / planned). Status is not prose anyone can
forget to update: the loader pulls the `status-*` topic from each product's GitHub
repo at request time (cached one hour), so the board mirrors the repos. The page
also carries the how-to-help section that used to live at `/contribute`.

### Timeline: milestones with receipts

`/timeline` lists every milestone of the project with a link to the evidence:
first commits, fab orders, bench validations, upstream merges. No claims without
receipts. Two sources: a curated list in `app/routes/timeline.tsx` for the
things only a human knows (bench results, samples ordered, videos), and the
timeline ledger for everything GitHub can prove on its own: releases, repos
appearing, and `status-*` topic flips across the public OpenDrone-hw repos.
The ledger is `timeline-ledger.json` on this repo's unprotected `data` branch,
appended daily by `.github/workflows/timeline-ledger.yml`
(`scripts/sync-timeline.mjs`) and read live by the page, so a tag cut on a
board is on the timeline the next day with nobody editing anything.

### Open source: why, and who pays

`/open-source` explains the split: OpenDrone is the community project, Incutec is
the Belgian startup that hosts the site, sells the boards, and does what a
community cannot (fabrication runs, certification, warranty). `/incutec` 301s here.

### Production

`/production` walks the manufacturing chain: designed in the open, fabricated and
assembled in China, then inspected, flashed, and shipped by Incutec from Belgium,
with the EU-assembly path as the stated next step.

### Support: a Discord bridge, Odoo-backed

`/support` is a live chat with the people who actually design the boards, built as
a **stateless web-to-Discord bridge** inside the Worker. No gateway bot process, no
WebSocket, no application database of its own - ticket state and lookup are Odoo's:

- A customer opens a ticket (form gated by Turnstile). The Worker creates a thread
  in a Discord forum channel. Staff just type in the thread; the browser picks
  replies up by polling every 4 seconds.
- Ticket identity lives in a signed HttpOnly cookie. "List my tickets by
  email" across devices, and every other lookup, resolves live against
  Odoo (`erp/addons/incutec_support` - see below), which replaced an
  Upstash Redis KV index this app used to keep for the same purpose
  (founder decision, 2026-09-15). Resume links are HMAC-signed magic
  links emailed via Resend.
- Everything from Discord passes an outbound scrubber (strips emails, IBANs,
  cards, tokens, bidi tricks; flattens authors to first names) and an optional
  moderation gate (staff replies reach the customer only after a moderator
  reacts ✅). PII goes to a private staff channel, never the public thread.
- A 15-minute cron emails customers the replies they did not see arrive; a
  nightly cron deletes stale Discord threads and marks the matching Odoo
  ticket `thread_deleted` so it drops out of future lookups.
- Every ticket, and every message either side sends, is best-effort
  mirrored into Odoo `project.task` (`erp/addons/incutec_support`, erp
  PLAN.md step 12.2/12.7) - that task, with its full mirrored chatter, is
  also this app's permanent record once a Discord thread is gone, and the
  only place lifecycle state (closed, feedback, seen/notify cursors) is
  written: `app/lib/support/odoo.ts` calls `POST /incutec/support/ticket`
  when the Discord thread is created (`app/routes/api.support.start.tsx`),
  `POST /incutec/support/ticket/<ref>/message` for each message either
  side sends, `POST /incutec/support/ticket/<ref>/state` to close a
  ticket, advance a cursor, or record feedback, and `POST
  /incutec/support/tickets/search` to look tickets up by thread id or
  email - all authenticated with `X-Incutec-Support-Token`. The returned
  `ticket_ref` (e.g. `SUP-00001`) is appended to the resume-link
  confirmation email the visitor already gets. Every Odoo call retries
  once and then just logs a warning: an Odoo outage never blocks or
  changes the Discord flow, degrading to "the customer's own device
  cookie still works; cross-device lookup and staff-side ERP visibility
  don't" - see `erp/addons/incutec_support/README.md` for the bridge
  contract.

`/account/support` shows the signed-in ticket history. `/contact` is the front
door with the Discord invite card. UI in `app/components/Support*.tsx`, server in
`app/lib/support/`, endpoints in `app/routes/api.support.*.tsx`.

### Newsletter: written locally, sent by hand

`/newsletter` is the post archive plus a signup form in the footer of every
page. Posts are Markdown files in `content/posts/`, rendered by the app the way
the legal pages are (`app/lib/posts.ts`): set `published: true` in the front
matter, commit, and the post is live at `/newsletter/<slug>` and in
`/newsletter.rss`. Images are authored in `content/posts/images/` and served
from `public/posts/`; add each one to both. The signup form starts a double
opt-in subscription on Odoo's "Newsletter" `mailing.list`
(`app/lib/growth/odoo-newsletter.ts`; erp PLAN.md 13.11): Odoo mails the
confirmation link and owns unsubscribing (its own mailing link). Sending an
actual issue is a manual step done from Odoo, outside this repository;
publishing a post here never emails anyone. `scripts/launch-blast.mjs`
is a separate, older per-product "notify me at launch" blast against a
Resend segment, unrelated to the Newsletter list above.

### Wholesale and firmware partners

`/wholesale`: dealer terms on request. `/firmware-partners`: the boards ship on
Betaflight, AM32, and ExpressLRS, and Incutec forwards €1 of every board sold to
the upstream maintainers; the page lists them.

### Legal: trilingual and synced

Nine legal documents (terms, privacy, cookies, withdrawal, shipping, warranty,
vulnerability handling, end-use, e-invoicing) each serve at `/{en,nl,fr}/<slug>`, with the bare
`/<slug>` redirecting to the visitor's cached locale. Content is Markdown in
`app/content/legal/{en,nl,fr}/` and is authored in-repo. `npm run sync:legal`
(run by `prebuild`) overwrites four Dutch pages from a directory named by
`COMPLIANCE_SRC`; with the variable unset, which is the committed state, it
keeps the snapshots. The site UI itself is English-only; `LangToggle` appears
only on legal paths.

### Account, cart, products

None of these live here. The buy button is a form that POSTs `sku`, `qty` and
`next` to `https://shop.incutec.com/incutec/add`, which adds the lines to the
visitor's own Odoo cart and redirects them to it; the stack builder sends both
SKUs as one `lines=A:1,B:1` field. The shop refuses a GET, so a plain link or a
crawler cannot fill a cart. Accounts, orders, invoices and
addresses are the Odoo portal (`/my`, `/my/orders`, `/my/invoices`,
`/my/addresses`), and `/account/*` 301s there.

`/products` is the one browse page: every product and every model as its own
card, filtered and sorted client-side from the URL, with a text filter in place
of the old predictive search. `/collections/*`, `/search`, `/cart/*` and
`/discount/*` all 301 to it.

### The invisible pages

`/api/status/<Repo>.json` is a shields.io endpoint badge: the board repo READMEs
render their status badge from it, so the badge, the roadmap and the shop all
resolve the same `status-*` topic. `robots.txt`, one `sitemap.xml` listing the
static routes plus a line per catalog product, RSS feeds, RFC 9116
`security.txt`, `healthz`, and `llms.txt`: a machine-readable catalog for AI
agents, generated live from the Odoo catalog so prices, SKUs and order links
can never drift from the shop. `products.json` is the same data as JSON, with a
ready-made `cart_add_url` per variant. Old URLs (`/blog*`, `/releases*`,
`/contribute`, `/incutec`) are 301 stubs.

---

## The studio

Run `npm run dev` and open **`/studio`**: a local mirror of the site where
everything editable is outlined. Click a string on the real page, type, save. No
database, no publish step; `git diff` is the changelog and `git checkout` is undo.

| Tab | Edits | Files |
|---|---|---|
| Words | Page copy, product copy | `content/copy/*.json`, `content/products/*.json` |
| Chapters | Product page sections: order, titles, on/off | `content/chapters.json` |
| Design | The design tokens | `content/theme.json` |
| Media | Browse images, see where each is used | read-only, `public/` |
| Legal | Policy pages in en, nl, fr | `app/content/legal/**` |
| Hero | The 3D scene: lighting, timeline, camera, materials | `public/models/<design>/studio.json` |

The studio cannot reach production, by construction rather than promise: the write
endpoint is a Vite plugin with `apply: 'serve'` (it does not exist in a build),
`app/routes.ts` excludes the route from the build, and a build-stage plugin
deletes the studio HTML from the output.

**Adding editable copy**: create `content/copy/<page>.json` with `$route` and
`$title`, render strings with `<Txt id="<page>.<key>" />`
(`app/components/Txt.tsx`), or `copyText(id)` for attributes. Inline markup is
deliberately tiny: `[label](/path)`, `*emphasis*`, `**strong**`, and that is all.
`npm run studio:coverage` reports which files still have words baked into code.

**Not editable, by design**: catalog data (titles, prices, availability) is
edited in Odoo; the synced Dutch legal pages show read-only; board art comes from
KiCad and the hero model from Onshape, so the studio can point at assets but not
author them.

---

## How it is built

- **Hydrogen** (Shopify's React Router 7 framework), built with its Vite
  toolchain and deployed as a **Cloudflare Worker**
- **Odoo** at shop.incutec.com for catalog, cart, checkout, orders and accounts,
  read through one public JSON feed (`app/lib/catalog.ts`)
- **React 19** + **TypeScript**, **Tailwind CSS v4** in one file
  (`app/styles/app.css`) plus self-hosted, Latin-subset Inter and JetBrains
  Mono (`app/assets/fonts`, regenerated by `scripts/subset-fonts.sh`)
- **three.js** for the homepage hero
- **Resend** (transactional email), **Odoo** (ticket state and lookup),
  **Plausible** (cookieless analytics)

```
app/
  root.tsx                 shell, head, Organization JSON-LD
  entry.server.tsx         CSP + security headers
  routes/                  85 file-based routes
  components/              shared React components
  content/legal/{en,nl,fr} legal markdown
  lib/                     i18n, SEO, product content, support bridge, chapters
  studio/                  the studio's editor panels
  styles/app.css           the single CSS file
content/                   editable copy, product chapters, posts, theme tokens
public/                    models (GLB), board art SVGs + rasters, schematics, logos
scripts/                   board art export, hero build, goals, launch blast, smoke
test/fixtures/             catalog.json, the contract document the mapper tests read
studio/                    the dev-only Vite plugin (write endpoint)
docs/                      hero-studio, growth-architecture, store-compliance
```

**Board art pipeline**: `npm run gen:board-art` shells out to `kicad-cli` and
KiCad's `pcbnew` Python to export each PCB as a layered SVG, clipped to the true
board outline, with a mirrored back side. It then renders every copper layer to
lossless WebP with headless Chromium and writes `board-lite.svg`, the same
layer structure with the copper as `<image>` sheets: that is what the product
page stacks (six vector layers of vias stuttered on phones), with the full
`board.svg` kept for the fallback and for inspection. `front-w*.webp` thumbnails
for the mobile home and roadmap come from the same run; rasters and thumbnails
alone: `--rasters-only`, `--derivatives-only`. `scripts/boards.config.json` maps
handles to `.kicad_pcb` paths relative to the container that holds the board
checkouts (`../hardware`; `OPENDRONE_HARDWARE` overrides it).

**Repo-to-site mirror**: the board repos are the source of truth for specs and
release assets, the site is a maintained mirror. `npm run sync:specs` reads the
`## Specifications` table of each mapped README (`scripts/repo-sync.config.json`,
same root and override as above) into `content/products/<handle>.json`;
`--check` diffs. `npm run sync:downloads` is the same for the latest GitHub
release assets, prepared but not switched on: the downloads chapter stays empty
until it is wanted, so nobody runs its `--write`. OpenRX stays hand-maintained.
Both run at release step 9 alongside the art commands and land as a normal PR.

**Hero pipeline**: Onshape assembly → GLB export → `scripts/hero-assets/build-hero.mjs`
(meshopt, chunk split) → `public/models/<design>/` → tuned in the studio's hero
tab → played by `HeroDroneScene`. Full story in `docs/hero-studio.md`.

**Theming**: light and dark via CSS custom properties. Every color is a semantic
token (`--color-bg`, `--color-text`, `--color-gold`, ...). Dark is the default in
the Tailwind `@theme` block; light overrides the same names under `html.light`.
An inline head script resolves the theme before first paint. Never hardcode a hex
that should change between themes.

**i18n**: `resolveLegalLoader` in `app/lib/i18n.ts` picks the Markdown snapshot by
URL prefix; each legal route emits hreflang for en/nl/fr.

---

## Run it locally

```sh
git clone https://github.com/OpenDrone-hw/OpenDrone-Web.git
cd OpenDrone-Web
npm install
cp .env.example .env       # SESSION_SECRET is the only required value
npm run dev                # http://localhost:3000
```

`CATALOG_URL` and `PUBLIC_SHOP_URL` default to production, so a fresh clone
shows the real catalog with real prices and working buy links. Set
`PUBLIC_COMING_SOON=0` to see prices before the shop opens. Without the support
and email credentials the bridge shows an "unavailable" notice, so a
contributor copy still runs.

---

## Environment variables

The complete annotated list is [`.env.example`](.env.example). Groups:

- **Required**: `SESSION_SECRET`. It is the only value the app will not boot
  without; it signs the locale and support-desk cookies.
- **Commerce backend**: `PUBLIC_SHOP_URL` (default
  `https://shop.incutec.com`) and `CATALOG_URL` (default
  `https://erp.incutec.com/incutec/catalog.json`). Both optional, both
  defaulted to production.
- **Legal entity**: `PUBLIC_COMPANY_*` (name, address, KBO, VAT, email, phone).
  Belgian law (WER Art. VI.45) requires these on every page.
- **Support bridge**: Discord bot + channels, Turnstile, Resend,
  moderation gate, the Odoo ticket mirror/state/lookup
  (`SUPPORT_ODOO_URL`, `SUPPORT_ODOO_TOKEN`), and the
  `SUPPORT_LOOKUP_IP_LIMITER`/`SUPPORT_LOOKUP_EMAIL_LIMITER` Workers Rate
  Limiting bindings (`wrangler.production.toml`, not env vars). All
  optional; the bridge degrades gracefully.
- **Goal meter**: `GOALS_URL`, the shop's aggregate order totals for
  `goals:update`. The Odoo endpoint is not built yet (ERP `PLAN.md` step 12.6);
  unset, the script reports that and writes nothing.
- **Ops**: `SUPPORT_CLEANUP_SECRET` (cron auth), `COMPLIANCE_SRC` (legal sync
  override), `GITHUB_STATUS_TOKEN` (roadmap API headroom).

`PUBLIC_*` values reach the client bundle; nothing secret does.

---

## Operations

| Command | Purpose |
|---|---|
| `npm run dev` | dev server |
| `npm run build` | `sync:legal`, then production build |
| `npm run typecheck` / `lint` / `test` | the PR gate; all three must pass |
| `npm run goals:update` | move the auto-mode goal meters from the shop's aggregate totals (`--write`) |
| `npm run gen:board-art` | export PCB SVGs + copper-layer rasters (needs KiCad, cwebp) |
| `npm run sync:specs` / `sync:downloads` | mirror README specs / release assets into the product JSON |
| `npm run sync:timeline` | append releases, new repos and status flips to the timeline ledger (CI does this daily on the `data` branch) |
| `node scripts/launch-blast.mjs <handle>` | dry run of the launch email to the `notify-<handle>` Resend segment (`--create` drafts it, `--send` sends) |
| `npm run studio:coverage` | how much copy is studio-editable |
| `npm run audit:perf -- --device "Pixel 7" --throttle 6 --network slow4g` | mobile perf lab: frames, long tasks, bytes per interaction (drop `--device` for the desktop lab) |
| `npm run audit:lh -- --form mobile` | Lighthouse vitals per route, mobile or desktop preset |

Products, prices, SKUs and stock are Odoo's, edited in the Odoo backend and
published through `GET /incutec/catalog.json`. Nothing in this repository writes
them, and no command here can.

Tests are plain `node:test` suites next to the code (`app/**/*.test.ts`), no
framework dependency. `scripts/smoke.mjs` hits 26 routes against any base URL
and asserts status plus content invariants, including that the PDP carries the
`/incutec/add` hand-off.

**CI and protection**: every PR runs Lint, Typecheck, Test, Build, a registry
invariants check, and a status fallback check (`npm run check:status`: no static
roadmap status may sit ahead of its repo's `status-*` topic); `main` is protected (linear history, no force-push) and every
merge is a squash. **Every push to `main` auto-deploys to opendrone.be** in about
two minutes, so local-only commits do not exist as far as the site is concerned:
push after every commit. Dependabot runs weekly, grouped, no major bumps.

**DNS**: `opendrone.be` is proxied through Cloudflare, apex and `www` served
by the Worker's Custom Domains (see `## Hosting`). Mail records live with the
email provider; merge SPF changes into the existing TXT, never replace it.

---

## Security

- **Headers** (`app/entry.server.tsx`): nonce-based CSP, HSTS with preload,
  `X-Frame-Options: DENY`, nosniff, strict referrer policy, a Permissions-Policy
  that denies nearly everything, COOP/CORP.
- **Product images** (`app/lib/odoo-image.ts`): catalog images are served
  same-origin from `/img/odoo/<model>/<id>/<field>?unique=<hash>`, not
  hot-linked from Odoo. Only `product.template`, `product.product` and
  `product.image` with `image_1920`/`1024`/`512`/`256`/`128` are proxied.
  Responses sit in the Workers Cache API keyed by the hash; when Odoo is
  unreachable a cached or last known image is served, and a neutral
  `no-store` placeholder only if none was ever cached. Each isolate warms the
  cache for every catalog image at most every 30 minutes. The upstream Basic
  auth (`CATALOG_HTTP_USER`/`CATALOG_HTTP_PASSWORD`) never reaches the browser.
- **Rate limits**: a per-isolate sliding window on every public POST (support
  endpoints, newsletter, resume). Pair with Cloudflare edge rules for real floods.
- **Input caps**: bounded lengths on every support field; uploads capped at
  5 files / 8 MB each / 24 MB total with a MIME and extension allowlist.
- **Support privacy**: two-channel model (scrubbed public thread, PII in a
  private staff channel), outbound scrubber, moderation gate. The poll endpoint
  is the trust boundary: nothing from Discord reaches the browser except a
  scrubbed projection.
- **Cart**: not here. The hand-off is a GET that only touches the caller's own
  Odoo session and can only redirect within the shop.
- **Secrets**: `.env` is gitignored and history is clean of token-shaped
  strings. This app holds no commerce credentials at all; the catalog feed is
  public and read-only. Rotate the session secret, the Discord bot token, the
  Resend key and the Turnstile secret annually or on suspicion.
- **Disclosure**: GitHub private vulnerability reporting is on; contact at
  `/.well-known/security.txt`, policy at `/security`. Default embargo 90 days.

---

## Hosting

Production (`opendrone.be`, `www.opendrone.be`) runs on the Cloudflare
Worker `opendrone-web`, deployed to those two hostnames as Custom Domains.
`npm run build` (Hydrogen's Vite toolchain) emits a plain workerd ES module
at `dist/server/index.js` with a standard `fetch(request, env, ctx)` export;
`wrangler.production.toml` points the Worker at that build output and its
static assets (`dist/client`). `server.ts` 301s `www.opendrone.be` to the
apex, since a Cloudflare custom domain would otherwise serve `www` as a
silent mirror. Gandi is the domain registrar; it no longer serves the zone's
DNS (see DNS below).

**Deploy:** two workflows, one Worker each, so a preview deploy can never
touch production DNS or state:

- `.github/workflows/cloudflare-production.yml` runs `wrangler deploy
  --config wrangler.production.toml` on every push to `main`: the real
  `opendrone-web` Worker with the `opendrone.be`/`www.opendrone.be` custom
  domains and the `[[ratelimits]]` bindings below.
- `.github/workflows/cloudflare-preview.yml` runs `wrangler deploy --config
  wrangler.toml` on every push to `feat/cloudflare-hosting`: an isolated
  `opendrone-web-preview` Worker with no custom-domain routes, pointed at the
  staging catalog with `PUBLIC_COMING_SOON=1`, so a hosting change in flight
  gets a live URL without touching opendrone.be.

Both use repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
(same account as `../site`, see `../../operations/INTEGRATIONS.md`) and pin
`wranglerVersion: "4"`: wrangler 3.x doesn't understand `custom_domain = true`
in `wrangler.production.toml`'s `routes` and falls back to the deprecated
zone-level Workers Routes API, which needs a separate token permission from
the account-level Custom Domains API wrangler 4 uses.

`CATALOG_URL` and `PUBLIC_SHOP_URL` are set as plain `[vars]` per environment
in `wrangler.production.toml` / `wrangler.toml` (public values, already the
app's defaults). Everything else is a Worker secret, set with `npx wrangler
secret put <NAME>` and not in the repo. Names only:

- `SESSION_SECRET`: its own random value per environment.
- `RESEND_API_KEY`: the incutec Resend team's `opendrone-web` key, copy in
  `../../operations/.env` as `OPENDRONE_RESEND_API_KEY`. Full access, not
  sending-only: `app/lib/growth/resend.ts` also manages contacts, segments
  and broadcasts.
- `SUPPORT_FROM_EMAIL`, `DISCORD_BOT_TOKEN`, `DISCORD_SUPPORT_CHANNEL_ID`,
  `DISCORD_GUILD_ID`, `DISCORD_STAFF_METADATA_CHANNEL_ID`,
  `DISCORD_FEEDBACK_CHANNEL_ID`, `SUPPORT_MOD_ROLE_ID`,
  `SUPPORT_MODERATION_MODE`, `DISCORD_SUPPORT_INVITE`,
  `PUBLIC_DISCORD_GUILD_ID`, `PUBLIC_DISCORD_INVITE`, `TURNSTILE_SITE_KEY`,
  `TURNSTILE_SECRET_KEY`, `SUPPORT_SESSION_SECRET`.
- `SUPPORT_ODOO_TOKEN`: shared secret for the `incutec_support` bridge
  (`X-Incutec-Support-Token`); must match system parameter
  `incutec_support.bridge_token` on the Odoo instance it targets.
  `SUPPORT_ODOO_URL` is optional, defaults to `https://erp.incutec.eu`.
- `NEWSLETTER_DISPATCH_SECRET`, `SUPPORT_CLEANUP_SECRET`.

`/api/support/lookup`'s rate limiting is a Cloudflare Workers Rate Limiting
binding (`[[ratelimits]]` in `wrangler.production.toml`), not a secret.

**DNS:** the `opendrone.be` zone's nameservers
(`dahlia.ns.cloudflare.com`, `henry.ns.cloudflare.com`) are set at Gandi; the
apex and `www` resolve through the Worker's Custom Domains. Manage any other
record on the zone with `python3 ../../operations/tools/cloudflare_dns.py`.
The Resend domain `opendrone.be` (region `eu-west-1`) is verified in the
incutec Resend team, the same team Odoo sends through; its
`resend._domainkey` TXT record lives on the Cloudflare zone. Anything that
sends as opendrone.be uses `OPENDRONE_RESEND_API_KEY` from
`../../operations/.env`.

---

## Going live

Checkout, payments, orders, inventory, invoicing and the order mails live in
Odoo at shop.incutec.com. What that side needs is tracked in the ERP
repository's `PLAN.md`, not here; from the storefront's point of view the shop
is ready when `GET https://erp.incutec.com/incutec/catalog.json` lists every
product with its prices, availability and ship promises.

Environment variables for each Worker environment are the `[vars]` and
secrets described in `## Hosting` above; see `## Environment variables` for
the full annotated list. `SUPPORT_ODOO_URL` defaults to
`https://erp.incutec.eu` in production; point a preview at
`https://staging.incutec.eu`. Without `SUPPORT_ODOO_TOKEN` the Odoo ticket
mirror silently no-ops; the Discord bridge is unaffected either way.

**What still depends on Shopify:** nothing at runtime. `@shopify/hydrogen` and
`@shopify/mini-oxygen` are build/dev dependencies only (`cdn.shopify.com`
still serves this app's own JS bundles, which is why it stays in the CSP);
no page, loader or action calls a Shopify API.

The launch model on the storefront side:

- `PUBLIC_COMING_SOON=0` opens the shop. Until then every product renders as
  coming soon (no price, notify-me signup) unless its roadmap topic says
  otherwise.
- Odoo's per-variant `availability` decides who is orderable once the shop is
  open: `in_stock` and `preorder` are buyable, `sold_out` shows the sold-out
  state. A `status` of `idea` or `development` in
  `content/products/<handle>.json` still wins over it, because that is the
  storefront saying a product is not for sale at all.
- The ship promise on a pre-order comes from Odoo (`ship_promise`, set per
  product and frozen onto the order line there), falling back to `statusNote`
  in the content file and then to `product-chrome.preorder_lead_default`. The
  same words appear on the PDP, in the Odoo cart and on the order.
- One-parcel rule: an order that mixes in-stock and pre-order lines ships as
  one parcel once every line is on hand. The PDP, the Odoo order confirmation
  and the shipping policy say so; the operator holds the order until then.

Before launch, walk one order end to end on the preview Worker: PDP, buy
click, Odoo cart, checkout, test payment, order mail, portal link.

Compliance details (GPSR, withdrawal, pre-orders, battery shipping):
`docs/store-compliance.md`.

---

## Contributing

1. Branch from fresh `main`: `<type>/<topic>` (`feat`, `fix`, `chore`,
   `refactor`, `docs`).
2. Commit with DCO sign-off (`git commit -s`), Conventional Commits, subject
   ≤60 chars.
3. `npm run typecheck && npm run lint && npm test` locally; CI enforces them.
4. `gh pr create`: CI (lint, typecheck, test, build, registry and status
   checks) runs automatically. Maintainers squash-merge; a merge to `main`
   is a production deploy.

Rules: no new npm dependencies without an issue first; mobile-first (375px,
enhance at 768/1440); WCAG 2.1 AA; bundle additions over 50 KB gzipped need
justification; no `console.log` in production code.

## License

[MIT](LICENSE) for this repo. The hardware lives at
[OpenDrone-hw](https://github.com/OpenDrone-hw) under CERN-OHL-S.
