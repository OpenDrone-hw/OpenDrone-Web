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

/** The link parameter that opens the cart's "Wholesale code" field:
 *  `/cart?wholesale=1` (any value), the link approved retailers are given
 *  and the one at the foot of /wholesale. */
export const WHOLESALE_PARAM = 'wholesale';

/** True when this URL asks for the wholesale field: it carries the
 *  `wholesale` parameter. Nothing is remembered: a later plain visit to
 *  /cart on the same (perhaps shared) computer shows no field. */
export function wholesaleVisit(url: URL): boolean {
  return url.searchParams.has(WHOLESALE_PARAM);
}

/**
 * Whether the cart shows the "Wholesale code" field. With buy now or
 * pre-order on (`choice`) only when the cart URL carries the wholesale
 * parameter, or the cart already carries a code (so it can be seen and
 * removed). Off, it shows as before.
 */
export function wholesaleFieldShown(state: {choice: boolean; visited: boolean; applied: boolean}): boolean {
  return !state.choice || state.visited || state.applied;
}

/** Where a code apply returns to: the cart with the field still open. */
export function wholesaleCartPath(check?: string): string {
  return `/cart?${WHOLESALE_PARAM}=1${check ? `&check=${check}` : ''}`;
}
