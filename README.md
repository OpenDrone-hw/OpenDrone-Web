# OpenDrone Web

The storefront at [opendrone.be](https://opendrone.be): open-source FPV drone
hardware designed and sold from Belgium. Flight controllers (OpenFC), 4-in-1
ESCs (OpenESC), ExpressLRS receivers (OpenRX), carbon frames (OpenFrame) and
the OpenStack bundle.

It is a React Router 7 app, built with the Cloudflare Vite plugin, that runs as a Cloudflare Worker. The public catalog comes from Shopify. The storefront is intentionally closed: product pages show coming-soon states, checkout writes are disabled, and old cart sessions cannot redirect to checkout. Shopify also owns newsletter consent and unsubscribe state. Support is the public Discord invite and company email; the retired ticket APIs return `410`.

Selling entity: Incutec BV. OpenDrone is the community project and product
brand. This repository is MIT; the hardware repositories are CERN-OHL-S.

Deep dives in `docs/`: `product-status.md` (the status system that decides
what is public and buyable), `hero-studio.md` (the homepage 3D pipeline),
`growth-architecture.md` (analytics, attribution, mail), `store-compliance.md`
(implementation acceptance and evidence ownership).

## Run it locally

```sh
git clone https://github.com/OpenDrone-hw/OpenDrone-Web.git
cd OpenDrone-Web
npm install
cp .env.example .env       # SESSION_SECRET is the only required value
npm run dev                # http://localhost:3000
```

For a Shopify-backed local run, set the `SHOPIFY_*` values described in `.env.example`. Keep `PUBLIC_COMING_SOON=1` and leave `SHOPIFY_CHECKOUT_WRITE_ENABLED` unset or `0`. The app fails closed when catalog policy or tax configuration is missing.

Node 22 (what CI uses).

## Commands

| Command | Does |
|---|---|
| `npm run dev` | dev server (server.ts in workerd) with the studio at `/studio` |
| `npm run typecheck` | `react-router typegen` then `tsc --noEmit` |
| `npm run lint` | ESLint over the repository |
| `npm test` | `node --test` over `app/**/*.test.ts`, no test framework |
| `npm run build` | `sync:legal`, then the production build into `dist/` |
| `npm run preview` | build, then serve `dist/` locally with `wrangler dev` and the production Worker config |
| `npm run check:registry` | the product registry's data invariants (CI runs it; lint and tsc never evaluate them) |
| `npm run check:status` | fails when a static roadmap status is ahead of its repo's `status-*` topic |
| `npm run sync:legal` | copies four Dutch legal pages from `COMPLIANCE_SRC`; with it unset, keeps the committed snapshots |
| `npm run gen:board-art` | export every PCB as layered SVG and copper rasters (needs KiCad and cwebp) |
| `npm run gen:schematics` | render the schematic sheets from the board checkouts |
| `npm run sync:specs` / `sync:specs:check` | mirror each board README's `## Specifications` table into `content/products/<handle>.json`, or diff |
| `npm run specs:placeholders` | list every spec value still marked as a placeholder |
| `npm run sync:downloads` | diff the latest GitHub release assets against the product JSON (`--check` only; the downloads chapter is not switched on) |
| `npm run sync:timeline` | append releases, new repos and status flips to the timeline ledger |
| `npm run sync:contributors` | refresh `content/contributors.json` from GitHub |
| `npm run studio:coverage` | which files still have copy baked into code |
| `npm run audit:perf`, `audit:lh`, `audit:mobile` | performance lab, Lighthouse, mobile screenshots |
| `npm run gen:shopify-templates` | render the Shopify notification emails from `scripts/shopify-templates/` into `out/`, ready to paste into Shopify |
| `node scripts/launch-preorders.mjs` | dry run of the preorder launch: read-only checks and the plan; `--apply` performs it (see "Launch preorders") |
| `node --experimental-strip-types scripts/release-batch.mjs --sku <SKU>` | dry run: the held orders of a batch; `--apply` releases their holds (see "Fulfil a batch") |
| `node --experimental-strip-types scripts/preorder-notify.mjs --kind moved\|missed --sku <SKU> --new-date <text>` | dry run: renders the ship-date or missed-target email per order; `--send` sends through Resend (see "Tell buyers") |
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
  lib/                     catalog, i18n, SEO, product content, growth
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

**Catalog and buying.** `app/lib/shopify-storefront.ts` reads the Shopify Storefront API into the repository's existing catalog shape. Every SKU requires an explicit policy entry; production entries are `sold_out` with no ship promise. `PUBLIC_COMING_SOON=1`, `SHOPIFY_CHECKOUT_WRITE_ENABLED=0`, and the cart loader's `410` response keep checkout closed. Customer-account links stay hidden unless an exact verified Shopify account URL is configured.

**Preorders.** `content/preorders.json` lists production batches per SKU: paid stock with its own ship date, or a funding target whose supplier order is placed once that many units are ordered. The catalog client counts paid Shopify orders per SKU since `countFrom` (`app/lib/shopify-orders.ts`, Admin API, cached one minute per isolate) and `app/lib/preorder-campaign.ts` derives the batch, the meter and the ship promise. Only SKUs the catalog policy sells as `preorder` are affected; if the counts cannot be read, those SKUs close. Every preorder cart line carries its ship promise as a `Preorder` line attribute, so checkout and the order confirmation state it. Prices stay in Shopify: the compare-at price is retail and the price is what the next unit costs. `priceTiers` steps that price as paid units come in (the first 100 at 20% off, units 101 to 250 at 10% off, then retail). `app/lib/shopify-price-tier.ts` writes each step from the `orders/paid` webhook (`/api/shopify/orders-paid`, HMAC-verified) and from the Worker's five-minute `scheduled` reconcile, both gated on `SHOPIFY_PRICE_TIER_WRITE_ENABLED=1`. A SKU Shopify still prices under its step closes instead of selling under it. The same two runs hold every paid order with a `Preorder` line (`app/lib/preorder-fulfilment.ts`): each open fulfillment order gets a hold (reason Other, handle `opendrone-preorder`, a note naming the batch and its ship promise) and the order gets the tags `preorder` and `batch:<SKU>:<N>` for each batch its units fall into. `shipsWith` lists the accessories and spares: each rides a campaign SKU at a flat price with no steps, either pinned to a dated batch (antennas, capacitors, straps and props ship with FC batch 1) or following the batch the lead's next unit falls into (OpenFrame spares follow the frame target). Their units do not count toward the lead, and their order lines take the lead's batch tag. The `preorder` tag marks an order as done, so a released order is never held again. `/api/status/campaign` (never cached) reports per campaign SKU whether it is open, whether the paid counts and price steps read cleanly now, and the last run of each job in that Worker isolate; it answers 503 when a campaign SKU is closed, so an uptime monitor can alert on it. `/preorder` explains the model and tracks every target.

**Cart country.** A new cart gets the visitor's country (`CF-IPCountry`) as its Shopify buyer country, so checkout opens in that market with its shipping rate. `POST /api/shopify/cart-country` (form field `country`, same-origin, open only when checkout is) sets a different country on the session cart; a blocked country, or one outside the EU, is never set. Consumers buy direct in the 27 EU states only (`app/lib/shipping-rates.ts`); a visitor from any other country that is not blocked sees "EU consumer orders only" with links to `/wholesale` and the newsletter, and the cart offers no checkout. Check tax-inclusive prices and totals against the final address in the accepted Shopify configuration.

**Product lines.** OpenESC 20x20 / 30x30 and the four OpenRX variants are one
Shopify product with a `Model` attribute; the page renders a tier ladder matched
to the catalog's variants by option name and value.

**Product images** use Shopify CDN URLs directly.

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
product JSON.
Rows a README does not carry go in `specsExtra` (product or tier), accessory
rows in `content/accessories.json`. Keys named in a `placeholders` array are
values awaiting the final figure, never marked on the page; `npm run
specs:placeholders` lists them and the preorder launch dry run warns while any
remain.

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

**Support.** `/support` links to the configured OpenDrone Discord invite and `mailto:` company address. Existing-conversation links lead to the same native contacts. The retired `/api/support/*` surface returns `410` at the Worker boundary. Historical ticket exports remain private outside this repository.

**Trade.** `/wholesale` takes quote requests from shops for the whole range, outside the Shopify cart and checkout, without creating an order or promising import eligibility. Product, freight, importer and payment terms are settled in an accepted written quote. Shops in the EU27 and United States can enquire; receivers are not quoted to the United States. The form emails `PUBLIC_COMPANY_EMAIL` through Resend (`RESEND_API_KEY`, `SUPPORT_FROM_EMAIL`) with reply-to the shop; without a key it reports the request as not sent. The SKUs a shop can ask for, the VAT/EIN checks and the request validation are in `app/lib/trade.ts`.

**Reviews.** The PDP's rating line and reviews chapter read Shopify's standard `reviews.rating` and `reviews.rating_count` product metafields, which the installed review app (Judge.me) maintains. No third-party script runs on the page. A product without those metafields renders no trace of the feature, so the chapter appears by itself once the first review is published.

**Newsletter.** Posts are Markdown in `content/posts/` (`published: true` publishes at `/newsletter/<slug>` and in `/newsletter.rss`). The footer signup records single-opt-in consent in Shopify and adds the `newsletter` tag plus `notify-<handle>` for product launch interest, and `country-<CODE>` for a visitor from a country sold only through shops. `/newsletter/unsubscribe` changes Shopify consent to `UNSUBSCRIBED`; it sends no welcome or confirmation email. `SHOPIFY_NEWSLETTER_WRITE_ENABLED` is a separate runtime gate.

**Legal.** The legal documents in `app/content/legal/{en,nl,fr}/` serve at
`/{en,nl,fr}/<slug>`; the bare `/<slug>` redirects to the visitor's cached
locale, and `LangToggle` appears only on legal paths. `npm run sync:legal`
(run by `prebuild`) overwrites four Dutch pages only when `COMPLIANCE_SRC`
names a source directory. The site UI is English-only. `/recycling` adds the producer (EPR) registration numbers per EU country from `content/registrations.json` under its text; a number still `null` is not shown.

**Other routes.** `/products` is the one browse page; `/collections/*`,
`/search`, `/cart/*` and `/discount/*` redirect to it. `/open-source`,
`/production` and `/firmware-partners` are content pages; `/contact`
redirects to `/support`; `/account/support` sends visitors to the native support contacts. `robots.txt`, `sitemap.xml`,
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
and `**strong**` only. Catalog data is edited in Shopify, synced Dutch legal pages
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

The annotated list is [`.env.example`](.env.example). Production uses `SESSION_SECRET`; Shopify Storefront domain/token/version; the closed SKU policy; explicit VAT confirmation; and Shopify Admin customer scopes for newsletter consent. `PUBLIC_COMING_SOON=1` and `SHOPIFY_CHECKOUT_WRITE_ENABLED=0` keep commerce closed. `SHOPIFY_NEWSLETTER_WRITE_ENABLED` gates consent writes independently. Native support uses `DISCORD_SUPPORT_INVITE` and `PUBLIC_COMPANY_EMAIL`. `PUBLIC_*` values reach the client bundle; tokens do not.

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
  `feat/preorders` deploys the isolated staging Worker `opendrone-web-preview`
  (`wrangler.toml`): a workers.dev URL, no custom domains, HTTP basic auth
  (user `opendrone`, the `STAGING_PASSWORD` secret) and `X-Robots-Tag:
  noindex, nofollow` on every Worker response. Static files from
  `dist/client` are served by Cloudflare before the Worker runs, so they
  bypass both. Staging runs the shop open
  (`PUBLIC_COMING_SOON=0`, checkout writes on) against the same Shopify
  store, and never writes prices.

Both use the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` and pin wrangler 4. Storefront and Admin tokens are Worker secrets, never committed. `community-sync.yml` refreshes the contributor roster only; `timeline-ledger.yml` updates the public repository timeline.

## Preorder release configuration

The private [launch plan](https://github.com/incutec-org/operations/blob/main/projects/opendrone/README.md)
is the single planning entry point and links to the maintained research. This
repository owns implementation, configuration and verification. Do not copy
business strategy or regulatory research into this guide.

| Source | Owns |
| --- | --- |
| `content/preorders.json` | Batch sizes, funding deadline, dispatch estimates, reviewed `deliveryBy` dates and price-step rules |
| `content/registrations.json` | Public producer numbers and explicit `saleApproved` per EU destination |
| Shopify | Product prices, catalog identity, orders, payments, customer consent and accepted shipping profiles |
| `app/content/legal/{en,nl,fr}/` | Customer terms, with campaign dates supplied by the offer and order confirmation |
| `scripts/launch-preorders.mjs` | Read-only preflight by default; its `--apply` path opens checkout and deploys production |

A producer number alone cannot open a destination. `saleApproved` requires the
relevant product, tax, EPR, language, carrier and delivery evidence. All entries
remain false until reviewed. `deliveryBy` is a customer delivery date, not a
supplier or carrier dispatch date. Null is deliberate when no supportable
commitment exists. The launch preflight refuses missing approvals or dates;
this technical check does not approve the underlying evidence.

The implemented model is an ordinary Shopify order paid in full, with custom
batch logic. It is not Shopify's native selling-plan preorder feature. Verify
provider acceptance, capture, available methods, reserves, tax, refunds and
notifications in an isolated rehearsal. The final Shopify address must be
restricted by the accepted markets/shipping profile as well as the storefront
gate; a cookie or visitor country alone cannot enforce that address.

Production stays closed. Run the launch dry run only for a requested launch
review. `--apply` requires a separate founder go: it changes production secrets
and variables, merges the integration PR, deploys, registers the webhook and
changes product topics. Never run it to preview this branch.

## Fulfil a batch

Paid preorder orders stay on hold until their batch is released. Verify in
the accepted shipping integration that held orders cannot produce a label. When a batch arrives:

1. `node --experimental-strip-types scripts/release-batch.mjs --sku OPENFC-LITE-2020 --batch 1`
   lists the held orders tagged `batch:OPENFC-LITE-2020:1`: the ones that
   ship now, and the ones that still wait for another batch in the same
   order (an order ships as one parcel). Add `--with SKU:N` for any other
   batch that is also in stock, or that is settled because its item was
   refunded or the buyer chose to wait.
2. Run it again with `--apply`. It releases the preorder hold on each
   order that ships now. Nothing else changes.
3. In the bpost plugin, import the released orders and print the labels.

The script reads the Shopify Admin credentials from `.env` and never prints
them. An order with an item whose target was missed is released once that
item is refunded in Shopify admin: a line with nothing left to ship no
longer holds the order back.

## Tell buyers

Terms 7bis.3 and 7bis.3bis promise an email when a ship date moves and
when a funding target is missed. `scripts/preorder-notify.mjs` writes them
per order, in the buyer's language (English, Dutch or French):

- Ship date moved: `node --experimental-strip-types scripts/preorder-notify.mjs --kind moved --sku OPENFC-LITE-2020 --batch 1 --new-date "mid November 2026" --new-date-nl "half november 2026" --new-date-fr "mi-novembre 2026"`.
- Target missed by `endsOn`: `--kind missed --sku OPENRX-LITE --batch 1 --new-date "by the end of June 2027"`.
  The email offers a refund or to wait, and states the 30-day reply
  deadline after which the item is refunded.

Without `--send` it prints every email and sends nothing. With `--send` it
sends through Resend from `SUPPORT_FROM_EMAIL` with replies to
`contact@opendrone.be`, and tags each order `notified-<kind>:<SKU>:<N>` (a
rerun skips those orders; `--again` resends). Record each answer with
`--record "#1001" --sku OPENRX-LITE --choice refund|wait --apply`, which
tags the order `preorder-refund:<SKU>` or `preorder-wait:<SKU>`. Refunds
are made in Shopify admin.

## Security

- Headers (`app/entry.server.tsx`): nonce-based CSP, HSTS with preload,
  `X-Frame-Options: DENY`, nosniff, strict referrer policy, restrictive
  Permissions-Policy, COOP and CORP.
- Rate limits: a per-isolate sliding window on every public POST.
- Commerce credentials are server-only Worker secrets. `.env` is gitignored; never expose tokens or the SKU policy in client data. Rotate the session secret,
  the Resend key and the Turnstile secret annually or on suspicion.
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
