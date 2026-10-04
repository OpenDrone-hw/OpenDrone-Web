/**
 * Checkout Click - the Plausible funnel event, with the cart subtotal as
 * revenue. One helper so every checkout entry point (the checkout button
 * in the added-to-cart dialog and on /cart) fires the same event shape;
 * `entry` says which one.
 * The subtotal is passed as Shopify returns it (`amount` a decimal
 * string); `plausibleRevenue` turns it into the number Plausible records
 * and drops a missing or zero subtotal instead of recording 0.00.
 */
import {plausibleRevenue, trackEvent} from './plausible.ts';
import {attributionProps} from './attribution.ts';

/** Where the buyer pressed Checkout: the added-to-cart drawer or /cart. */
export type CheckoutEntry = 'dialog' | 'cart';

export function trackCheckoutClick(
  subtotal: {amount: string | number; currencyCode: string} | null | undefined,
  entry: CheckoutEntry,
): void {
  const revenue = plausibleRevenue(subtotal);
  trackEvent('Checkout Click', {
    props: {...attributionProps(), entry},
    ...(revenue ? {revenue} : {}),
  });
}
