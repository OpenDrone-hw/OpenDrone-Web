# Selling

Open or close the shop, run a preorder campaign, fulfil a batch and mail buyers.


## Open or close the shop

Both gates must be open for checkout; closing either one closes it.

| Setting | Where | Open | Closed |
|---|---|---|---|
| `PUBLIC_COMING_SOON` | `wrangler.production.toml` `[vars]` | `"0"` | anything else: coming-soon pages, no prices |
| `SHOPIFY_CHECKOUT_WRITE_ENABLED` | `wrangler.production.toml` `[vars]` | `"1"` | anything else: cart POSTs refused, `/cart` redirects |
| `PUBLIC_US_SALES` | `wrangler.production.toml` `[vars]` | `"1"` and a number in `content/us-sales.json` `rate` | anything else: the US buys through shops and reads "Not shipping to the US yet." |
| `SHOPIFY_PREVIEW_POLICY_JSON` | Worker secret | `preorder` (campaign SKUs, `shipPromise: null`) or `in_stock` per SKU for sale | `sold_out` with `shipPromise: null` |
| `SHOPIFY_CHECKOUT_DOMAIN` | Worker secret | the host of Shopify's checkout links | not needed |
| `SHOPIFY_PRICE_TIER_WRITE_ENABLED` | Worker secret | `"1"` while a campaign steps prices | anything else |
| `SHOPIFY_WEBHOOK_SECRET` | Worker secret | the signing secret of the app that registered the `orders/paid` webhook to `/api/shopify/orders-paid` | not needed |

The gates change by a PR to `wrangler.production.toml` (a merge deploys it);
secrets change with `wrangler secret put <NAME> --config
wrangler.production.toml`. A JSON `status: development` in
`content/products/<handle>.json` locks one product without closing the shop.

An open shop also depends on Shopify settings this repository cannot check:

| Shopify setting | Holds when |
|---|---|
| Payments active, automatic capture | a test order is paid, captured and refunded |
| Admin API token scopes | `read_orders`, `read_all_orders` (campaigns over 60 days), `write_orders`, `write_products`, `write_merchant_managed_fulfillment_orders`, `read_shipping` (international shipping figure) |
| Markets and shipping profiles | delivery countries need active markets and accepted shipping rates |
| Local pickup on the "OpenDrone Leuven" location | free pickup is offered at checkout; the cart mentions it for Belgium (`PICKUP_COUNTRIES` in `app/lib/shipping-rates.ts`) and `/shipping` describes it. A pickup order has no shipping address and counts as region EU |
| Redirect theme published | the Shopify-hosted storefront forwards to opendrone.be |
| Online Store password page off | checkout opens for customers, not only staff |

After any change: `BASE=https://opendrone.be node scripts/smoke.mjs` and
`curl -H "Authorization: Bearer $CAMPAIGN_STATUS_TOKEN" https://opendrone.be/api/status/campaign`.

### US preorders

`PUBLIC_US_SALES="1"` plus the US flat rate (USD) in `content/us-sales.json`
open the US; with either missing the US stays on retailer enquiries and every
page renders as before. Open:

| Surface | US buyer (destination US) | EU buyer |
|---|---|---|
| Destination | `shippingQuote` zone `us`, rate from `us-sales.json` | unchanged |
| Prices | the US catalog's USD list price: duties included, no sales tax. The price steps list shows USD too (see "US prices" below) | EUR incl. VAT |
| Counter | "0 / 250 ordered for the March 2027 batch": same sentence and bar as the EU, counting the highlighted batch | "1 / 250 ordered for batch 1" |
| Batches | one row per batch in batch order in both regions (`app/lib/availability.ts`, `app/components/Availability.tsx`): batch 1 "EU and international, not the US" first, the March 2027 batch "EU, US and more" second; the buyer's batch is highlighted (US: March 2027, with batch 1 tagged "Not available in the US"; EU: batch 1 while units remain); other products one March row | batch 1 highlighted, March 2027 batch below |
| Refund line | "If we cannot deliver to you, you get a full refund." (terms 7ter.5, US only) | none |
| Sells | everything for sale: campaign SKUs from their first US-serving batch, every other SKU (in stock, accessories) as a preorder of `usStock` in `content/preorders.json` (March 2027 batch). Sold out stays sold out | everything for sale |
| Batch | first batch with room whose `regions` include US | first with room whose `regions` include EU |
| Cart | `buyerIdentity.countryCode` US, hidden `_ship_region: US` line attribute | unchanged |

The destination is `resolveCountry` in `app/lib/shipping-rates.ts`, in this
order: a blocked IP country, a `?country=XX` link, the `od_ship_country`
cookie (the header control or the cart's Ship to), `CF-IPCountry`, else
unknown; the browser language is never read. A page load with `?country`
stores it in the cookie and redirects to the URL without it, so a link never
outranks a later pick. The page, the cart, the line promise and the checkout
gate all read it (`buyerCountry`, `geoCountryForRequest`); the root loader's
`region` (`app/lib/region.ts`) is the typed answer components read: market
(EU, US, UK / CH / NO, rest of world, none), currency, taxes shown, lanes and
shipping. Countries Shopify has no market or zone for (`NO_SHOPIFY_ROUTE`,
`npm run check:reach`) read "Not shipping to <country> yet" with the launch
signup instead of a checkout that dead-ends. The hold
pass tags an order `promise-mismatch` when it ships to another region than a
line's promise was computed for, and holds and tags `us-review` every order
shipping to the US with a line no US-serving batch carries (a line from an EU
cart, for example: checkout accepts any address in an open market). A US line
(`_ship_region` US) for a SKU the campaign does not list takes the `usStock`
batch tag.
`release-batch.mjs` never releases a `us-review` order; follow both up by
hand.

The cart line and the checkout line property `Availability` carry the same
words as the product page ("Batch 1 · EU and international, not the US", "March 2027 batch · EU, US and
more"; `batchText` in `app/lib/availability.ts`, words from
`content/copy/preorder.json`). Product pages are English only; the legal terms
(art. 7bis) are unchanged.

#### US prices

A US price is the EUR VAT-inclusive price plus `priceUpliftPct` in
`content/us-sales.json` (25), converted at Shopify's FX rate and rounded up to
whole dollars. The uplift covers US duties and import handling; no US sales tax
is collected. Shopify prices it: the price list "United States USD, duties
included (+N%)" has a `PERCENTAGE_INCREASE` parent adjustment and no fixed
prices.

The storefront shows every price step in USD. The step the next unit falls
into is Shopify's live US price. The other steps are their EUR prices through
the EUR to USD factor band that the live EUR/USD pairs of the whole catalog
allow (`usdBand` in `app/lib/us-sales.ts`); a step is shown as "about US$X"
when that band cannot fix its whole dollars, and no ladder is shown when no
factor fits the live prices.

To change the US uplift end to end:

1. Edit `priceUpliftPct` in `content/us-sales.json`.
2. `npm run us:prices` (dry run: prints the file value and the Shopify price
   list, changes nothing), then `npm run us:prices -- --apply` to write the
   adjustment and the "(+N%)" name suffix, with a read-back. It reads
   `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_ADMIN_API_TOKEN` (`write_products`) and
   `SHOPIFY_ADMIN_API_VERSION` from `.env`.
3. Merge the file change, then `BASE=https://opendrone.be node scripts/smoke.mjs`.

Shopify settings the US needs (the US market, its USD price list and
`INCLUDES_TAXES_IN_PRICE` exist): a US shipping zone at the `us-sales.json`
rate, and HS codes and country of origin on every variant.

### International preorders

Other permitted destinations use allocation region `INT`; GB, CH and NO use
`NEAR` (`IMPORT_COUNTRY_CODES`), the same March batch with the duties line.
Batch-1 paid stock of FC and ESC serves the EU only (`paidRegions` in
`content/preorders.json`); `NEAR`, `INT` and US buyers
take the March batch, including the existing `usStock` rule for otherwise
unlisted accessories. A non-EU line that recorded batch 1 before then keeps
it (`grandfatheredPaidLine`, read from its `_batch`/promise and `_ship_region`
line attributes).
The selected country supplies Shopify's catalog prices, cart market and currency.
A null shipping preview means the charge is confirmed at checkout, never free.
Before checkout, the cart and the added-to-cart drawer show "from X, confirmed
at checkout": the cheapest active rate of the destination's Shopify shipping
zone whose weight range holds the cart's product weight
(`app/lib/international-shipping.ts`, read from the Admin API and reused five
minutes per isolate). It falls back to "Shipping calculated at checkout" when
the figure could differ from checkout: more than one delivery profile, a
carrier or price-conditioned rate, a variant without a weight, a currency
other than the rate's, or a failed read.
Import charges outside the EU and US are not included by the storefront promise.
`deliveryByINT` is a separate arrival deadline and never falls back to EU dates.

An address changed inside native checkout is checked again against the actual
paid order. Missing or incompatible region promises stay held with
`international-review` and/or `promise-mismatch`; batch release cannot clear
those tags automatically. An earlier accepted promise is not silently extended.

## Run a preorder campaign

| Source | Owns |
|---|---|
| `content/preorders.json` | `countFrom`, `endsOn`, `confirmed`, `afterEndsOn`, `soldUnder`, `shipsBy`, `priceTiers`, `pendingShips`, `paidRegions`, `stockFrom` (where stock is held, per locale), per-SKU `batches` (`units`, `reserved`, `paid`, `inStock`, `ships`, `deliveryBy`, `deliveryByUS`, `deliveryByINT`, `regions`) and `shipsWith` (`sku`, `batch`, `stock`, `after`) |
| `content/products/<handle>.json` | `status` (`idea` or `development`: announced, no cart button), `name`, `lineName` ("FC") and `skus`, which map each campaign SKU to its product |
| `content/registrations.json` | producer numbers and explicit `saleApproved` per EU destination |
| `content/us-sales.json` | the US flat shipping rate in USD (`null` keeps the US closed) and `priceUpliftPct`, the US price uplift (`npm run us:prices`) |
| Shopify | compare-at (retail) price, current price, catalog identity, orders, payments |
| `SHOPIFY_PREVIEW_POLICY_JSON` | overrides per SKU; a SKU it does not name follows `content/preorders.json` (`docs/architecture.md`, Catalog) |
| `app/content/legal/{en,nl,fr}/` | customer terms (7bis) |

1. Edit `content/preorders.json` (by hand or the studio Data tab): set
   `countFrom` to the first day whose paid orders count, the batches with
   `units`, `paid` and `ships` for ordered stock (plus `reserved` for units
   of it held back from sale), `endsOn`, `shipsBy` and `pendingShips`
   for funding batches, and `priceTiers`. `npm test` checks that
   `pendingShips` names `shipsBy`. A confirmed campaign leaves
   `pendingShips` out: the parser writes it from `shipsBy`, so the ship-by
   date is typed once.
2. In Shopify, set each campaign SKU's compare-at price to retail and its
   price to the first step. A SKU priced under its step stays closed.
3. Add the SKU to `skus` in its `content/products/<handle>.json` (a SKU in
   `content/preorders.json` that the policy secret does not name then sells
   as `preorder`), and set `SHOPIFY_PRICE_TIER_WRITE_ENABLED=1`.
4. Open the shop ("Open or close the shop") and check `/api/status/campaign`: every campaign SKU
   `open`, `allOpen: true`, no pending price step.

**Sales facts.** `app/lib/sales-model.ts` reads `content/preorders.json` and
the product files into one checked model: where stock is held and ships, which
product lines sell from stock or as a pre-order, the latest ship-by date and
the offer window. A bad entry stops `npm test`, the build and the dev server
with the file and field named. Copy names these facts as `{{stock_from}}`,
`{{stock_scope}}`, `{{stock_lines}}`, `{{preorder_lines}}`,
`{{preorder_month}}` and `{{preorder_ships_by}}`; `copy.ts` fills them in every
copy string, so no copy file types a date, a place or a product line.
`app/lib/sales-model.test.ts` shows the everyday changes as file edits.

**Confirmed batches.** `confirmed: true` removes the funding condition:
the promise is written from `shipsBy` ("ships by" and the date), the product
page and /preorder read "Batch confirmed" in place of a count toward a target,
every line of the batch ships together (one ship group) and no SKU closes for
a missed target. `afterEndsOn` is the one value for what the funding batches
do after `endsOn`:

| `afterEndsOn` | From the day after `endsOn` |
|---|---|
| `closed` | ordering stops (run `scripts/close-preorder-run.mjs --apply` so Shopify stops too) |
| `retail` (default) | ordering stays open at the retail price: `tiersFor` returns no step, the price writer sets retail |
| `earlyBird` | ordering stays open and the price steps keep running |

Changing it is a one-line edit of `content/preorders.json`. After the price
writer has set retail (it clears the compare-at price), going back to
`earlyBird` needs the compare-at prices set again in Shopify first.

`soldUnder` lists, oldest first, what orders created before each `before`
instant were promised (`pendingShips`, `paidShips`, `paidDeliveryBy`, and the
dates that differed). The account page, the hold pass and the notify script
read an order through `configSoldUnder`, so an order keeps the delivery date
it was sold with. A promise that still names a target ("... if the target is
reached by ...") is recognised as the same batch (`fundingPromise`) and reads
as confirmed. The last entry's `before` is the end of the publication day of
the current terms in Brussels: a test holds it to the version line of
`app/content/legal/en/algemene-voorwaarden.md`, so set both on the publish day.

`inStock: true` on a paid batch: its units are on hand in Belgium. Its `ships`
names no month ("in stock in Belgium, ships to EU addresses in a few working
days"), it has no `deliveryBy`, and its lines never carry a `Preorder`
property (checkout and the confirmation read "Shipping: In stock in Belgium,
ships in a few working days.").

Every funding-target unit ships by the one `shipsBy` date, however early
its target is reached. A SKU's last batch has no end when it is a funding
target: once its `units` are ordered, every later unit ships with it, with
no new target and no cap. A reached funding target: place the supplier
order, then set that batch's `ships`. An accessory with `stock` sells that
many units with its dated `batch`, then ships with the lead's `after`
batch; set `stock` from the on-hand stock read in InvenTree at the time of the change. The storefront keeps dispatch promises separate from arrival deadlines.
`deliveryBy`, `deliveryByUS` and `deliveryByINT` supply the visible `Delivery by`
checkout property, cart and confirmation, and order the lines of a combined cart. A batch with `regions` (`["EU", "INT"]` for paid stock in Belgium) takes
only units shipping there: each paid unit takes the first batch with room
that serves its order's shipping region (EU, US or INT), so a US unit skips a
batch that does not serve the US. Paid stock goes only to orders whose every line ships with it: an order that also holds a motor, frame, receiver, prop or any other March item belongs entirely to the first funding batch, boards included (`shipsOnlyWithPaid`, the `march` flag on `UnitRuns`). Funding targets count every region and every paid unit, so a mixed order's boards count toward the funding batch at once, and the price step keeps counting one ladder of all paid units. A price step counts what
the product page step bar shows an EU buyer (`tierUnits` in
`app/lib/preorder-campaign.ts`): the batches the EU buyer has seen sell out
plus the units in their current batch, so units in a batch the EU buyer cannot
get never move the price. Shopify holds one price per variant, so every region
pays that step. The dates in
the ship promises, terms and product notes derive from `endsOn`, `shipsBy`,
`deliveryBy`, `deliveryByUS` and `deliveryByINT` in this file; `app/lib/preorder-campaign.test.ts`
fails when the committed copy and legal text drift from it. A producer
number alone does not open a destination; `saleApproved` does, after its
evidence is reviewed. The strategy behind a campaign lives in
the team's private knowledge base, not here.

**Close the run at `endsOn`.** Only when `afterEndsOn` is `closed`, or the
campaign is not `confirmed` (otherwise the script reports nothing to close).
The storefront stops selling a funding-batch
unit after `endsOn`, but Shopify does not: an old checkout link or an
abandoned-checkout recovery mail can still complete an order. After the end
of `endsOn` (Europe/Brussels):

1. `node --experimental-strip-types scripts/close-preorder-run.mjs` lists the
   SKUs whose next EU unit waits for a funding target, with each variant's
   Shopify inventory policy, and the SKUs that keep selling paid stock or a
   dated batch. It names any variant that DENY cannot stop (inventory not
   tracked, or stock on hand).
2. Run it again with `--apply`: it sets those
   variants' inventory policy to DENY. It refuses `--apply` before `endsOn`
   has ended and writes nothing else.

## Buy now or pre-order

`BATCH_CHOICE` is `"1"` in `wrangler.production.toml` (with `choiceFrom` set in `content/preorders.json`) and `"0"` in `wrangler.toml`. Off, the site reads and sells exactly as it does without this section.

On (`BATCH_CHOICE = "1"`), each of the four boards (OpenFC Lite and OpenESC, 20x20 and 30x30) sells two ways:

| Offer | Shopify variant | Price | Ships | Where | Limit |
| --- | --- | --- | --- | --- | --- |
| Buy now | `<Model> / Buy now` | retail | in a few working days from Belgium | EU only | units left in batch 1 (`paidLeft`), and Shopify denies the sale at zero stock |
| Pre-order | `<Model> / Pre-order` (the variant the board always had) | the pre-order price | with the March batch | every region | none |

Both variants carry the board's one SKU string, under a Shopify option named `Batch`. `mapShopifyCatalog` folds the pair into one catalog entry and still throws on any other duplicate, unpaired or unknown SKU. `applyCampaign` makes Buy now the entry's offer for an EU buyer while stock is left (with the pre-order beside it as `preorder_offer`); for everyone else the board is a pre-order from the March batch.

| Surface | What shows |
| --- | --- |
| Board product page | two cards, one button named after the chosen card; the saving is stated only where pre-ordering is cheaper |
| Home and product page build block | one block per drone size: "Buy now" is the FC and ESC stack, "Pre-order" the full build with every line added as a pre-order (`offer=preorder`) |
| Cart | each line says "Ships now" or "Pre-order, <month>" |

The cart rule (`batchChoiceConflict` in `app/lib/shopify-cart-action.ts`): a Buy now board together with a March item cannot be checked out. The cart offers "Keep everything in one order" (intent `keep-together`: each board line moves to its Pre-order variant, so Shopify charges the pre-order price) or "Check out the in-stock items first" (the March lines are set aside). Shopify binds the price to the variant, so no cart edit gets a ships-now board at the pre-order price.

Counting: from `choiceFrom` in `content/preorders.json` on, an order line whose recorded variant title names `Pre-order` is a March unit and makes its whole order a March order (`preorderChoiceLine`); `Buy now` lines and every earlier order take batch 1 as before. The hold pass writes the same `batch:<sku>:<n>` tags, so the shipping tool needs no change. The price-step writer skips `Buy now` variants.

Turning it on, in this order: this code live with the flag off; the `Buy now` variants created in Shopify; then one PR that sets `BATCH_CHOICE = "1"` in `wrangler.production.toml` and `choiceFrom` (the UTC instant of that deploy) in `content/preorders.json`. `app/lib/batch-choice.test.ts` fails if one is set without the other.

## Fulfil a batch

Paid preorder orders stay on hold until their batch is released. Verify in
the shipping integration that held orders cannot produce a label. The bpost
Shopify plugin attempts a label when an order is created, before the preorder
hold is applied; a failed attempt is mailed from `notify@bpost.be` to the
store owner's address. When a batch arrives:

1. `node --experimental-strip-types scripts/release-batch.mjs --sku <SKU> --batch <N>`
   lists the held orders tagged `batch:<SKU>:<N>`: the ones that ship now, and
   the ones that still wait for another batch in the same order (an order
   ships as one parcel). Add `--with <SKU>:<N>` for any other batch that is
   also in stock, or settled because its item was refunded or the buyer chose
   to wait.
2. Run it again with `--apply`. It releases the preorder hold on each order
   that ships now. Nothing else changes.
3. In the bpost plugin, import the released orders and print the labels.
4. Pickup orders are not labelled. A buyer who chose "OpenDrone Leuven" at
   checkout gets Shopify's ready-for-pickup mail once the order is marked
   ready in Shopify admin. A shipping order the buyer asked to collect
   instead carries the `pickup-leuven` tag and an order note: Shopify cannot
   switch it to pickup, so the script keeps it held ("waits for
   pickup-leuven"). Refund its shipping line in Shopify admin, hand it over
   with the buyer's pickup order, then release the hold and mark it
   fulfilled there without notifying the buyer.

The script reads the Shopify Admin credentials from `.env` and never prints
them. An order with an item that missed its ship-by date is released once that
item is refunded in Shopify admin: a line with nothing left to ship no longer
holds the order back.

## Tell buyers

Terms 7bis.3 and 7bis.3bis promise an email when a ship date moves and when an
item has not shipped by its ship-by date (the March 2027 batch is confirmed,
so there is no funding target to miss). `scripts/preorder-notify.mjs` writes them per order,
in the buyer's language (English, Dutch or French):

- Ship date moved: `node --experimental-strip-types scripts/preorder-notify.mjs --kind moved --sku <SKU> --batch <N> --new-date "<date>" --new-date-nl "<datum>" --new-date-fr "<date>"`.
- Not shipped by `shipsBy`: `--kind missed --sku <SKU> --batch <N> --new-date "<new ship date>"`.
  The email offers a refund or to wait, and states the 30-day reply deadline
  after which the item is refunded.

Without `--send` it prints every email and sends nothing. With `--send` it
sends through Resend from `SUPPORT_FROM_EMAIL` with replies to
`PUBLIC_COMPANY_EMAIL`, and tags each order `notified-<kind>:<SKU>:<N>` (a
rerun skips those orders; `--again` resends). Record each answer with
`--record "#<order>" --sku <SKU> --choice refund|wait --apply`, which tags the
order `preorder-refund:<SKU>` or `preorder-wait:<SKU>`. Refunds are made in
Shopify admin.

## Preview emails

| Command | Does |
|---|---|
| `npm run emails:preview` | serves the gallery on `http://localhost:4321` (`-- --port N`); an edit to a body, fixture or builder shows in about a second |
| `npm run emails:build` | writes the gallery as one HTML file, images inlined, for sharing |

| Emails | Source | Scenario data |
|---|---|---|
| Shopify notifications (21 templates with a body: order, shipping, status, payment, account, return, staff new order) | `scripts/shopify-templates/`, built on the one shell `app/lib/email-shell.ts` (`<od-*>` macros in the bodies) | `scripts/emails/fixtures/*.json`, each merged over `_base.json` |
| Newsletter welcome, withdrawal receipt and shop notice, support reply notice | `app/lib/` builders | inline in `scripts/emails/catalog.mjs` |
| Preorder buyer update, launch broadcast ("Preorders are open", EU, US and combined copy; the same copy renders `scripts/emails/shopify-email-launch.md` for the Shopify Email draft) | `scripts/preorder-notify.mjs`, `scripts/launch-blast.mjs` | inline in `scripts/emails/catalog.mjs` |

Nothing is sent: the gallery calls the builders directly, and the withdrawal
mail gets a fetch stub. Each card shows the subject and preheader; a red
banner lists every unknown Liquid variable or filter, a Resend mail with
`undefined` or `null` in it, and a mobile frame that overflows 375 px.
`npm test` renders every Shopify template against every fixture with strict
variables (`app/lib/shopify-templates.test.ts`) and fails on the same
problems, or when `out/` is behind its sources.

Shopify has no Admin API or CLI for notification templates: they are edited
only in Shopify admin (Settings, Notifications, Edit code). The "Paste into
Shopify" table copies each template's HTML (what `gen:shopify-templates`
writes to `out/`) and its Liquid subject, and links its admin page. After a paste, `npm run emails:hash` prints the sha256 of what the repo holds: copy the "Email body (HTML)" field from Shopify admin into a file and compare `shasum -a 256` with it. Email dates are read from `content/preorders.json` by `app/lib/email-shell.ts`; the gallery watches that file too. Search the gallery by email or scenario, then filter by channel or audience. The notifications without a body (return created, return approved, draft order invoice, order invoice, payment reminder, order payment receipt, customer email change) keep Shopify's default because that default carries a label or link variable the repo cannot verify.

### Paste into Shopify admin

`npm run emails:paste` drives Shopify admin through a Chrome with remote debugging, so nothing is copied by hand. It never logs in, never types credentials, never toggles a notification and never sends mail.

1. `npm run emails:chrome` opens Chrome with profile `~/.incutec/chrome-shopify` on port 9222. Log into Shopify in that window once; leave it open.
2. `npm run emails:paste` is a dry run: per phase 1 template it prints the live body hash, the repo hash, whether the subject matches and the action needed.
3. `npm run emails:paste -- --apply` replaces body and subject, saves, reloads and verifies the hash. It stops on the first failure (`--continue` goes on); `--only key,key` limits the templates.

End to end for an agent: edit a body under `scripts/shopify-templates/bodies/`, `npm run gen:shopify-templates`, `npm test`, merge, then `npm run emails:chrome` and `npm run emails:paste -- --apply` (the dry run first). The only human step is the one-time Shopify login in that Chrome; exit code 3 means it is missing.

The store handle is `SHOPIFY_ADMIN_STORE_HANDLE` (default `ktjqug-jw`). Exit codes: 2 no Chrome on 9222, 3 the admin shows a login page.
