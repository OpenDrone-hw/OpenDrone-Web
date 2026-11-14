# Development

Commands, layout, the studio and the test shop. Start with the [README](../README.md).


## Commands

| Command | Does |
|---|---|
| `npm run dev` | dev server (server.ts in workerd) with the studio at `/studio` |
| `npm run typecheck` | `react-router typegen` then `tsc --noEmit` |
| `npm run lint` | ESLint over the repository |
| `npm test` | `node --test` over `app/**/*.test.ts`, no test framework |
| `npm run build` | the production build into `dist/` |
| `npm run preview` | build, then serve `dist/` locally with `wrangler dev` and the production Worker config |
| `npm run check:registry` | the product registry's data invariants (CI runs it; lint and tsc never evaluate them) |
| `npm run db:migrate:local` | apply `migrations/` to the local D1 the dev server uses |
| `npm run support:sandbox`, `support:staff` | fake Discord and Shopify for local ticket runs, and the team's side of them ([support.md](support.md#test-support-locally)) |
| `npm run check:status` | fails when a static roadmap status is ahead of its repo's `status-*` topic |
| `npm run gen:board-art` | export every PCB as layered SVG and copper rasters (needs KiCad and cwebp) |
| `npm run gen:components` | regenerate only `public/boards/<handle>/components.json` from the PCBs |
| `npm run gen:box-art` | render the in-the-box flat-lays into `public/boxes/` from `scripts/in-the-box/specs/` (needs Blender, cwebp and ImageMagick) |
| `npm run gen:schematics` | render the schematic sheets from the board checkouts |
| `npm run sync:specs` / `sync:specs:check` | mirror each board README's `## Specifications` table into `content/products/<handle>.json`, or diff |
| `npm run specs:placeholders` | list every spec value still marked as a placeholder |
| `npm run sync:downloads` | diff the latest GitHub release assets against the product JSON (`--check` only) |
| `npm run sync:timeline` | append releases, new repos and status flips to the timeline ledger |
| `npm run sync:contributors` | refresh `content/contributors.json` from GitHub |
| `npm run studio:coverage` | which files still have copy baked into code |
| `npm run studio:keys` | fails when code uses a copy id missing from `content/copy/` |
| `npm run sync:testing` / `sync:testing:check` | export the published bench figures into `public/testing/`, or diff |
| `npm run tokens:check` | fails when `app/styles/opendrone-tokens.css` no longer matches the hash on its first line |
| `npm run studio:tokens`, `studio:products` | regenerate the studio's token catalogue from `@theme`; rewrite `content/products/*.json` in normal form |
| `npm run goals:update` | move the auto-mode goals in `content/goals.json` from the shop's order totals |
| `npm run check:reach` | read-only: Shopify markets and shipping zones against `NO_SHOPIFY_ROUTE` in `app/lib/shipping-rates.ts`; exits 1 when they differ |
| `BASE=<url> npm run e2e:region` | drives the header region control in Chrome (pick a market, page currency, cookie, next page, a `?country` link); IP cases only against a local server |
| `npm run us:prices` | compare the US price uplift in `content/us-sales.json` with Shopify's price list (`-- --apply` writes it; see [selling.md](selling.md#us-prices)) |
| `npm run sync:lab-visit -- <game dir>` | copy the lab walkthrough's runtime files into `public/lab-visit/` (`-- --check <game dir>` diffs only) |
| `npm run audit:perf`, `audit:lh`, `audit:mobile` | performance lab, Lighthouse, mobile screenshots |
| `npm run gen:shopify-templates` | render the Shopify notification emails from `scripts/shopify-templates/` into `out/`, ready to paste into Shopify |
| `npm run emails:preview` | local gallery of every customer and internal email, per scenario, at desktop and 375 px width; reloads on save ([selling.md](selling.md#preview-emails)) |
| `npm run emails:build` | the same gallery as one self-contained `index.html` that the build creates in the workspace's `.review/emails` folder (`--out <path>` elsewhere), plus one file per mail in `cards/` |
| `npm run emails:chrome` / `emails:paste` | start the dedicated Shopify Chrome; dry-run or apply the templates into Shopify admin ([selling.md](selling.md#paste-into-shopify-admin)) |
| `npm run emails:hash` | sha256 of every pasteable `out/*.html` (`-- --json` for the paste list with notification name and subject) |
| `node --experimental-strip-types scripts/release-batch.mjs --sku <SKU>` | dry run: the held orders of a batch; `--apply` releases their holds ([selling.md](selling.md#fulfil-a-batch)) |
| `node --experimental-strip-types scripts/preorder-notify.mjs --kind moved\|missed --sku <SKU> --new-date <text>` | dry run: renders the moved ship date or missed ship-by date email per order; `--send` sends through Resend ([selling.md](selling.md#tell-buyers)) |
| `node scripts/launch-blast.mjs <handle>` | dry run of the product mail to the `notify-<handle>` Resend segment; `--create` drafts, `--send` sends |
| `BASE=<url> node scripts/smoke.mjs` | GETs the main routes of any base URL and asserts status and content; passes with the shop open or closed (`SMOKE_AUTH=opendrone:<password>` for staging) |

CI on a pull request (`.github/workflows/ci.yml`) runs lint, typecheck, test, `check:registry`,
`check:status` and a production build.

## Layout

```
app/
  root.tsx                 shell, head, Organization JSON-LD
  entry.server.tsx         CSP and security headers
  routes/                  file-based routes
  components/              shared React components
  content/legal/{en,nl,fr} legal Markdown
  lib/                     catalog, campaign, cart, i18n, SEO, product content, growth
  studio/                  the studio's editor panels
  styles/app.css           the single CSS file (Tailwind v4)
content/                   editable copy, product chapters, preorders, posts, theme tokens, goals, votes
public/                    models (GLB), board art, schematics, logos, lab-visit/ (the /visit walkthrough)
scripts/                   board art export, hero build, sync, audit and order scripts
server.ts                  Worker entry: fetch, and the five-minute scheduled jobs
migrations/                D1 schema of the support ticket store
studio/                    the dev-only Vite plugin (the studio's write endpoint)
test/fixtures/catalog.json the catalog contract the mapper tests read
docs/                      deep dives (README lists them)
```

## Test shop on the incutec app

With `COMMERCE_SOURCE=app` (and `APP_API_URL`, `APP_PROJECT`, `APP_STOREFRONT_TOKEN`, optionally the Access
service token pair and `TEST_BANNER`) the whole site reads its catalog from the app (`storefront.catalog`),
the buy buttons add to the app cart and `/cart` redirects to `/shop/cart`; no `SHOPIFY_*` value is needed and
Shopify is never called. With `ACCOUNTS_ENABLED=1` (the test Worker sets it) the header shows the account entry: sign-in by a mailed link, orders with tracking, addresses (`app/lib/commerce/app-account.ts`, the app's `storefront.account*` ops); otherwise account links are hidden. Production and staging never set these variables
(`app/lib/commerce/app-api.test.ts` reads every `wrangler*.toml`). `wrangler.shoptest.toml` is the test Worker
(`opendrone-web-shoptest`, workers.dev only); pass the variables at deploy time with `--var`. Locally put them
in `.dev.vars` and run `npm run dev`.

## The studio

`npm run dev`, open `/studio`: a local mirror of the site where everything
editable is outlined. Click a string, type, save. No database, no publish
step; `git diff` is the changelog.

| Tab | Edits | Files |
|---|---|---|
| Words | page and product copy | `content/copy/*.json`, `content/products/*.json` |
| Chapters | product page sections: order, titles, on or off | `chapters.json` in `content/`, read by `app/lib/chapters.ts` (created on first save) |
| Design | design tokens | `content/theme.json` |
| Media | browse images and where each is used | read-only, `public/` |
| Docs | legal pages in en, nl, fr; learn articles | `app/content/legal/**`, `app/content/learn/*.md` |
| Data | batches, targets, price steps, dates, builds, accessories, team, registrations, as validated JSON | `content/*.json` |
| Hero | the 3D scene: lighting, timeline, camera, materials | `public/models/<design>/studio.json` |
| Goals | goal meters and vote tallies | `content/goals.json`, `content/votes.json` |

The studio cannot reach production: the write endpoint is a Vite plugin with
`apply: 'serve'`, `app/routes.ts` excludes the route from the build, and a
build-stage plugin deletes the studio HTML from the output.

Editable copy: create `content/copy/<page>.json` with `$route` and `$title`,
render strings with `<Txt id="<page>.<key>" />` (`app/components/Txt.tsx`) or
`copyText(id)` for attributes. Inline markup is `[label](/path)`, `*emphasis*`
and `**strong**` only. Catalog data is edited in Shopify, board art comes from
KiCad and the hero model from Onshape.

## Theming and i18n

The site is dark only: no light palette, no theme toggle,
no theme cookie or localStorage key. Colour goes through CSS custom properties:
every colour is a semantic token (`--color-bg`, `--color-text`, `--color-gold`,
...) in the Tailwind `@theme` block of `app/styles/app.css`. `<html>` carries the
`dark` class and `color-scheme: dark`; `app/lib/dark-only.test.ts` fails if a
light selector comes back. Brand assets and the one gold literal:
`brand/README.md`. `resolveLegalLoader` in `app/lib/i18n.ts` picks the legal
Markdown by URL prefix and each legal route emits hreflang for en, nl, fr.
