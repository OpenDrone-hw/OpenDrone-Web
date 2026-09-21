/**
 * Stack-deal display math, shared by every surface that advertises the
 * FC + ESC stack (PDP CTA flyout, catalog cards, header pod rows).
 *
 * The percent and which board it is off are per-product configuration
 * (`stack.discountPct` / `stack.discountedHandle` in
 * content/products/*.json). Set them ONLY while Shopify actually carries
 * the matching automatic discount, because the storefront only advertises
 * the deal: Shopify checkout is what applies it. They are unset today, so
 * no surface claims a discount.
 *
 * Copy must name the discounted board (e.g. "OpenESC -10%"), and any
 * discounted price shown must be derived from the live catalog price with
 * {@link stackDiscountedPrice} so it matches what Shopify checkout charges.
 * Never hardcode computed prices in code or copy, comments included: they
 * rot the moment a price changes.
 */

/** A money-ish price ({amount, currencyCode}) with `pct` percent off,
 *  rounded to cents. */
export function stackDiscountedPrice<
  T extends {amount: string; currencyCode: string},
>(price: T, pct: number): T {
  return {
    ...price,
    amount: ((Number(price.amount) * (100 - pct)) / 100).toFixed(2),
  };
}
