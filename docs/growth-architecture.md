# Growth architecture (analytics, attribution, mail)

The growth stack as implemented. Verify against the source and tests; this
document is not a task tracker.

## Data spine

```
utm_* on inbound links we control
  -> Plausible (cookieless aggregate; no consent banner needed)
  -> first-touch UTM in sessionStorage (session-scoped, not persistent)
  -> Plausible props on every funnel event, including the Checkout Click
     fired as the visitor leaves for the shop
  -> first add to cart of the session: cart attributes `_ref`,
     `_utm_source`, `_utm_medium`, `_utm_campaign`, `_landing`
  -> Shopify order note attributes (same keys)
  -> orders/paid webhook: Plausible `Purchase` with revenue (gated)
  -> scripts/attribution-report.mjs: paid orders by ref and utm_source
newsletter signup -> Shopify (single opt-in, consent recorded there)
```

Shopify holds every order and customer record, including its attribution;
this repository keeps no subscriber or order data.

## Modules and routes

- `app/lib/growth/plausible.ts`: `trackEvent`, the client funnel events below.
- `app/lib/growth/attribution.ts`: first-touch capture in `sessionStorage`;
  `ref=<slug>` is kept as `ref` and is the `source` fallback when no
  `utm_source` is given. `postCart` (`app/lib/cart-client.ts`) sends the
  record as `attr_*` fields with the session's first add; the cart action
  validates them (`cartAttributesFromForm`) and writes them as cart
  attributes, best effort: a failed write never fails the add.
- `app/lib/growth/checkout-beacon.ts`: `trackCheckoutClick`, one helper so
  every checkout entry point fires the same event shape.
- `app/lib/growth/shopify-newsletter.ts`: the footer signup
  (`app/components/NewsletterSignup.tsx`, action in
  `app/routes/newsletter._index.tsx`) records email marketing consent on the
  Shopify customer through the Admin API; Shopify owns consent and
  unsubscribing. An existing opt-out is preserved, never resubscribed.
- `app/lib/growth/welcome-email.ts`: the welcome mail for an address that
  joined on this call, sent through Resend.
- `app/lib/growth/plausible-server.ts`: server-side `Purchase` event, sent
  by `app/routes/api.shopify.orders-paid.tsx` while
  `PLAUSIBLE_PURCHASE_EVENTS_ENABLED=1`. It forwards the buyer's browser
  IP and User-Agent from the order (Plausible drops events from server
  addresses), skips test orders, and dedupes per order through the Cache
  API, best effort per Cloudflare location.
- `scripts/attribution-report.mjs`: read-only report of paid orders since a
  date, by `_ref` and `_utm_source`; the count of record for sales per
  creator.
- `scripts/launch-blast.mjs`: product mail to the `notify-<handle>` Resend
  segment collected before the signup moved to Shopify. Dry run by default;
  `--send` is the only path that mails anyone.

Removed with the Upstash Redis migration, because nothing read or wrote them
any more: the signup ledger, the order-attribution record, the checkout-click
counter and its `/api/track/checkout` route, the notify-signup micro-survey,
and the back-in-stock broadcast.

## Plausible events

Client, all carrying the first-touch `source` prop folded to the canonical
vocabulary below plus `other` and `direct`, and `ref` (the creator slug)
when the visit came from a creator link: `PDP View` (product), `Variant
Select` (product, variant), `Stack Toggle` (product, partner, surface), `Add
to Cart` (product, sku, line value as revenue), `Checkout Click` (cart value
as revenue), `Notify Signup` (product). `Add to Cart` fires when a line is
added; `Checkout Click` fires from the checkout button in the added-to-cart
dialog or on `/cart`, as the visitor leaves for Shopify checkout. The cart
view is the `/cart` page view.

Server: `Purchase` (order total as revenue; props source, ref, campaign,
country, skus) from the orders/paid webhook.

## Constraints

- Preorders are charged in full and shipped on their batch's promise.
- Order and customer data stays in Shopify; so does newsletter consent.
- No consent banner: Plausible is cookieless and first-touch storage is
  sessionStorage-only, disclosed as functional in the cookie policy.

## Canonical UTM values (lowercase, exactly these)

- `utm_source`: youtube, discord, reddit, bardwell, newsletter, x
- `utm_medium`: video, social, chat, email
- `utm_campaign`: `launch-<sku-handle>`, `video-<slug>`, or `evergreen`
- Creator links use `?ref=<slug>` (lowercase letters, digits, `-`, `_`, at
  most 32 characters). The slug is the `source` fallback (event props fold
  it to `other`) and its own `ref` prop and `_ref` order attribute.
