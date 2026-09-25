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
newsletter signup -> Shopify (single opt-in, consent recorded there)
```

Order attribution is not wired: the Shopify orders webhook that used to post
orders into a ledger is gone (`app/routes/api.webhooks.shopify.tsx` answers
410) and nothing replaces it. Shopify holds every order and customer record;
this repository keeps no subscriber or order data.

## Modules and routes

- `app/lib/growth/plausible.ts`: `trackEvent`, the client funnel events below.
- `app/lib/growth/attribution.ts`: first-touch capture in `sessionStorage`;
  `ref=<source>` folds into `utm_source`. Read for event props, never
  persisted server-side.
- `app/lib/growth/checkout-beacon.ts`: `trackCheckoutClick`, one helper so
  every checkout entry point fires the same event shape.
- `app/lib/growth/shopify-newsletter.ts`: the footer signup
  (`app/components/NewsletterSignup.tsx`, action in
  `app/routes/newsletter._index.tsx`) records email marketing consent on the
  Shopify customer through the Admin API; Shopify owns consent and
  unsubscribing. An existing opt-out is preserved, never resubscribed.
- `app/lib/growth/welcome-email.ts`: the welcome mail for an address that
  joined on this call, sent through Resend.
- `app/lib/growth/plausible-server.ts`: server-side `Purchase` event helper.
  Its only sender was the retired orders webhook, so nothing calls it.
- `scripts/launch-blast.mjs`: product mail to the `notify-<handle>` Resend
  segment collected before the signup moved to Shopify. Dry run by default;
  `--send` is the only path that mails anyone.

Removed with the Upstash Redis migration, because nothing read or wrote them
any more: the signup ledger, the order-attribution record, the checkout-click
counter and its `/api/track/checkout` route, the notify-signup micro-survey,
and the back-in-stock broadcast.

## Plausible events

Client, all carrying the first-touch `source` prop folded to the canonical
vocabulary below plus `other` and `direct`: `PDP View` (product), `Variant
Select` (product, variant), `Stack Toggle` (product, partner, surface), `Add
to Cart` (product), `Checkout Click` (line total as revenue), `Notify Signup`
(product). `Add to Cart` fires when a line is added; `Checkout Click` fires
from the checkout button in the added-to-cart dialog or on `/cart`, as the
visitor leaves for Shopify checkout.

## Constraints

- Preorders are charged in full and shipped on their batch's promise.
- Order and customer data stays in Shopify; so does newsletter consent.
- No consent banner: Plausible is cookieless and first-touch storage is
  sessionStorage-only, disclosed as functional in the cookie policy.

## Canonical UTM values (lowercase, exactly these)

- `utm_source`: youtube, discord, reddit, bardwell, newsletter, x
- `utm_medium`: video, social, chat, email
- `utm_campaign`: `launch-<sku-handle>`, `video-<slug>`, or `evergreen`
- Short links may use `?ref=<source>`; the site folds it into `utm_source`.
