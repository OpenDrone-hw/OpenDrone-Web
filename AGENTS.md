# OpenDrone web

The OpenDrone storefront (opendrone.be), a public repository.

Validate: `npm run typecheck && npm run lint && npm test` (add `npm run build` when routes, server entry or Vite config change)

## Boundaries

- Public repository: no supplier names, costs, personal data, private strategy or regulatory research.
- A merge to `main` deploys production (`.github/workflows/cloudflare-production.yml`).
- Storefront gates in `wrangler.production.toml` (`PUBLIC_COMING_SOON`, `SHOPIFY_CHECKOUT_WRITE_ENABLED`) and `SUPPORT_EMAIL_NOTIFY_ENABLED` / `SUPPORT_MAIL_INTAKE_ENABLED` change only with the founder's go.
- Prices, tax, shipping and inventory policy change only with the founder's go; `npm run us:prices --apply` writes to Shopify.
- Legal text in `app/content/legal/` is copied unchanged from `operations/documents/storefront-legal/` in one PR; never a legal draft or review PR here.
- Public appearance of opendrone.be does not change unless the task says so; use only real product photos and renders.
- `public/testing/` and `public/lab-visit/` change only through `npm run sync:testing` and `npm run sync:lab-visit`.
- No support email address on pages or chrome. The Worker never sends mail.

## Pointers

- `README.md`: run, campaign, order and support procedures
- `docs/product-status.md`: roadmap display and checkout gates
