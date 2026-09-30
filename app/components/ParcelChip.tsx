import {copyText} from '~/lib/copy';
import {datedShipParts} from '~/lib/preorder-campaign';
import {ShipChip, parcelPromise, shipChipText} from './ShipChip';

function t(key: string, fallback: string, vars: Record<string, string>): string {
  return (copyText(`cart.${key}`) ?? fallback).replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}

/** When a promise ships as a phrase: "by 31 Mar 2027" for a funding-target
 *  ETA, "in early Dec 2026" for a dated batch. Null when it names neither. */
export function whenPhrase(promise: string | null | undefined, ifFunded = false): string | null {
  const chip = shipChipText(promise, ifFunded);
  if (!chip) return null;
  if (chip.kind === 'target') return chip.text.replace(/^Ships\s+/, '');
  const when = datedShipParts(promise)?.when;
  return when ? `in ${when}` : null;
}

/** A dated promise's own month, "early Nov 2026", for "Ready ...". */
function readyWhen(promise: string | null | undefined): string | null {
  return shipChipText(promise, false)?.kind === 'date' ? (datedShipParts(promise)?.when ?? null) : null;
}

/**
 * How much a candidate line would move the parcel: the ship phrase now and
 * with it, or null when the parcel keeps its date (or the cart is empty).
 * A one-parcel order ships with its latest line.
 */
export function parcelDelay(
  cartPromises: Array<string | null | undefined>,
  candidate: string | null | undefined,
): {from: string; to: string} | null {
  const now = parcelPromise(cartPromises);
  if (!now || !candidate) return null;
  const next = parcelPromise([...cartPromises, candidate]);
  if (!next || next === now) return null;
  const from = readyWhen(now);
  const to = whenPhrase(next, true);
  return from && to ? {from, to} : null;
}

/**
 * The ship chip of a cart or drawer line. In a one-parcel order a line that
 * is ready before the parcel does not promise its own date: it says when it
 * is ready and that it ships with the rest, on the parcel's date.
 */
export function LineShipChip({
  promise,
  parcel,
  className,
  ifFunded,
}: {
  promise: string | null | undefined;
  /** The promise the one-parcel order waits for, or null for a single date. */
  parcel: string | null;
  className?: string;
  ifFunded?: boolean;
}) {
  if (!parcel || !promise || promise === parcel) {
    return <ShipChip promise={promise} className={className} ifFunded={ifFunded} />;
  }
  const to = whenPhrase(parcel);
  const ready = readyWhen(promise);
  if (!to) return <ShipChip promise={promise} className={className} ifFunded={ifFunded} />;
  return (
    <small className={`ship-chip ${className ?? 'cart-line-preorder'}`} data-kind="held">
      {ready
        ? t('line_held', 'Ready {ready} · ships with this order {parcel}', {ready, parcel: to})
        : t('line_held_plain', 'Ships with this order {parcel}', {parcel: to})}
    </small>
  );
}
