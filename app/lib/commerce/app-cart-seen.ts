/**
 * "Something changed since you last looked": the cart page keeps what the buyer saw per line (unit price, ship
 * promise) in the cart options cookie and compares it with the app's quote on the next visit. Nothing is priced
 * here; the quote stays the app's.
 */
import type {Quote} from './app-api.ts';
import type {SeenLine} from './app-cart-options.ts';

export type CartChange = {variant: string; title: string; kind: 'price' | 'ship'; from: string; to: string};

type QuoteLine = Quote['lines'][number];

/** What to remember for each line of a quote. */
export function seenOf(lines: QuoteLine[]): Record<string, SeenLine> {
  return Object.fromEntries(lines.map((l) => [l.variant, {unit: l.unit_minor, ship: l.ship_promise ?? ''}]));
}

/** The changes between what was seen and the quote. A line never seen before changes nothing; a ship date only
 *  counts when both sides had one. */
export function cartChanges(seen: Record<string, SeenLine> | undefined, lines: QuoteLine[], money: (minor: number) => string): CartChange[] {
  const out: CartChange[] = [];
  for (const l of lines) {
    const was = seen?.[l.variant];
    if (!was) continue;
    if (was.unit !== l.unit_minor) out.push({variant: l.variant, title: l.title, kind: 'price', from: money(was.unit), to: money(l.unit_minor)});
    const now = l.ship_promise ?? '';
    if (was.ship && now && was.ship !== now) out.push({variant: l.variant, title: l.title, kind: 'ship', from: was.ship, to: now});
  }
  return out;
}

/** One quiet sentence per change, no em dashes. */
export function changeText(c: CartChange): string {
  return c.kind === 'price' ? `${c.title}: the price changed from ${c.from} to ${c.to}.` : `${c.title}: the ship date changed from ${c.from} to ${c.to}.`;
}
