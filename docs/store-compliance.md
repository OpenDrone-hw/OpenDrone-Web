# Storefront acceptance

The private [launch plan and knowledge index](https://github.com/incutec-org/operations/blob/main/projects/opendrone/README.md)
own the launch sequence and sourced regulatory references. Product conformity
and signed declarations belong to the compliance repository. This file owns
only the storefront evidence a release review must inspect.

| Surface | Acceptance evidence |
| --- | --- |
| Offer | Correct product identity, seller, safety information and languages, total price and supportable claims |
| Preorder | Same batch, target deadline and separate final delivery commitment on the offer, cart and durable confirmation |
| Destination | Explicit approved EU country in configuration; server checkout gate and final Shopify address restriction both exercised |
| Payments | Provider-approved business model, supported methods, capture, payout and cancellation/refund rehearsal |
| Withdrawal | Accessible online submission, confirmation and durable acknowledgement, tested with controlled recipients |
| Prices and tax | Reviewed price presentation, tax-inclusive totals and accepted destination VAT treatment |
| Fulfilment | Held preorder, authorised release, accepted label, tracking and reconciliation, including mixed and refunded orders |
| Privacy and interest | Consent, unsubscribe and failure states; no fabricated retail availability or sales evidence |
| US enquiries | No consumer checkout or automatic order; receiver exclusion and country/SKU validation on the server |

Evidence is attached to the existing release tasks, not copied into a second
checklist here. A local build does not establish payment-provider acceptance,
carrier service or product conformity. Release commands and source locations
are in the [README](../README.md#preorder-release-configuration).
The [superseded brief](archive/2026-09-23-store-compliance.md) is historical.
