/**
 * Checkout Click - the Plausible funnel event, with the cart subtotal as
 * revenue. One helper so every checkout entry point (the checkout button
 * in the added-to-cart dialog and on /cart) fires the same event shape.
 * The subtotal is passed as Shopify returns it (`amount` a decimal
 * string); `plausibleRevenue` turns it into the number Plausible records
 * and drops a missing or zero subtotal instead of recording 0.00.
 */
import {plausibleRevenue, trackEvent} from './plausible.ts';
import {attributionProps} from './attribution.ts';

export function trackCheckoutClick(
  subtotal: {amount: string | number; currencyCode: string} | null | undefined,
): void {
  const revenue = plausibleRevenue(subtotal);
  trackEvent('Checkout Click', {
    props: attributionProps(),
    ...(revenue ? {revenue} : {}),
  });
}
