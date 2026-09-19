# Growth architecture (analytics, attribution, email)

Implemented architecture of the growth stack. Verify behavior against the
current source and tests; this document is not a task tracker.

Upstash Redis, a KV store this stack used to keep for a `sig:<email>`
signup ledger, an `ord:<order_id>` order-attribution record, and a
`chk:<day>` checkout-click counter, was removed entirely (founder decision,
2026-09-15). What follows describes the stack as it exists after that
removal, not before it.

## Data spine

```
utm_* on inbound links we control
  -> Plausible (cookieless aggregate; no consent banner needed)
  -> first-touch UTM in sessionStorage (session-scoped, not persistent)
  -> Plausible props on every funnel event, including the Checkout Click
     fired as the visitor leaves for the shop
  -> (order attribution: not wired. The Shopify orders webhook that used to
     post orders into a ledger record is gone (410, cart moved to Odoo);
     nothing replaces it today.)
notify signup -> Resend contact upsert (notify-<handle> segment) + welcome
  email on first signup (waitUntil)
```

## Modules and routes

- `app/lib/growth/resend.ts`: marketing client (global Contacts +
  `notify-<handle>` Segments) - the only subscriber store. `contactExists`
  is the newsletter action's first-signup signal (welcome email sends
  once); `app/lib/support/email.ts` is transactional support mail and
  stays separate.
- `app/lib/growth/attribution.ts`: first-touch capture; `ref=<source>` folds
  into `utm_source`. Read but not persisted server-side any more (Resend
  has no custom-property support on this account).
- `app/routes/newsletter._index.tsx` action: signup pipeline described
  above.
- `scripts/launch-blast.mjs`: Resend broadcast for launch emails, dry-run by
  default.

Removed with the Upstash migration, each because it had no live writer or
reader left, not because a replacement was built:

- The notify-signup micro-survey (`app/lib/growth/survey-token.ts`,
  `app/routes/api.survey.tsx`, the `NotifySurvey` panel in
  `NewsletterSignup.tsx`) - its answers had nowhere to persist without the
  ledger, and it had no consumer beyond the ledger record itself.
- `app/lib/growth/back-in-stock.ts` (the restock broadcast) - its cooldown
  latch was ledger-backed and it never had a caller (the Shopify
  `inventory_levels/update` receiver that would have called it is deleted;
  the Odoo restock event that would replace it is unbuilt).
- `app/routes/api.track.checkout.tsx` and its client-side beacon in
  `app/lib/growth/checkout-beacon.ts` - its numerator (`ord:` records) had
  already gone dead when the Shopify orders webhook was retired, and
  nothing ever read the `chk:<day>` counter on its own.

## Plausible events

Client (via `trackEvent` in `app/lib/growth/plausible.ts`, all carrying the
first-touch `source` prop, folded to the canonical vocabulary below plus
`other`/`direct`): `PDP View` (product), `Variant Select` (product,
variant), `Stack Toggle` (product, partner, surface), `Add to Cart`
(product), `Checkout Click` (+ line total as revenue), `Notify Signup`
(product). Every buy click fires both `Add to Cart` and `Checkout Click`:
it is one click, and it leaves the site for the shop.

Server (`app/lib/growth/plausible-server.ts`): `Purchase` (source, campaign,
+ order total as revenue) has no sender - it was fired by the Shopify
orders/paid webhook, which is gone (410). The helper is unused; nothing
calls it.

## Constraints (decided, do not relitigate in code)

- Pre-orders are the launch model (ERP decision D4): charged in full, shipped
  on the product's own promise. The 2026-07-06 "no pre-orders" note is
  superseded.
- The shop's order and customer data stays in Odoo; this stack's only
  subscriber record is the Resend contact, created from the
  consent-checked newsletter form.
- No consent banner: Plausible is cookieless and first-touch storage is
  sessionStorage-only, disclosed as functional in the cookie policy.
- OpenBrain becomes the durable CRM only after EU hosting + DPA review
  (`drafts/archive/openbrain-crm-scope.md` holds the buildout scope); until
  then Resend is the only subscriber store, and Odoo
  (`erp/addons/incutec_support`) is the support-ticket store.

## Canonical UTM values (lowercase, exactly these)

- `utm_source`: youtube, discord, reddit, bardwell, newsletter, x
- `utm_medium`: video, social, chat, email
- `utm_campaign`: `launch-<sku-handle>`, `video-<slug>`, or `evergreen`
- Short links may use `?ref=<source>`; the site folds it into `utm_source`.

Ready-to-paste link templates: `drafts/archive/utm-conventions.md`.
