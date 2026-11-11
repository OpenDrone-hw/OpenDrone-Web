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

/** The session key that remembers a retailer's visit: the cart then shows
 *  its "Wholesale code" field for the rest of the session. */
export const WHOLESALE_SESSION_KEY = 'wholesaleVisit';
/** The link parameter that marks a retailer's visit: `/cart?wholesale=1`
 *  (any value) on any page, the link approved retailers are given. */
export const WHOLESALE_PARAM = 'wholesale';

/** True when this URL marks a retailer's visit: the wholesale page itself,
 *  or any page reached through a link with the `wholesale` parameter. */
export function wholesaleVisit(url: URL): boolean {
  return url.searchParams.has(WHOLESALE_PARAM) || /^\/(?:[a-z]{2}\/)?wholesale\/?$/.test(url.pathname);
}

/**
 * Whether the cart shows the "Wholesale code" field. Not everyone needs to
 * see it: with buy now or pre-order on (`choice`) only a visitor who came
 * through the wholesale page or a wholesale link this session, or whose
 * cart already carries a code (so it can be seen and removed). Off, it
 * shows as before.
 */
export function wholesaleFieldShown(state: {choice: boolean; visited: boolean; applied: boolean}): boolean {
  return !state.choice || state.visited || state.applied;
}
