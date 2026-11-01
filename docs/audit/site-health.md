# opendrone.be site health audit

Date: 2026-11-01. Branch: `feat/site-audit-2026-11` (commit 400e381). Live site checked at https://opendrone.be.
Method: read-only. No source edits, no Shopify writes. Raw outputs are kept outside the repo.

Severity scale: High (user or revenue impact, or a broken gate), Medium (measurable SEO, performance or maintenance cost), Low (polish).

## Summary

| Area | Result |
| --- | --- |
| Broken links | 0 non-200 on 109 internal URLs (sitemap plus links on 11 pages); 4 internal links point at redirecting URLs. 0 of 31 external links failed. |
| Lighthouse | Not measured. Headless Edge failed three times with `NO_NAVSTART`; Chrome is not installed on this machine. |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `npm audit` (full) | 18 moderate, 0 high, 0 critical (all one dev-only `minimatch` advisory) |
| `npm run typecheck` | pass |
| `npm run lint` | fail: 58 errors, 248 warnings (all 58 errors in `app/routes/_index.tsx`) |
| `npm test` | 1725 tests, 1697 pass, 26 fail (generated email output and Shopify email draft hash checks) |
| Soft 404s | none found; unknown paths return a real 404 |

## Findings

### 1. SEO and metadata

**S1 (Medium). robots.txt and sitemap.xml are served without the security headers that HTML gets.**
Evidence: `curl -sI https://opendrone.be/robots.txt` and `/sitemap.xml` return only `Cache-Control: max-age=86400`; no HSTS, `X-Content-Type-Options`, etc. The HTML routes carry the full set. Likely these routes are answered before the header wrapper.
Fix: apply the same header wrapper to the text/XML routes in `server.ts` (`app/routes/[robots.txt].tsx:12`, `app/routes/[sitemap.xml].tsx`). Have a security-header reviewer confirm.

**S2 (Medium). Sitemap has no `lastmod` and omits localized alternates.**
Evidence: `app/routes/[sitemap.xml].tsx` emits `<url><loc>` only (65 URLs). Legal pages exist in en/nl/fr and carry hreflang in-page, which works, but `lastmod` helps recrawl of the 40+ product pages.
Fix: add `lastmod` from catalog `updatedAt` / post date; optionally add `xhtml:link` alternates for legal pages.

**S3 (Medium). Twitter card carries only `twitter:card`.**
Evidence: `app/lib/seo.ts:116`. X falls back to OG title, description and image, so this is functional; explicit tags are safer.
Fix: add `twitter:title`, `twitter:description`, `twitter:image` mirroring OG.

**S4 (Low). Home page has no `WebSite` JSON-LD and the Organization block is the only structured data.**
Evidence: `home.html` JSON-LD types: Organization only. Product pages have Product, AggregateOffer/Offer with `MerchantReturnPolicy`, and BreadcrumbList (good).
Fix: add `WebSite` with `SearchAction` (the site has `/search`). On products add `gtin`/`mpn` when known and `shippingDetails` on Offer (needed for Google merchant listing rich results).

**S5 (Low). Organization JSON-LD exposes a telephone number on every page.**
Evidence: `buildOrgJsonLd`, `app/lib/seo.ts:179`; present in the head of `/`.
Fix: confirm it is the intended public business line; otherwise drop it from the JSON-LD.

**S6 (Low). Product `og:image` and Lighthouse robots check.**
Evidence: product `og:image` is the Shopify CDN URL without dimensions (by design, `seo.ts:125`). `og-image.png` is served `max-age=0, must-revalidate`, so social scrapers always revalidate. Separately, the partial Lighthouse report flagged `robots.txt is not valid` on the home run; this is unverified (the run had no trace). The file's directives looked well formed; the `Sitemap:` lines inside per-agent groups are legal but unusual.
Fix: add `/og-image.png` to `public/_headers` with a 1-day cache; validate robots.txt in Search Console and consider one top-level `Sitemap:` line.

**What is good.** Canonical on every checked page, query stripped (`seo.ts:140`). Per-route title and description. `noindex,nofollow` on account, support, doc, learn, hero-preview, shop.* (app-commerce path). 404 is a real 404 with `noindex,nofollow` and title "Signal lost". Legal pages: canonical plus hreflang `en`/`nl`/`fr`/`x-default` and `og:locale:alternate` (verified on `/nl/privacy`). `llms.txt` is present (200, `max-age=600`), and referenced from robots.txt.

**Duplicate content (legacy Shopify URLs): handled.** `app/lib/legacy-urls.ts` plus `collections.$`, `pages.$`, `policies.*`, `blogs.*` routes. Live: `/collections/all` 301 to `/products`, `/blogs/news` 301 to `/newsletter`, `/pages/about` 404 (intended, per `pages.$.tsx`). `docs/url-inventory.json` is tested by `legacy-urls.test.ts`.

**S7 (Low). `/pages/*` unknown pages return an empty-body 404 without the site shell or security headers.**
Evidence: `app/routes/pages.$.tsx` returns `new Response(null, {status: 404})`; live `curl -I /pages/about` shows no CSP etc.
Fix: throw `new Response('not found', {status: 404})` into the root ErrorBoundary like `$.tsx` does, so users see the "Signal lost" page.

**S8 (Low, recommendation). Redirect `/shop`, `/store`, `/catalog` and trailing-slash variants to `/products`.**
Context: `app/routes/shop.*.tsx` serve the incutec-app commerce path (`COMMERCE_SOURCE=app`), so the redirect must apply only when that path is off. Today `/shop` and `/store` return a real 404 (confirmed, no soft 404), which loses visitors who guess the URL.
Fix: in `app/routes/shop._index.tsx` loader (currently `requireAppCommerce(context.env)` at line 10), when `appCommerceEnabled(env)` is false, `throw redirect('/products', 301)`; add `store._index.tsx` and `catalog._index.tsx` routes (or entries in `legacy-urls.ts`, which the catch-all `$.tsx` already consults) that 301 to `/products`. Add a case to `legacy-urls.test.ts`. Keep `/shop/*` sub-paths on the app path untouched.

### 2. Performance and Core Web Vitals

**P1 (Medium). Core Web Vitals not measured in this audit.**
Evidence: `lighthouse@12` with the only available browser (Edge 156, headless new and old) failed with `NO_NAVSTART` on home and a product page (logs in raw dir). Partial reports show transfer weight: home 1,645 KiB, `/products/openesc` 1,154 KiB (Lighthouse total byte weight, simulated mobile).
Fix: run `npm run audit:lh` (`scripts/lh-audit.mjs`: runs `npx lighthouse`, no secrets, writes only to `.lh/`) on a machine with Chrome, and keep the JSON for diffing. `npm run audit:perf` needs Playwright Chromium and, for the hero, a headed GPU session; also no secrets.

**P2 (Low). 3D hero is lazy and gated, good; its chunk size was not measured.**
Evidence: `HeroDroneStage.tsx:15-45`: no 3D under 768px or with `prefers-reduced-motion`; scene loaded by dynamic `import('~/components/HeroDroneScene')` (three, r3f, postprocessing stay out of the entry chunk). GLB models total 14 MB in `public/models`, largest `esc5.glb` 1.2 MB, `postbuild` runs `compress-models.mjs`, cached 1 day (`public/_headers`).
Fix: record the scene chunk size from `npm run build` output in CI; consider `immutable` caching for hashed GLB names.

**P3 (Medium). Home page modulepreloads 47 JS chunks (about 319 KB brotli) including cart, turnstile, ChatFPV widget and HeroDroneStage.**
Evidence: `<link rel="modulepreload">` count in `/` HTML; sizes in raw dir `home-js-sizes.txt` (entry 67 KB, `copy` 53 KB, `chunk` 46 KB, `nav` 43 KB). `copy-*.js` (53 KB) is the bundled copy JSON for all pages (`app/lib/copy.ts` eager glob), loaded everywhere.
Fix: split copy per route (non-eager glob keyed by page) and lazy-load the ChatFPV widget and checkout beacon after first interaction.

**P4 (Low). Large product and board PNGs.**
Evidence: `public/boards/openfc-lite/front.png` 674 KB, `openesc/back.png` 641 KB (and the `-20x20`/`-30x30` copies), more in `public/boxes`. Shopify CDN images are already `format=webp&width=` with srcset (good); the local PNGs are not.
Fix: convert to WebP/AVIF at build and serve with `<picture>`; dedupe the identical size variants.

**What is good.** Fonts: Inter and JetBrains Mono preloaded as woff2 with `crossorigin`, `font-display: swap`, metric-matched fallbacks (`app/styles/app.css:7-45`). Hashed assets: `Cache-Control: public, max-age=31536000, immutable`, `CF-Cache-Status: HIT`. `preconnect` to cdn.shopify.com. HTML is not cached at the edge (no Cache-Control; dynamic per-request nonce CSP). Catalog and status are memoized in the Worker (`catalog-memo`, `edgeCache`).

**P5 (Low). HTML is unchached and personalised per request (CSP nonce).**
Evidence: `curl -sI /` returns no `Cache-Control`. TTFB depends on Worker plus catalog fetch.
Fix: acceptable for a nonce CSP; if TTFB is high in field data, consider hash-based CSP for static pages so they can be cached at the edge.

### 3. Broken links

Crawl: sitemap (65 URLs) plus links found on `/`, `/products`, `/open-source`, `/roadmap`, `/shipping`, `/preorder`, `/support`, `/products/openesc`, `/owners`, `/testing`, `/en/legal`; sequential, 150-300 ms delay (`tools/crawl.mjs`, `tools/crawl2.mjs`, outside the repo).

Result: 0 broken. Redirecting internal links (each is a wasted hop and a link-equity leak):

| ID | Severity | Link | Found on | Behaviour |
| --- | --- | --- | --- | --- |
| L1 | Low | `/privacy` | home footer | 302 to `/en/privacy` |
| L2 | Low | `/warranty` | `/products/openesc` | 302 to `/en/warranty` |
| L3 | Low | `/end-use` | `/shipping` | 302 to `/en/end-use` |
| L4 | Low | `/collections/all` | `/open-source` | 301 to `/products` |
| L5 | Low | `/contributing` | `/roadmap` | 301 to the org CONTRIBUTING.md on GitHub (external, resolves) |

Fix: link legal pages through `legalHref(to, 'en')` (`app/components/LangToggle.tsx`) wherever a raw `/privacy`-style path is used; point L4 at `/products`. The unprefixed legal redirect is a 302 (per-language, cookie-based) which is correct for a language-negotiated URL but means the unprefixed URLs should not be linked or listed.
External links: 31 checked on the pages above, all 200 after redirects.

### 4. Internationalisation

**I1 (Medium). The shop is English-only; NL/FR exist for legal pages only.**
Evidence: `app/lib/i18n.ts:3-14`; `app/routes/$.tsx` redirects a locale-prefixed shop path (`/nl/products`) to the English page (302). `<html lang>` follows the URL (`root.tsx:153,293`); verified `lang="nl"` and `og:locale=nl_BE` on `/nl/privacy`. Everything else is `lang="en"`. For a Belgian shop (nl-BE, fr-BE, en), checkout pages, shipping, product pages and the home page have no Dutch or French version.
Fix: decide whether product and shipping pages need NL/FR. If yes, extend the `/{locale}/` scheme to those routes with hreflang on each; if no, state it in the toggle (it currently implies a full site toggle).

**I2 (Low). LangToggle is shown globally but only translates legal pages.**
Evidence: `Header.tsx:878`, `PageLayout.tsx:7`. On a non-legal page it has nothing to switch to; it sets a cookie that only affects the unprefixed legal redirect (`LANG_COOKIE`, `i18n.ts`).
Fix: show the toggle only on legal routes, or give it a visible label that it affects legal texts.

**I3 (Low). hreflang is emitted only by legal routes; the cookie-driven redirect from unprefixed legal URLs is a 302 and varies by cookie/browser language.**
Fix: ensure `Vary: Cookie, Accept-Language` on the 302 so edge caches do not leak a language to other visitors (check `app/lib/i18n.ts` redirect helpers).

**Content structure.** Site copy lives in `content/copy/<page>.json` (English), loaded via eager glob (`app/lib/copy.ts`); legal bodies in `app/content/legal/{en,nl,fr}`. All three locales have the same 9 files (no missing legal translations). No translation keys are missing for shop copy because shop copy has no other locales.

### 5. Dependencies and security

**D1 (Low). 18 moderate advisories, all one dev-only chain.**
Evidence: `raw/health/audit-full.txt`: `minimatch` DoS via globparts amplification (GHSA-g3hv-75wg-m249, range `<11.0.1`) pulled in by the ESLint plugin chain (`@eslint/eslintrc`, `@typescript-eslint/*`, `eslint-plugin-import|jsx-a11y|react`, `@react-router/fs-routes`). `npm audit --omit=dev`: 0.
Fix: wait for upstream bumps or add an `overrides` for `minimatch`; no production exposure.

**D2 (Medium). Many majors behind, and Dependabot ignores all majors.**
Evidence: `npm outdated`: `react-router` and `@react-router/*` 7.18 vs 8.5, `vite` 6.4 vs 8.3, `typescript` 5.9 vs 7.0, `eslint` 9 vs 10, `motion` 12 vs 14, `three` 0.185 vs 0.187 (minor-class, zero-ver semver), `eslint-plugin-react-hooks` 5 vs 7. `.github/dependabot.yml` has `ignore: version-update:semver-major` for all dependencies, so majors never surface.
Fix: keep majors ignored for the React Router/Vite group but add a quarterly manual major-upgrade task; apply the pending patch bumps (`wrangler` 4.156, `@react-router/dev` 7.18.5, `marked`, `lucide-react`, `postprocessing`).

**D3 (Low). Local Node 26 is outside `engines` (`^22 || ^24`); CI uses Node 22.**
Evidence: `npm ci` EBADENGINE warnings. The results above ran on Node 26.
Fix: none needed in repo; add `.nvmrc` to help contributors.

**D4 (Low). Stray empty tracked file `rangler.production.toml` (typo of `wrangler.production.toml`).**
Evidence: `rangler.production.toml` is tracked at the repo root and is empty (0 lines; `wrangler.production.toml` is the real config).
Fix: `git rm rangler.production.toml`.

**D5 (Medium). Lint fails on this branch: 58 errors.**
Evidence: `raw/health/lint.log`. All 58 errors are in `app/routes/_index.tsx` (`react/no-unknown-property` 43, `react/no-unescaped-entities`, `react/jsx-no-comment-textnodes`), clustered around the hero block at about lines 690-717 where valid SVG attributes and JSX are reported as plain text, which suggests ESLint misparses a JSX region there while `tsc` accepts it. 248 warnings (mostly `no-console`) in scripts.
Fix: bisect the JSX around `_index.tsx:688-717` (an unbalanced tag or unusual JSX comment); CI runs `npm run lint`, so confirm whether `main` is green and whether this branch regressed.

**D6 (Medium). 26 failing unit tests.**
Evidence: `raw/health/test.log`: failures in "dark only", "launch mail", and the `out/ matches its sources (run npm run gen:shopify-templates)` checks for five email templates plus a Shopify Email draft sync check; assertion is a hash mismatch (`strictEqual`).
Fix: probable causes are generated email files out of date with their sources or CRLF/line-ending differences on Windows checkouts (hash of `out/` files). Rerun on Linux/CI; if it passes there, set `.gitattributes` `eol=lf` for `scripts/shopify-templates/out`; otherwise regenerate with `npm run gen:shopify-templates` (this writes local files only, review the diff).

**D7 (Low). Error boundary prints the error message.**
Evidence: `app/root.tsx:446-495`: renders `<pre>{errorMessage}</pre>` inside a collapsed `<details>` for non-404 errors. It prints `error.message` or a thrown Response's data, never `error.stack`. React Router masks server loader error messages in production builds, so leakage is limited to messages from thrown Responses and client errors.
Fix: show a reference id instead of the raw message in production; keep detail behind `import.meta.env.DEV`. Have a security reviewer confirm no thrown `Response` data contains upstream payloads.

**D8 (Low). CI covers lint, typecheck, test, registry invariants, status fallback and build; it has no `npm audit`, no `tokens:check`, no `sync:*:check` and no link or Lighthouse check.**
Evidence: `.github/workflows/ci.yml` jobs: lint, typecheck, test, registry, status, build (stub env).
Fix: add a weekly scheduled workflow for `npm audit --omit=dev` and `audit:lh` against production; add `tokens:check` and `sync:specs:check` to CI (both are read-only).

**Secrets handling (good).** `.env`, `.dev.vars` ignored; only `.env.example` tracked. Worker secrets are set with `wrangler secret put` and never in `wrangler.production.toml` (`[vars]` holds only gates and non-secret defaults). `PUBLIC_*` variables read in app code: `PUBLIC_COMING_SOON`, `PUBLIC_US_SALES`, `PUBLIC_COMPANY_*` (name, VAT, KBO, address, tel, email), `PUBLIC_DISCORD_INVITE`, `PUBLIC_LEARN_DRAFT`. All are intended to be public company identifiers or booleans. No secret-looking names found among `PUBLIC_*`. Not verified: a scan of the built client bundle for token strings (no build was run). CSP is nonce-based with `frame-ancestors 'none'`, HSTS preload, COOP/CORP, a restrictive Permissions-Policy. The CSP allows `'unsafe-inline'` for styles and `'wasm-unsafe-eval'` for scripts (needed for three/draco); have a CSP reviewer decide whether to tighten them.

### 6. Flaky status endpoint

**F1 (High for monitoring, Medium for users). `/api/status/campaign` alternates between 200 and 503.**
Evidence: reported 503 on 4 of 5 earlier calls; in this audit 8 spaced calls (8 s apart) returned `200 503 200 200 200 200 200 200`. Code: `app/routes/api.status.campaign.tsx`. The loader returns 503 whenever any SKU is not `open`, or `holdsOk` is false, where `holdsOk` requires no error reading paid orders (`holdsError === null`), `unheld === 0` and no overfull batches. Unauthenticated callers only see `allOpen`, so the cause is not visible to them.
Likely causes in the code:
1. Each Worker isolate does its own live reads: `paidUnitRuns` (Admin API orders), a price-tier dry run `syncPriceTiers`, and `fetchPreorderOrders` for holds. Only the holds result is memoized (60 s, `holdsMemo`, per isolate, success only). A failure is not cached, so every request in a cold or throttled isolate retries and fails again. Cloudflare routes requests to different isolates, which explains the alternation.
2. Any Admin API timeout or throttle makes `countsError` or `holdsError` non-null; a SKU is also closed when counts are unreadable, producing `allOpen: false`.
3. Catalog read failure (`catalogError`) leaves `availability` empty, which makes every SKU `not on the storefront` and closed.
Fix: (a) cache the whole computed status in the Cache API / KV for 60 s shared across isolates; (b) serve stale-while-error: on an upstream error, return the last good value with `stale: true` and a 200, and return 503 only for a confirmed closed SKU or a confirmed unheld or overfull hold; (c) add a retry with short backoff on Admin API 429/5xx; (d) include a non-secret `reason` code in the unauthenticated body (`catalog`, `counts`, `holds`, `closed`) so a monitor can tell upstream failure from a real problem. To confirm the cause, read the response with the status token (not available in this audit) or check Worker logs for `countsError`/`holdsError`.

## Prioritized plan

1. F1: stabilise `/api/status/campaign` (shared cache plus stale-while-error plus reason code). Highest, because monitors and the preorder gate depend on it.
2. D5 and D6: get lint and tests green on this branch (bisect `_index.tsx` JSX; check the email-template hash failures on CI). Both gate merges to `main`.
3. P1: measure Core Web Vitals with `npm run audit:lh` on a machine with Chrome, mobile preset, home and a product page; then decide on P3/P4.
4. S1 and S7: apply security headers to robots/sitemap and make `/pages/*` 404 render the shared error page. Security reviewer confirms.
5. S8: add the `/shop`, `/store`, `/catalog` 301 to `/products` only when `COMMERCE_SOURCE` is not `app`.
6. L1-L4: fix internal links that hit redirects (use `legalHref`, `/products`).
7. I1/I2: decide on NL/FR scope for shop pages; until then limit the toggle to legal pages.
8. S2-S6: sitemap `lastmod`, Twitter tags, WebSite JSON-LD and product `shippingDetails`, og-image cache.
9. P3/P4: split the copy bundle, lazy-load ChatFPV/checkout beacon, convert local PNGs to WebP/AVIF.
10. D2/D8/D7/D4/D1/D3: patch bumps and a quarterly major review, scheduled audit workflow, error-boundary message, remove `rangler.production.toml`, minimatch override, `.nvmrc`.

## Raw data (outside the repo)

`C:\Users\Kristian\work\OpenDrone-audit-private\raw\health\`: `crawl-internal.json`, `crawl-external.json`, `crawl*.log`, `audit-full.json|txt`, `audit-prod.txt`, `outdated.txt`, `typecheck.log`, `lint.log`, `test.log`, `headers.txt`, `home-js-sizes.txt`, partial Lighthouse JSON/logs. Tools: `C:\Users\Kristian\work\OpenDrone-audit-private\tools\`.
