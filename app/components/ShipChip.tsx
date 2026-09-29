import {copyText} from '~/lib/copy';
import {shipMonth, shortShipPromise} from '~/lib/product-content';
import {
  campaignDate,
  datedShipParts,
  latestShipDate,
  parseCampaignConfig,
  promiseDeliveredBy,
  shortCampaignDate,
  type CampaignState,
} from '~/lib/preorder-campaign';
import preorders from '../../content/preorders.json';

const CAMPAIGN = parseCampaignConfig(preorders);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A dated promise as the one short line every surface shows: "Ships early Nov
 * 2026 · Delivered by 30 Nov 2026" for "ships early November 2026, delivered
 * by 30 November 2026" (PDP, /products, cart, dialog). It drops words of the
 * checkout line text, never the month, its qualifier or the delivery date.
 * Null when the promise names no month and year.
 */
export function datedShipText(promise: string | null | undefined): string | null {
  const parts = datedShipParts(promise);
  if (!parts) return null;
  const ships = shipWord('ships', parts.when);
  return parts.delivered ? `${ships} · ${shipWord('delivered', parts.delivered)}` : ships;
}

/**
 * The ship chip text for a line: "Ships early Nov 2026 · Delivered by 30 Nov
 * 2026" for a dated batch, "ETA
 * 31 Mar 2027" for a funding target, "Ships by 31 Mar 2027 if the target is reached" with
 * `ifFunded` while the target is not met.
 */
export function shipChipText(
  promise: string | null | undefined,
  ifFunded = false,
): {kind: 'date' | 'target'; text: string} | null {
  const short = shortShipPromise(promise);
  if (!short) return null;
  let text = short.text;
  if (short.kind === 'date') {
    text = datedShipText(promise) ?? text;
  } else {
    const eta = shortCampaignDate(latestShipDate(CAMPAIGN));
    if (eta) {
      text = ifFunded
        ? (copyText('preorder.ship_eta_if_funded') ?? 'Ships by {date} if the target is reached').replace('{date}', eta)
        : shipWord('eta', eta);
    }
  }
  return {kind: short.kind, text};
}

/**
 * The promise of the line a one-parcel order waits for: a funding target
 * when the order holds one, else the latest dated batch.
 */
export function parcelPromise(promises: Array<string | null | undefined>): string | null {
  let latest: {promise: string; at: number} | null = null;
  for (const promise of promises) {
    const short = shortShipPromise(promise);
    if (!short || !promise) continue;
    if (short.kind === 'target') return promise;
    const [mon, year] = (shipMonth(promise) ?? '').split(' ');
    const at = Number(year || 0) * 12 + MONTHS.indexOf(mon);
    if (!latest || at > latest.at) latest = {promise, at};
  }
  return latest?.promise ?? null;
}

/**
 * The earliest dated month ("Nov 2026") among lines that ship before a
 * funding-target line waits, or null when the order has no such pair. That
 * pair is what a buyer can split into two orders to get the dated items
 * sooner; without a target line (or without a dated one) there is nothing
 * to split off.
 */
export function soonerMonth(promises: Array<string | null | undefined>): string | null {
  if (!promises.some((p) => shortShipPromise(p)?.kind === 'target')) return null;
  let best: {month: string; at: number} | null = null;
  for (const promise of promises) {
    if (shortShipPromise(promise)?.kind !== 'date') continue;
    const month = shipMonth(promise);
    if (!month) continue;
    const [mon, year] = month.split(' ');
    const at = Number(year) * 12 + MONTHS.indexOf(mon);
    if (!best || at < best.at) best = {month, at};
  }
  return best?.month ?? null;
}

/** The ship chip on a cart or drawer line (see {@link shipChipText}). */
export function ShipChip({
  promise,
  className = 'cart-line-preorder',
  ifFunded = false,
}: {
  promise: string | null | undefined;
  className?: string;
  ifFunded?: boolean;
}) {
  const chip = shipChipText(promise, ifFunded);
  if (!chip) return null;
  return (
    <small className={`ship-chip ${className}`} data-kind={chip.kind}>
      {chip.kind === 'date' ? <span className="ship-line-dot" aria-hidden="true" /> : null}
      {chip.text}
    </small>
  );
}

/**
 * The ship words every surface uses, from `content/copy/preorder.json`:
 * `Ships early Nov 2026` for a dated batch, `Ships by 31 Mar 2027` for a funding
 * target, `Deadline 15 Dec 2026` for its deadline. Dates come in short.
 */
export function shipWord(kind: 'ships' | 'eta' | 'deadline' | 'delivered', date: string): string {
  const fallback = {
    ships: 'Ships {date}',
    eta: 'Ships by {date}',
    deadline: 'Deadline {date}',
    delivered: 'Delivered by {date}',
  }[kind];
  return (copyText(`preorder.ship_${kind}`) ?? fallback).replace('{date}', date);
}

/**
 * The ship line under a Pre-order button. A dated batch reads "Ships early
 * Nov 2026 · Delivered by 30 Nov 2026"; a funding target "Deadline 15 Dec 2026 · Ships by 31 Mar 2027 if
 * funded", and "Ships by 31 Mar 2027" once it is funded.
 */
export function shipLine(
  campaign: CampaignState | null | undefined,
  promise: string | null | undefined,
): {kind: 'date' | 'target'; text: string} | null {
  const full = campaign?.shipPromise ?? promise;
  const short = shortShipPromise(full);
  if (!short) return null;
  // The delivery date is shown before payment, next to the ship date.
  const delivered = promiseDeliveredBy(full);
  const withDelivery = (text: string) =>
    delivered ? `${text} · ${shipWord('delivered', delivered)}` : text;
  if (short.kind === 'date') return {kind: 'date', text: datedShipText(full) ?? short.text};
  const eta = shortCampaignDate(campaign?.latestShip ?? latestShipDate(CAMPAIGN)) ?? '';
  if (campaign?.targetReached) return {kind: 'target', text: withDelivery(shipWord('eta', eta))};
  const deadline =
    shortCampaignDate(campaign?.deadline ?? campaignDate(CAMPAIGN.endsOn)) ?? CAMPAIGN.endsOn;
  const ifFunded = (copyText('preorder.ship_eta_if_funded') ?? 'Ships by {date} if the target is reached').replace(
    '{date}',
    eta,
  );
  return {kind: 'target', text: withDelivery(`${shipWord('deadline', deadline)} · ${ifFunded}`)};
}

export function ShipLine({
  campaign,
  promise,
  className = '',
}: {
  campaign: CampaignState | null | undefined;
  promise: string | null | undefined;
  className?: string;
}) {
  const line = shipLine(campaign, promise);
  if (!line) return null;
  return (
    <p className={`ship-line ${className}`.trim()} data-kind={line.kind}>
      {line.kind === 'date' ? <span className="ship-line-dot" aria-hidden="true" /> : null}
      {line.text}
    </p>
  );
}
