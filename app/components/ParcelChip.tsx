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
 * The promise of the parcel that would hold a candidate line back, or null
 * when the candidate sets the parcel's date itself (or the cart is empty).
 * A part offered next to a cart that ships later says it ships with that
 * order, on the order's date, not on its own.
 */
export function heldBy(
  cartPromises: Array<string | null | undefined>,
  candidate: string | null | undefined,
): string | null {
  if (!candidate) return null;
  const next = parcelPromise([...cartPromises, candidate]);
  return next && next !== candidate ? next : null;
}

/**
 * The ship chip of a cart or drawer line: one short date. In a one-parcel
 * order a line that is ready before the parcel shows the parcel's date, the
 * one it ships on.
 */
export function LineShipChip({
  promise,
  parcel,
  className,
}: {
  promise: string | null | undefined;
  /** The promise the one-parcel order waits for, or null for a single date. */
  parcel: string | null;
  className?: string;
}) {
  return <ShipChip promise={parcel && promise ? parcel : promise} className={className} />;
}
