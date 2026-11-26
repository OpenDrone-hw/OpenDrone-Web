/**
 * Wholesale personal codes. A retailer has one code to type, `WS<rate>-<NAME>`
 * (for example `WS25-FPV24`). Shopify takes a percentage off the live price,
 * which differs per price step, so `scripts/wholesale-onboard.py` creates up to
 * four customer-limited codes per retailer, one per price group:
 * `WS25-FPV24`, `WS25-FPV24-G2`, `-G3`, `-G4`. The cart sends all of them when
 * the buyer enters the main code, so the retailer pays 75% of retail whatever
 * step a product is on. Plain TypeScript, no imports.
 */

/** The session key that holds a retailer's applied main code (set by the
 *  cart's code field). It only shows the wholesale offers; the express
 *  checkout checks the cart's own applied code again before it sells. */
export const DEALER_SESSION_KEY = 'wholesaleDealer';

/** Most price groups a retailer can have at once. */
export const WHOLESALE_GROUPS = 4;

const MAIN = /^WS\d{1,2}-[A-Z0-9]{2,16}$/;

/** The main code from buyer input, or null when it is not a wholesale code. */
export function wholesaleMainCode(input: string): string | null {
  const code = input.trim().toUpperCase().replace(/\s+/g, '');
  return MAIN.test(code) ? code : null;
}

/** The main code plus its price-group companions, in slot order. */
export function wholesaleCodes(main: string): string[] {
  const codes = [main];
  for (let n = 2; n <= WHOLESALE_GROUPS; n += 1) codes.push(`${main}-G${n}`);
  return codes;
}

/** The retailer's main code among a cart's discount codes (companions
 *  `-G2` to `-G4` are not returned), with whether the dealer price applies:
 *  the main code or any of its companions. A cart whose lines all sit in one
 *  companion's price group (in-stock boards only, say) leaves the main code
 *  itself unused. */
export function cartWholesaleCode(
  codes: ReadonlyArray<{code: string; applicable: boolean}> | undefined,
): {code: string; applicable: boolean} | null {
  const main = codes?.find((c) => wholesaleMainCode(c.code) === c.code.toUpperCase());
  if (!main) return null;
  const family = new Set(wholesaleCodes(main.code.toUpperCase()));
  return {code: main.code, applicable: codes!.some((c) => c.applicable && family.has(c.code.toUpperCase()))};
}

/** Where a code apply returns to: the cart, with its notice when there is one.
 *  (`/cart?wholesale=1` from older mails still opens the cart; the parameter
 *  is ignored now that the discount code field always shows.) */
export function wholesaleCartPath(check?: string): string {
  return check ? `/cart?check=${check}` : '/cart';
}

/** A discount code as typed: trimmed, upper case, no spaces; null when it
 *  cannot be a Shopify code (empty, too long, or other characters). */
export function discountCodeInput(input: string): string | null {
  const code = input.trim().toUpperCase().replace(/\s+/g, '');
  return /^[A-Z0-9][A-Z0-9_-]{1,39}$/.test(code) ? code : null;
}

/** The codes to send for what the buyer typed: a wholesale main code with its
 *  price-group companions, any other code on its own. */
export function codesToApply(code: string): string[] {
  const main = wholesaleMainCode(code);
  return main ? wholesaleCodes(main) : [code];
}

/** The code the cart shows as applied: a retailer's main code for its whole
 *  family, else the first code Shopify accepted, else the first one typed. */
export function cartDiscountCode(
  codes: ReadonlyArray<{code: string; applicable: boolean}> | undefined,
): {code: string; applicable: boolean} | null {
  const wholesale = cartWholesaleCode(codes);
  if (wholesale) return wholesale;
  const first = codes?.find((c) => c.applicable) ?? codes?.[0];
  return first ? {code: first.code, applicable: first.applicable} : null;
}
