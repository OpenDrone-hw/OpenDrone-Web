# Growth architecture (analytics, attribution, email, ledger)

Implemented architecture of the growth stack. Verify behavior against the
current source and tests; this document is not a task tracker.

## Data spine

```
utm_* on inbound links we control
  -> Plausible (cookieless aggregate; no consent banner needed)
  -> first-touch UTM in sessionStorage (session-scoped, not persistent)
  -> Plausible props on every funnel event, including the Checkout Click
     fired as the visitor leaves for the shop
  -> (order attribution: not wired. The cart attributes that carried UTMs
     into Shopify orders died with the Shopify cart; Odoo posting order
     events to the ledger is phase 6, an incutec_growth module.)
notify signup -> Upstash ledger + Resend contact upsert (notify-<handle>
  segment) + welcome email (waitUntil)
```

## Modules and routes

- `app/lib/growth/ledger.ts`: sole owner of Upstash key shapes.
  `sig:<email>` signup/profile record (merge, don't clobber), `ord:<order_id>`
  attributed order, `att:idx` append-only export index. RtbF = DEL the sig key
  plus Resend contact delete.
- `app/lib/growth/attribution.ts`: first-touch capture; `ref=<source>` folds
  into `utm_source`.
- `app/lib/growth/resend.ts`: marketing client (global Contacts +
  `notify-<handle>` Segments). `app/lib/support/email.ts` is transactional
  support mail and stays separate.
- `app/lib/growth/survey-token.ts` + `app/routes/api.survey.tsx`: post-signup
  micro-survey, short-lived HMAC token gate, rate-limited.
- `app/routes/newsletter._index.tsx` action: signup pipeline described above.
- `app/lib/growth/back-in-stock.ts`: the restock broadcast, kept whole and
  waiting for a caller. Its Shopify `inventory_levels/update` receiver is
  deleted; the Odoo restock event is phase 6.
- `scripts/launch-blast.mjs`: Resend broadcast for launch emails, dry-run by
  default.

## Plausible events

Client (via `trackEvent` in `app/lib/growth/plausible.ts`, all carrying the
first-touch `source` prop, folded to the canonical vocabulary below plus
`other`/`direct`): `PDP View` (product), `Variant Select` (product,
variant), `Stack Toggle` (product, partner, surface), `Add to Cart`
(product), `Checkout Click` (+ line total as revenue), `Notify Signup`
(product), `Survey EU Premium` / `Survey Interview` (answer). Every buy
click fires both `Add to Cart` and `Checkout Click`: it is one click, and it
leaves the site for the shop.

Server (`app/lib/growth/plausible-server.ts`): `Purchase` (source, campaign,
+ order total as revenue) has no sender. It was fired by the Shopify
orders/paid webhook; the Odoo order event that would replace it is phase 6.
The helper and its dedup (`pev:<order_id>` claim plus the `purchaseEventAt`
stamp on the `ord:` record) are kept for it.

Checkout-abandonment counter without Plausible Business: the checkout CTA
beacons `/api/track/checkout`, which increments the ledger's `chk:<day>`
counter; buy-rate = `ord:` count / `chk:<day>`. Full model + the maintainer's
Plausible UI goal/funnel checklist: `drafts/analytics-brief.md`.

## Constraints (decided, do not relitigate in code)

- Pre-orders are the launch model (ERP decision D4): charged in full, shipped
  on the product's own promise. The 2026-07-06 "no pre-orders" note is
  superseded.
- Email joins come from our own `sig:` records. The shop's order data stays in
  Odoo; anything the ledger needs from it arrives as an explicit event, never
  as a customer record copied across.
- No consent banner: Plausible is cookieless and first-touch storage is
  sessionStorage-only, disclosed as functional in the cookie policy.
- OpenBrain becomes the durable CRM only after EU hosting + DPA review; until
  then the Upstash ledger is the system of record
  (`drafts/archive/openbrain-crm-scope.md` holds the buildout scope).

## Canonical UTM values (lowercase, exactly these)

- `utm_source`: youtube, discord, reddit, bardwell, newsletter, x
- `utm_medium`: video, social, chat, email
- `utm_campaign`: `launch-<sku-handle>`, `video-<slug>`, or `evergreen`
- Short links may use `?ref=<source>`; the site folds it into `utm_source`.

Ready-to-paste link templates: `drafts/archive/utm-conventions.md`.
