/**
 * How /account shows one order: status chip, item list and money. Pure, so
 * node:test loads it; the route only renders what these return.
 */
import type {AccountOrder, AccountOrderLine, OrderMoney} from './customer-shopify.ts';

export type OrderStatusTone = 'preorder' | 'shipped' | 'processing' | 'muted';

export type OrderStatus = {
  tone: OrderStatusTone;
  /** Chip text: "Preorder · ships by 31 Mar 2027", "Shipped", ... */
  label: string;
  /** One secondary line under the items; null when there is nothing to add. */
  note: string | null;
};

/**
 * The status of one order. Precedence: cancelled or voided, refunded,
 * shipped (fully or partly), preorder (the latest promise of its batches),
 * else processing. A partial refund adds a note but does not change the chip.
 */
export function orderStatus(order: AccountOrder): OrderStatus {
  const fin = order.financialStatus;
  const ful = order.fulfillmentStatus;
  const partlyRefunded = fin === 'PARTIALLY_REFUNDED' ? 'Partly refunded.' : null;

  if (order.cancelled || fin === 'VOIDED') return {tone: 'muted', label: 'Cancelled', note: null};
  if (fin === 'REFUNDED') return {tone: 'muted', label: 'Refunded', note: null};
  if (ful === 'FULFILLED') return {tone: 'shipped', label: 'Shipped', note: partlyRefunded};
  if (ful === 'PARTIALLY_FULFILLED') return {tone: 'shipped', label: 'Partly shipped', note: partlyRefunded};

  if (order.isPreorder) {
    const p = order.promise;
    const label = p ? `Preorder · ${p.text}` : 'Preorder';
    const notes: string[] = [];
    if (partlyRefunded) notes.push(partlyRefunded);
    return {tone: 'preorder', label, note: notes.join(' ') || null};
  }
  return {tone: 'processing', label: 'Processing', note: partlyRefunded};
}

export type OrderItem = {quantity: number; name: string; variant: string | null};

/** Items shown before the rest collapse into "+N more". */
export const ORDER_ITEMS_SHOWN = 4;

/** The compact item list: up to `limit` lines, then how many are left. */
export function orderItems(
  lines: AccountOrderLine[],
  limit: number = ORDER_ITEMS_SHOWN,
): {shown: OrderItem[]; more: number} {
  const shown = lines.slice(0, limit).map((l) => ({quantity: l.quantity, name: l.name, variant: l.variant}));
  return {shown, more: Math.max(0, lines.length - shown.length)};
}

/** "€249.90" style money in the buyer's currency; null without a total. */
export function formatOrderMoney(total: OrderMoney | null): string | null {
  if (!total) return null;
  const amount = Number(total.amount);
  if (!Number.isFinite(amount)) return null;
  try {
    return new Intl.NumberFormat('en-IE', {style: 'currency', currency: total.currencyCode}).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${total.currencyCode}`;
  }
}

/** "29 Sep 2026". */
export function formatOrderDate(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'}).format(new Date(iso));
}
