# Batch 1 shipping rates (plan, not applied)

Batch-1 FC and ESC stock now serves the EU and the international zones, not the US (`content/preorders.json` `regions`). Shopify has one delivery profile ("General profile"). Its non-EU zones ("International preorder allowance N", one rate per weight band) are named "Preorder: ships by 31 Mar 2027, delivery by 30 Apr 2027", which is wrong for a batch-1 line that ships in November. The EU zones are named "Standard shipping (bpost)" and carry no date: the date promise lives on the line properties and the order, not on the rate.

Plan: rename every rate of the international zones (not the US zone) to "Standard shipping (bpost)", keeping the price and the weight conditions, so every item shows its own date in the cart and the order. Two named rates per zone (one per batch) would show both at checkout and let the buyer pick the wrong one. Prices stay as they are today. The US zone keeps "US preorder: ..." (US stays on the March batch).

Dry run: the list of renames is in the Shopify plan file kept by the person applying it; the write is one `deliveryProfileUpdate` with `methodDefinitionsToUpdate`, done only on the founder's go. Check afterwards: an international test cart with one FC and one RX shows one rate, the FC line says early November and the RX line March 2027.
