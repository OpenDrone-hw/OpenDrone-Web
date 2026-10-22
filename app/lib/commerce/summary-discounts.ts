/**
 * What the app-mode order summary shows for discounts (pure, so it is tested without a renderer): one row per applied
 * discount, the shipping row reading Free or reduced for a shipping discount, and a struck-through original price
 * on a discounted line. An older app sends no `discounts`; then the single `discount` row is all there is.
 */
import {type AppliedDiscount, type Quote} from './app-api.ts';

export type DiscountRow = {key: string; label: string; minor: number};

const isShipping = (d: AppliedDiscount) => d.class === 'shipping' || d.kind === 'free_shipping';

/** An automatic discount reads by its title, a code by the code. */
export function discountLabel(d: AppliedDiscount): string {
  const name = d.method === 'automatic' ? d.title || d.code : d.code || d.title;
  return name?.trim() || 'Discount';
}

/** The minus rows under the subtotal. Shipping discounts are not here: they change the shipping row. */
export function discountRows(quote: Pick<Quote, 'discount' | 'discounts'>): DiscountRow[] {
  if (Array.isArray(quote.discounts)) {
    return quote.discounts
      .filter((d) => !isShipping(d) && d.minor > 0)
      .map((d, i) => ({key: `${d.method}:${d.code ?? d.title}:${i}`, label: discountLabel(d), minor: d.minor}));
  }
  const d = quote.discount;
  return d && d.minor > 0 ? [{key: `code:${d.code}`, label: `Discount (${d.code})`, minor: d.minor}] : [];
}

/** The shipping amount before a shipping discount, only when one applied and it really lowered the charge. */
export function shippingStrike(quote: Pick<Quote, 'discounts' | 'shipping_minor' | 'shipping_standard_minor'>): number | null {
  const std = quote.shipping_standard_minor;
  if (!Array.isArray(quote.discounts) || !quote.discounts.some(isShipping)) return null;
  return typeof std === 'number' && std > quote.shipping_minor ? std : null;
}

/** A line's price before its discount, when the app gave the line a share of one. */
export function lineStrike(line: {total_minor: number; discount_minor?: number}): {was: number; now: number} | null {
  const off = line.discount_minor ?? 0;
  return off > 0 ? {was: line.total_minor, now: Math.max(0, line.total_minor - off)} : null;
}
