/**
 * Wholesale personal codes. A retailer has one code to type, `WS<rate>-<NAME>`
 * (for example `WS25-FPV24`). Shopify takes a percentage off the live price,
 * which differs per price step, so `scripts/wholesale-onboard.py` creates up to
 * four customer-limited codes per retailer, one per price group:
 * `WS25-FPV24`, `WS25-FPV24-G2`, `-G3`, `-G4`. The cart sends all of them when
 * the buyer enters the main code, so the retailer pays 75% of retail whatever
 * step a product is on. Plain TypeScript, no imports.
 */

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
 *  `-G2` to `-G4` are left out), with whether Shopify applies it. */
export function cartWholesaleCode(
  codes: ReadonlyArray<{code: string; applicable: boolean}> | undefined,
): {code: string; applicable: boolean} | null {
  return codes?.find((c) => wholesaleMainCode(c.code) === c.code.toUpperCase()) ?? null;
}
