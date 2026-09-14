# Storefront compliance requirements (opendrone.be)

Reference for anyone building or reviewing the store. It lists the EU and Belgian requirements the storefront itself must satisfy: product-listing content, consumer-law machinery, privacy/cookies, tax display, shipping policy, and sales restrictions. Incutec BV is an EU-established manufacturer selling B2C and B2B and shipping from Belgium, so the store carries the manufacturer and seller obligations directly.

This is the storefront-facing subset. OpenDrone product-conformity records remain internal to the private compliance repository and are out of scope here.

## 1. Product-listing content (GPSR, Reg (EU) 2023/988)

Every product listing must show, before purchase:
- Manufacturer identity: Incutec BV, plus a postal address and an electronic (email) contact.
- Product identifiers: type, and batch or serial reference where applicable.
- At least one product image.
- Any safety warnings and safety information, in the language of the target market (NL and FR for Belgium; add DE for the German market).

Build these as required fields in the product template so a listing cannot publish without them.

## 2. Consumer distance-selling (Belgian WER Boek VI, CRD 2011/83, guarantee 2019/771)

- **14-day right of withdrawal** from delivery, no reason required. Provide the model withdrawal form.
- **Withdrawal button.** A one-click "withdraw from contract" control on the online interface is legally required (in force since 19 June 2026). It must be available throughout the withdrawal period, lead to a confirmation page, and produce a durable-medium acknowledgment.
- **Withdrawal exceptions are narrow.** A standard catalogue kit is NOT exempt just because it is assembled or soldered; it is only exempt if built to an individual customer's specification. Opened electronics can still be returned; the customer is liable only for diminished value beyond what is needed to establish the product's nature and functioning. State this in the return policy rather than refusing returns.
- **2-year legal conformity guarantee.** Belgium applies the full 2-year reversal of the burden of proof. This is separate from any commercial warranty and cannot be contracted away for consumers. Include the digital-elements/firmware-update conformity clause.
- **Mandatory pre-contract information** on the offer and at checkout: trader identity plus geographic and electronic address, total price including taxes and all shipping/handling, payment and delivery arrangements, the withdrawal right plus model form, the legal guarantee, and complaint handling.
- Do not link the EU ODR platform (discontinued 20 July 2025). Point consumers to the Belgian Consumentenombudsdienst instead.
- Provide at least two substantially different delivery methods (Art. VI.45/2 WER).
- **Pre-orders.** A pre-order product must state its expected ship date on the product page, in the cart and on the order confirmation; that date is the agreed delivery time (Art. VI.43 WER), so it must be stated, not implied. The full price is charged at order, and withdrawal (before delivery or within 14 days after it) is refunded in full within 14 days. The shipping policy carries the wording.

### Required legal pages
Terms and conditions, privacy policy, cookie policy, return/refund policy, and the withdrawal form. Replace any auto-generated storefront defaults with the reviewed Incutec versions.

## 3. Privacy and cookies (GDPR, Belgian DPA/GBA)

- Privacy policy stating legal bases: order fulfilment and shipping = contract; newsletter = consent (double opt-in).
- Keep data-processing agreements with the storefront platform, payment provider, email tool, and analytics.
- **Cookie consent must meet the strict Belgian standard:** a reject-all button on the first layer with equal prominence to accept-all; no cookie walls; analytics/measurement cookies require consent (no legitimate-interest shortcut); granular per-purpose consent; easy withdrawal. Prefer a consent-mode CMP, or a cookieless analytics option to reduce surface.
- Electronic marketing to consumers is opt-in.

## 4. VAT and pricing

- Display prices to consumers inclusive of tax.
- Charge Belgian VAT (21%) on EU consumer sales until the EU-wide distance-sales threshold is crossed, then destination-country VAT under the Union One-Stop-Shop. Wire the tax engine so it flips to destination rates at the threshold.
- B2B intra-EU: support reverse charge with VAT-number capture and VIES validation (zero-rated intra-community supply).
- Non-EU orders: exports are VAT zero-rated; the customer pays local import VAT and duty. State the incoterm at checkout (DAP by default, or DDP if Incutec pre-pays duties) so there are no surprise-charge disputes.

## 5. Sales restrictions (sanctions and export)

- Block shipping destinations under EU sanctions at checkout: Russia, Belarus, Iran, Syria, North Korea, Cuba, and Crimea/occupied territories. Keep the blocked-country list maintainable.
- Screen orders against EU restricted-party lists.
- For B2B orders to buyers outside the EU (excluding close-partner countries), the contract terms must carry the mandatory "no re-export to Russia" clause and, above the review threshold, capture an end-use statement.
- Publish the civilian-only end-use policy and reference it in the terms.

## 6. Shipping policy

- **No loose lithium batteries.** Kits ship battery-free; the listing points the customer to a compatible battery. Loose LiPo packs are dangerous goods that the ordinary parcel stream will not carry, so they are out of scope for the store.
- Non-battery items (boards, chargers without cells, accessories) ship normally.
- Offer the two required delivery methods and show carrier, cost, and delivery time before checkout.

## Sources

- GPSR: Regulation (EU) 2023/988.
- Consumer rights: CRD 2011/83 (incl. 2023 modernisation, withdrawal button in force 19 Jun 2026), guarantee Directive 2019/771, Belgian Wetboek van Economisch Recht Boek VI and Boek IX.
- Privacy: GDPR (EU) 2016/679; Belgian DPA cookie guidance.
- VAT: EU One-Stop-Shop and distance-sales rules.
- Sanctions/export: Reg (EU) 833/2014 (incl. Art. 12g), Dual-Use Reg (EU) 2021/821.
- Lithium shipping: ADR SP188 / IATA lithium-battery rules; carrier acceptance conditions.
