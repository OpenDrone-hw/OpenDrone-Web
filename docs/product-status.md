# Product status and checkout gates

Repository topics describe roadmap lifecycle. Display status and server-side
purchase authorization are separate gates; a topic change does not open orders.
This reference describes `main`, not a preorder branch or an approved launch.
Opening checkout or collecting funds requires explicit founder approval of the
reviewed configuration. A merge to `main` deploys production.

## Roadmap taxonomy

One `status-*` topic per board repository, matched against `STATUS_ORDER` in
[roadmap-data.ts](../app/lib/roadmap-data.ts). Labels and legends are copy keys
in `content/copy/roadmap.json`.

| Topic | Roadmap meaning | Display fallback without a catalog availability or content override |
|---|---|---|
| `status-launched` | Launched design | `live` |
| `status-beta` | First production batch | `live` |
| `status-alpha` | Community testing | `development` |
| `status-in-progress` | Design in progress | `development` |
| `status-planned` | Planned design | `idea` |

These display values do not establish stock, price approval or permission to
accept orders. A page carrying several boards uses its furthest-along board
for the roadmap fallback.

## Display resolution

[product-content.ts](../app/lib/product-content.ts), `resolveStatus`, resolves
in this order:

1. Explicit JSON `status: idea` or `development` stays locked; explicit `live`
   returns `live`, even with the global flag set. These are display overrides.
2. When catalog availability is supplied, the global coming-soon flag returns
   `development`. Otherwise `preorder` returns `preorder`; `in_stock` and
   `sold_out` return `live`. `live` therefore does not mean in stock.
3. Explicit JSON `preorder` remains `development` until the global flag is off.
4. Legacy JSON `comingSoon`, then the roadmap topic/static fallback above.
5. Without those inputs, the global flag selects `development` or `live`.

The global flag defaults closed; only `PUBLIC_COMING_SOON=0` clears it.
The root loader supplies catalog availability and live topic flags to
`resolveAllStatuses` for the client. Callers without catalog availability can
reach the roadmap fallback, so do not treat every display surface as purchase
authorization. Product modules and feeds also need their price/offer guards.

## Server-side checkout authorization

[shopify-cart-action.ts](../app/lib/shopify-cart-action.ts) requires both
`SHOPIFY_CHECKOUT_WRITE_ENABLED=1` and `PUBLIC_COMING_SOON=0` before a cart POST
can access the catalog. It then enforces same-origin/form checks, resolves each
SKU from the request-time catalog, rejects missing merchandise IDs and
`sold_out` variants, and requires a purchasable lifecycle status. This lifecycle
check uses content/static roadmap resolution, not the root loader's live topic
map or catalog-aware display resolution.

[shopify-storefront.ts](../app/lib/shopify-storefront.ts) requires an explicit
`SHOPIFY_PREVIEW_POLICY_JSON` entry for every SKU. Shopify `availableForSale`
can deny availability; it cannot prove physical stock. The policy and other
catalog validation remain separate from the global flags.

The cart GET loader returns `410` unconditionally, including for old sessions.
Changing flags alone does not restore that cart surface. The committed
[production configuration](../wrangler.production.toml) keeps the global flag
on and checkout writes off. Verify deployed policy separately; committed flags
are not proof of live catalog settings or authorization to accept funds.

## Latency and failure model

- Topic fetches are cached 10 minutes per worker isolate, with a single
  shared in-flight fetch (concurrent cold requests never fan out twice).
  Loaders cap the wait (400-600ms) and fall back to the static list while
  the fetch finishes under `context.waitUntil`; always pass waitUntil
  from loaders, or the Worker cancels the losing fetch with the response and
  the cache never fills. A flip lands within ~10 minutes.
- The feeds' HTTP Cache-Control is capped at 600s for the same reason: a
  response cached longer than the gating latency would keep serving a
  price after a topic downgrade.
- `GITHUB_STATUS_TOKEN` (fine-grained, public read only) must be set as a
  Worker secret: without it the unauthenticated 60/h budget can rate-limit the
  fetch and pin the site to the static statuses.
- **Fallback discipline: the static status in ROADMAP must LAG the repo
  topic, never lead it.** If the API is down, the static value stands in; a
  static `beta` while the repo says `alpha` can expose prices on surfaces
  using that fallback. Flip the topic first, then update the static value in
  a follow-up PR once the flip is live. `npm run check:status`
  (`scripts/check-status-fallback.mjs`, run by CI on every PR) fetches the
  live topics and fails when a static value is ahead of its repo, when a
  linked repo is unreachable, or when it carries no `status-*` topic.
- An entry without a `link` uses its static status and is not fetched.

## Runbooks

**Change a roadmap status:** review the engineering lifecycle, then have an
admin/maintainer change the topic. Update the static fallback in a follow-up PR
only after the topic is observed live. This changes lifecycle presentation;
it does not replace catalog policy, checkout gates or founder approval.

**Prepare checkout review:** verify the exact code revision, storefront-channel
catalog, SKU policy and server gates in an isolated test environment. Use mocked
cart dependencies for local tests. Explicit founder approval and a separately
reviewed cart surface are required before opening production. Never use a
production flag change or a JSON `live` override as a test shortcut.

**Emergency lock:** the JSON `development` override locks that handle's lifecycle
resolution. Either `PUBLIC_COMING_SOON` other than `0` or checkout writes
other than `1` closes cart POSTs before catalog access. Review the deployed
configuration rather than relying on a hidden button.
Production configuration or content changes still require authorized deployment.

## Gatekeeping

Only repository admins/maintainers can change topics; contributor pull requests
must not trigger automation that writes them. The documentation does not grant
permission to change topics, catalog policy, deployed flags or checkout.
