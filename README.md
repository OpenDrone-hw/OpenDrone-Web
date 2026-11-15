# OpenDrone Web

The storefront at [opendrone.be](https://opendrone.be): open-source FPV drone
hardware designed and sold from Belgium. Flight controllers (OpenFC), 4-in-1
ESCs (OpenESC), ExpressLRS receivers (OpenRX), carbon frames (OpenFrame) and
the OpenStack bundle.

A React Router 7 app, built with the Cloudflare Vite plugin, running as a
Cloudflare Worker. Shopify owns the catalog, prices, checkout, orders and
newsletter consent; this repository owns the pages, the preorder campaign
logic and the gates that open or close checkout. Support runs on tickets:
the customer writes on the site, the team answers in Discord. Email is for
sales only.

Selling entity: Incutec BV. OpenDrone is the community project and product
brand. This repository is MIT; the hardware repositories are CERN-OHL-S.

## Docs

| File | Covers |
|---|---|
| [docs/development.md](docs/development.md) | every npm command, repository layout, the studio, the test shop, theming |
| [docs/architecture.md](docs/architecture.md) | catalog, checkout, preorders, product pages, trade, routes, editorial manifest, analytics, security |
| [docs/selling.md](docs/selling.md) | open or close the shop, US and international preorders, preorder campaigns, buy now or pre-order, fulfil a batch, buyer mails, email preview and paste |
| [docs/support.md](docs/support.md) | support tickets, staff API, mail drafts, ChatFPV, support setup and local sandbox |
| [docs/accounts.md](docs/accounts.md) | shared accounts (Shopify sign-in, chatfpv.com IdP), Early Bird, owners map, pilot map |
| [docs/deploy.md](docs/deploy.md) | hosting, staging, D1 migrations, environment variables |
| [docs/product-status.md](docs/product-status.md) | roadmap display and checkout gates |
| [docs/hero-studio.md](docs/hero-studio.md) | the homepage 3D pipeline |
| [docs/growth-architecture.md](docs/growth-architecture.md) | analytics, attribution, mail |
| [docs/wholesale.md](docs/wholesale.md) | retailer onboarding and wholesale codes |
| [docs/store-compliance.md](docs/store-compliance.md) | storefront acceptance evidence |

## Run it locally

```sh
git clone https://github.com/OpenDrone-hw/OpenDrone-Web.git
cd OpenDrone-Web
npm install
cp .env.example .env       # configure the session and catalog values below
npm run dev                # http://localhost:3000, closed shop
npm run dev:like-live      # http://localhost:3000, what opendrone.be shows
```

Set the required `SHOPIFY_*` values described in `.env.example`. The app fails
closed when the catalog policy or tax configuration is missing. Node 22 (what
CI uses).

Minimum for a full local preview with real catalog data (names only):
`SESSION_SECRET`, `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_STOREFRONT_TOKEN`,
`SHOPIFY_STOREFRONT_API_VERSION`, `SHOPIFY_PREVIEW_POLICY_JSON`,
`SHOPIFY_PRICES_INCLUDE_VAT`, and `SHOPIFY_ADMIN_API_TOKEN` for the paid-unit
counts (units left in a paid batch). The root loader requires the Shopify catalog; missing
catalog settings render an error page.

`npm run dev` drops every `[vars]` entry of the wrangler config
(`vite.config.ts`): the Worker reads `.env`, then `.env.local` over it. So a
plain run is not production. `npm run dev:like-live`
(`scripts/dev-like-live.mjs`) writes `.env.local` (git-ignored) and starts the
dev server:

| Writes | From |
|---|---|
| `PUBLIC_COMING_SOON`, `PUBLIC_US_SALES`, `BATCH_CHOICE`, `ACCOUNTS_ENABLED`, `TRADE_MAIL_ENABLED`, `PILOT_MAP_ENABLED`, `CHATFPV_URL`, `CHATFPV_WIDGET_ENABLED`, `HANDOFF_ENABLED` | `wrangler.production.toml` `[vars]`, read at each run |
| `SHOPIFY_PREVIEW_POLICY_JSON` | rebuilt: every SKU in `content/preorders.json` `skus` and `shipsWith` is `preorder` with `shipPromise: null`, every other SKU the `.env` policy names is `sold_out`. The production value is a Worker secret and cannot be read back |
| `SHOPIFY_CHECKOUT_WRITE_ENABLED=0` and every Shopify, support and alert write off | fixed |
| `LOCAL_SHOP_PREVIEW=1` | fixed: on the dev server only, pages render the open shop (Buy, Pre-order, the availability bar, `/cart`) while the write gate stays shut; a build ignores it |

A click on Buy or Pre-order locally fails with "Shopify checkout writes are
not enabled." (404 from `/api/shopify/cart`): no cart, checkout or order is
created. To test checkout itself, use the test shop
([docs/development.md](docs/development.md#test-shop-on-the-incutec-app)) or staging
([docs/deploy.md](docs/deploy.md)). Delete `.env.local` to go back to the `.env` defaults.

The region follows `?country=`: the first page load with it stores the
choice in the `od_ship_country` cookie and redirects without it (localhost
has no Cloudflare IP country). A Belgian view:
`http://localhost:3000/?country=BE`; a US view: `http://localhost:3000/?country=US`.

## Test

```sh
npm run typecheck && npm run lint && npm test
npm run build              # when routes, the server entry or the Vite config change
```

`npm test` is `node --test` over `app/**/*.test.ts`. CI on a pull request
(`.github/workflows/ci.yml`) runs lint, typecheck, test, `check:registry`,
`check:status` and a production build. The full command list is in
[docs/development.md](docs/development.md).

## Edit content

Copy, product chapters, preorders, theme tokens, goals and votes live as JSON
and Markdown in `content/` and `app/content/`. `npm run dev`, then open
`/studio`: a local editor over those files (click a string, type, save; `git
diff` is the changelog). It never reaches production. Catalog data (names,
prices, variants) is edited in Shopify, board art comes from KiCad and the hero
model from Onshape. Details: [docs/development.md](docs/development.md#the-studio).

Legal text in `app/content/legal/` is copied unchanged from the private
`operations` repository in one PR.

## Deploy

A merge to `main` deploys production (`.github/workflows/cloudflare-production.yml`,
Worker `opendrone-web` on opendrone.be). So every merge to `main` needs Stan's
yes (workspace `AGENTS.md`, "Ask Stan first"), as do changes to the shop gates,
prices, tax, shipping and inventory policy. To preview a branch, push it to
`staging`: `git push --force origin HEAD:staging` (Worker
`opendrone-web-preview`, basic auth). Details: [docs/deploy.md](docs/deploy.md).

## Contributing

1. Branch from fresh `main`: `<type>/<topic>` (`feat`, `fix`, `chore`,
   `refactor`, `docs`).
2. Commit with DCO sign-off (`git commit -s`), Conventional Commits, subject
   at most 60 characters.
3. `npm run typecheck && npm run lint && npm test` locally.
4. `gh pr create`. Maintainers squash-merge; `main` is protected with linear
   history, and a merge is a production deploy.

Rules: no new npm dependency without an issue first; mobile-first (375 px,
enhance at 768 and 1440); WCAG 2.1 AA; bundle additions over 50 KB gzipped
need justification; no `console.log` in production code.

Security: report vulnerabilities through GitHub private vulnerability
reporting; policy at `/security`. Headers and limits: [docs/architecture.md](docs/architecture.md#security).

## License

[MIT](LICENSE) for this repository. The hardware lives at
[OpenDrone-hw](https://github.com/OpenDrone-hw) under CERN-OHL-S.
