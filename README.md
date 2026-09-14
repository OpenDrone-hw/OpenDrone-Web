# OpenDrone Web

The storefront at **[opendrone.be](https://opendrone.be)**: open-source FPV drone
hardware, designed and sold from Belgium. Flight controllers (OpenFC), 4-in-1 ESCs
(OpenESC), ExpressLRS receivers (OpenRX), carbon frames (OpenFrame), and the OpenStack
bundle.

Under the hood it is a Shopify store, but not a themed one: a headless
**[Hydrogen](https://hydrogen.shopify.dev/)** app on **Oxygen** (Shopify's Cloudflare
Workers host). Shopify owns the cart, checkout, catalog, and customer accounts. This
repo owns everything the visitor actually looks at, plus a support desk that lives
inside the Worker and a local editing studio that makes the whole site editable
without touching code.

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

Product lines (OpenESC 20×20 / 30×30, the four OpenRX variants) are one Shopify
product with a variant axis. The page renders the line as a tier-card ladder that
doubles as the buy selector, wired to real Shopify variants by option name.

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

### Support: a Discord bridge with no database

`/support` is a live chat with the people who actually design the boards, built as
a **stateless web-to-Discord bridge** inside the Worker. No gateway bot process, no
WebSocket, no application database:

- A customer opens a ticket (form gated by Turnstile). The Worker creates a thread
  in a Discord forum channel. Staff just type in the thread; the browser picks
  replies up by polling every 4 seconds.
- Ticket identity lives in a signed HttpOnly cookie, plus an Upstash Redis index
  for "list my tickets by email" across devices. Resume links are HMAC-signed
  magic links emailed via Resend.
- Everything from Discord passes an outbound scrubber (strips emails, IBANs,
  cards, tokens, bidi tricks; flattens authors to first names) and an optional
  moderation gate (staff replies reach the customer only after a moderator
  reacts ✅). PII goes to a private staff channel, never the public thread.
- A 15-minute cron emails customers the replies they did not see arrive; a
  nightly cron deletes stale threads and index entries.

`/account/support` shows the signed-in ticket history. `/contact` is the front
door with the Discord invite card. UI in `app/components/Support*.tsx`, server in
`app/lib/support/`, endpoints in `app/routes/api.support.*.tsx`.

### Newsletter: written locally, sent by hand

`/newsletter` is the post archive (the Shopify `news` blog) plus a signup form in
the footer of every page. Posts are Markdown files in `content/posts/`, published
with `npm run publish:post` (idempotent by slug, uploads images to Shopify Files).
Sending email is a deliberate manual step in Shopify admin; publishing never
emails anyone.

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

### Account, cart, collections, search

Customer accounts are Shopify's OAuth (login, orders, addresses, profile) via the
Customer Account API. The cart is Hydrogen `CartForm`; the buyer's country is
hard-locked to BE so nobody can switch the cart's market mid-session. Collections
and search are conventional Shopify storefront pages; search lives in a slide-over
drawer with predictive results.

### The invisible pages

`/api/status/<Repo>.json` is a shields.io endpoint badge: the board repo READMEs
render their status badge from it, so the badge, the roadmap and the shop all
resolve the same `status-*` topic. `robots.txt`, a paginated `sitemap.xml` plus a static child sitemap for the
codebase-only routes, RSS feeds, RFC 9116 `security.txt`, `healthz`, and
`llms.txt`: a machine-readable catalog for AI agents, generated live from the
Storefront API so prices and variant IDs can never drift from the shop. Old URLs
(`/blog*`, `/releases*`, `/contribute`, `/incutec`) are 301 stubs.

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

**Not editable, by design**: Shopify data (titles, prices) is edited in Shopify
admin; the synced Dutch legal pages show read-only; board art comes from KiCad and
the hero model from Onshape, so the studio can point at assets but not author them.

---

## How it is built

- **Hydrogen** (Shopify's React Router 7 framework) on **Oxygen** workers
- **React 19** + **TypeScript**, **Tailwind CSS v4** in one file
  (`app/styles/app.css`) plus self-hosted, Latin-subset Inter and JetBrains
  Mono (`app/assets/fonts`, regenerated by `scripts/subset-fonts.sh`)
- **three.js** for the homepage hero
- **Resend** (transactional email), **Upstash Redis** (ticket index),
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
scripts/                   publish-post, board art export, hero build, shopify-infra, smoke
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
cp .env.example .env       # fill in Shopify tokens; see the comments in the file
npm run dev                # http://localhost:3000
```

Sign-in runs through a Hydrogen-managed `*.tryhydrogen.dev` tunnel; plain
localhost cannot complete the OAuth callback, use the tunnel URL the dev server
prints. Without real credentials the loaders fall back to empty states and the
support bridge shows an "unavailable" notice, so a contributor copy still runs.

---

## Environment variables

The complete annotated list is [`.env.example`](.env.example). Groups:

- **Required**: `SESSION_SECRET` plus the six Shopify storefront and customer
  account values. The app does not boot without them.
- **Legal entity**: `PUBLIC_COMPANY_*` (name, address, KBO, VAT, email, phone).
  Belgian law (WER Art. VI.45) requires these on every page.
- **Support bridge**: Discord bot + channels, Turnstile, Resend, Upstash,
  moderation gate. All optional; the bridge degrades gracefully.
- **Publishing**: `SHOPIFY_ADMIN_API_TOKEN` (custom app "OpenDrone Infra") for
  `publish:post`, the `scripts/shopify-infra/` inspectors and SKU sync, and
  the launch, goals and votes scripts.
- **Ops**: `SUPPORT_CLEANUP_SECRET` (cron auth), `COMPLIANCE_SRC` (legal sync
  override), `GITHUB_STATUS_TOKEN` (roadmap API headroom).

`PUBLIC_*` values reach the client bundle; nothing secret does.

---

## Operations

| Command | Purpose |
|---|---|
| `npm run dev` | dev server + codegen + OAuth tunnel |
| `npm run build` | `sync:legal`, then production build |
| `npm run typecheck` / `lint` / `test` | the PR gate; all three must pass |
| `npm run codegen` | regenerate Storefront + Customer Account API types |
| `npm run publish:post -- content/posts/<slug>.md` | publish a blog post (`--dry`, `--draft`) |
| `npm run compose:newsletter <handle>` | branded HTML email from a published post |
| `npm run gen:board-art` | export PCB SVGs + copper-layer rasters (needs KiCad, cwebp) |
| `npm run sync:specs` / `sync:downloads` | mirror README specs / release assets into the product JSON |
| `npm run sync:timeline` | append releases, new repos and status flips to the timeline ledger (CI does this daily on the `data` branch) |
| `npm run studio:coverage` | how much copy is studio-editable |
| `npm run gen:shopify-templates` | branded Shopify notification-email HTML |
| `npm run audit:perf -- --device "Pixel 7" --throttle 6 --network slow4g` | mobile perf lab: frames, long tasks, bytes per interaction (drop `--device` for the desktop lab) |
| `npm run audit:lh -- --form mobile` | Lighthouse vitals per route, mobile or desktop preset |

Tests are plain `node:test` suites next to the code (`app/**/*.test.ts`), no
framework dependency. `scripts/smoke.mjs` hits 25+ routes against any base URL
and asserts status plus content invariants.

**CI and protection**: every PR runs Lint, Typecheck, Test, Build, a registry
invariants check, and a status fallback check (`npm run check:status`: no static
roadmap status may sit ahead of its repo's `status-*` topic); `main` is protected (linear history, no force-push) and every
merge is a squash. **Every push to `main` auto-deploys to opendrone.be** in about
two minutes, so local-only commits do not exist as far as the site is concerned:
push after every commit. Dependabot runs weekly, grouped, no major bumps.

**DNS**: `A @ → 23.227.38.65`, `CNAME www → shops.myshopify.com.` Mail records
live with the email provider; merge SPF changes into the existing TXT, never
replace it.

---

## Security

- **Headers** (`app/entry.server.tsx`): nonce-based CSP, HSTS with preload,
  `X-Frame-Options: DENY`, nosniff, strict referrer policy, a Permissions-Policy
  that denies nearly everything, COOP/CORP.
- **Rate limits**: a per-isolate sliding window on every public POST (support
  endpoints, newsletter, resume). Pair with Cloudflare edge rules for real floods.
- **Input caps**: bounded lengths on every support field; uploads capped at
  5 files / 8 MB each / 24 MB total with a MIME and extension allowlist.
- **Support privacy**: two-channel model (scrubbed public thread, PII in a
  private staff channel), outbound scrubber, moderation gate. The poll endpoint
  is the trust boundary: nothing from Discord reaches the browser except a
  scrubbed projection.
- **Cart**: buyer country hard-locked to BE.
- **Secrets**: `.env` is gitignored and history is clean of token-shaped strings.
  Rotate session secrets, Storefront tokens, the Discord bot token, and the
  Turnstile secret annually or on suspicion.
- **Disclosure**: GitHub private vulnerability reporting is on; contact at
  `/.well-known/security.txt`, policy at `/security`. Default embargo 90 days.

---

## Going live

The storefront is headless: checkout, payments, orders, inventory, and
transactional email all live in Shopify's backend. No order completes until, in
Shopify admin: a payment provider is active (Bancontact is essential in Belgium),
shipping zones and rates exist, and VAT settings are confirmed
(`taxesIncluded=true` is already on). Then point the Customer Account API
callback URLs at the production domain, set real prices on the remaining SKUs,
paste in the generated notification-email templates, and place one real
low-value order end to end.

Compliance details (GPSR, withdrawal, battery shipping): `docs/store-compliance.md`.

---

## Contributing

1. Branch from fresh `main`: `<type>/<topic>` (`feat`, `fix`, `chore`,
   `refactor`, `docs`).
2. Commit with DCO sign-off (`git commit -s`), Conventional Commits, subject
   ≤60 chars.
3. `npm run typecheck && npm run lint && npm test` locally; CI enforces them.
4. `gh pr create`: CI plus an Oxygen preview URL run automatically. Maintainers
   squash-merge; a merge is a production deploy.

Rules: no new npm dependencies without an issue first; mobile-first (375px,
enhance at 768/1440); WCAG 2.1 AA; bundle additions over 50 KB gzipped need
justification; no `console.log` in production code.

## License

[MIT](LICENSE) for this repo. The hardware lives at
[OpenDrone-hw](https://github.com/OpenDrone-hw) under CERN-OHL-S.
