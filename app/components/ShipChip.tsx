import {useRouteLoaderData} from 'react-router';
import {copyText} from '~/lib/copy';
import {GEO_BAR_SHORT, batchOnePromises, geoDutiesNote, geoInStock, geoShipText} from '~/lib/geo-availability';
import type {RootLoader} from '~/root';
import {shipMonth, shortShipPromise} from '~/lib/product-content';
import {
  campaignDate,
  datedShipParts,
  latestShipDate,
  parseCampaignConfig,
  promiseBatchMonth,
  shortCampaignDate,
  type CampaignState,
} from '~/lib/preorder-campaign';
import preorders from '../../content/preorders.json';

const CAMPAIGN = parseCampaignConfig(preorders);
const BATCH_ONE = batchOnePromises(preorders);

/**
 * The visitor's line in place of a batch 1 promise ("In stock in Belgium,
 * ships in a few days." in the EU, "Pre-order, ships March 2027." elsewhere),
 * or null to show the promise itself: another batch, or no known country
 * (app/lib/geo-availability.ts).
 */
export function useGeoShipText(promise: string | null | undefined): string | null {
  const geo = useRouteLoaderData<RootLoader>('root')?.geo;
  return geo && promise && BATCH_ONE.has(promise) ? geoShipText(geo.region, geo.locale) : null;
}

/**
 * {@link useGeoShipText} as a function of the promise, for a caller that
 * picks the promise after its hooks ran: `geoLine(promise)`. With `short`,
 * the bar's phone line ("In stock, ships in days"), for chips.
 */
export function useGeoShipLine(short = false): (promise: string | null | undefined) => string | null {
  const geo = useRouteLoaderData<RootLoader>('root')?.geo;
  return (promise) => {
    if (!geo || !promise || !BATCH_ONE.has(promise) || geo.region === 'fallback') return null;
    return short ? GEO_BAR_SHORT[geo.locale][geo.region] : geoShipText(geo.region, geo.locale);
  };
}

/**
 * The duties note of the visitor's region ("Import VAT and duties are paid by
 * you on delivery." for UK, CH, NO), or null. Same source as the bar.
 */
export function useGeoDutiesNote(): string | null {
  const geo = useRouteLoaderData<RootLoader>('root')?.geo;
  return geo ? geoDutiesNote(geo.region, geo.locale) : null;
}

/**
 * True when the visitor's next unit of this SKU is batch 1 stock and their
 * region reads it as in stock (the EU line): the buy button says "Add to
 * cart", not "Pre-order", and the pre-order terms link drops. Same source as
 * the bar and `useGeoShipText` (root loader `geo`), so the SSR and the
 * hydrated page agree.
 */
export function useGeoInStock(campaign: Pick<CampaignState, 'paidStock' | 'shipPromise'> | null | undefined): boolean {
  const geo = useRouteLoaderData<RootLoader>('root')?.geo;
  return geoInStock(geo?.region, campaign, BATCH_ONE);
}

/**
 * True for a batch 1 promise the visitor's region reads as in stock (the EU
 * line): a cart line from Belgian stock, with no delivery date and no early
 * bird preorder note. Root loader `geo`, so SSR and hydration agree.
 */
export function useGeoEuStockLine(): (promise: string | null | undefined) => boolean {
  const geo = useRouteLoaderData<RootLoader>('root')?.geo;
  return (promise) => geo?.region === 'eu' && Boolean(promise && BATCH_ONE.has(promise));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A dated promise as the one short line every surface shows: "Ships late Nov
 * 2026" for "ships late November 2026" (PDP, /products, cart, dialog). It
 * drops words of the checkout line text, never the month or its qualifier.
 * Null when the promise names no month and year.
 */
export function datedShipText(promise: string | null | undefined): string | null {
  const parts = datedShipParts(promise);
  if (!parts) return null;
  return shipWord('ships', parts.when);
}

/**
 * The ship chip text for a line: "Ships late Nov 2026" for a dated batch,
 * "Ships by 31 Mar 2027" for a funding target, "Ships by 31 Mar 2027 if the target is reached" with
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
  const geoText = useGeoShipText(promise);
  if (!chip) return null;
  return (
    <small className={`ship-chip ${className}`} data-kind={chip.kind}>
      {(chip.kind === 'date' && geoText) || chip.text}
    </small>
  );
}

/**
 * The ship words every surface uses, from `content/copy/preorder.json`:
 * `Ships late Nov 2026` for a dated batch, `Ships by 31 Mar 2027` for a funding
 * target, `Deadline 15 Dec 2026` for its deadline. Dates come in short.
 */
export function shipWord(kind: 'ships' | 'eta' | 'deadline', date: string): string {
  const fallback = {
    ships: 'Ships {date}',
    eta: 'Ships by {date}',
    deadline: 'Deadline {date}',
  }[kind];
  return (copyText(`preorder.ship_${kind}`) ?? fallback).replace('{date}', date);
}

/**
 * The ship line under a Pre-order button. A dated batch reads "Ships late
 * Nov 2026"; a funding target "Deadline 15 Dec 2026. Ships by 31 Mar 2027 if
 * funded", and "Ships by 31 Mar 2027" once it is funded.
 */
export function shipLine(
  campaign: CampaignState | null | undefined,
  promise: string | null | undefined,
): {kind: 'date' | 'target'; text: string} | null {
  const full = campaign?.shipPromise ?? promise;
  const short = shortShipPromise(full);
  if (!short) return null;
  if (short.kind === 'date') return {kind: 'date', text: datedShipText(full) ?? short.text};
  const eta = shortCampaignDate(campaign?.latestShip ?? latestShipDate(CAMPAIGN)) ?? '';
  // An accessory waits for another product's batch: name it, so "the target"
  // is not left without an owner.
  const lead = leadProduct(campaign?.shipsWith);
  const month = lead ? promiseBatchMonth(full) : null;
  const withLead = (text: string) => {
    if (!lead) return text;
    const head = month
      ? (copyText('preorder.ships_with_batch') ?? 'Ships with the {lead} {month} batch').replace('{month}', month)
      : (copyText('preorder.ships_with') ?? 'Ships with the {lead} batch');
    return `${head.replace('{lead}', lead)}. ${text}`;
  };
  if (campaign?.targetReached) return {kind: 'target', text: withLead(shipWord('eta', eta))};
  const deadline =
    shortCampaignDate(campaign?.deadline ?? campaignDate(CAMPAIGN.endsOn)) ?? CAMPAIGN.endsOn;
  const ifFunded = (
    copyText(lead ? 'preorder.ship_eta_if_lead_funded' : 'preorder.ship_eta_if_funded') ??
    (lead ? 'Ships by {date} if that target is reached' : 'Ships by {date} if the target is reached')
  ).replace('{date}', eta);
  return {kind: 'target', text: withLead(`${shipWord('deadline', deadline)}. ${ifFunded}`)};
}

/**
 * The product a shipsWith SKU waits for ("OpenFC Lite"), from its lead SKU.
 * Null without a lead.
 */
export function leadProduct(sku: string | null | undefined): string | null {
  if (!sku) return null;
  if (sku.startsWith('OPENFC')) return copyText('preorder.lead_openfc') ?? 'OpenFC Lite';
  if (sku.startsWith('OPENFRAME')) return copyText('preorder.lead_openframe') ?? 'OpenFrame';
  return null;
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
  const geoText = useGeoShipText(campaign?.shipPromise ?? promise);
  if (!line) return null;
  // An accessory whose date is another product's funding target says so, so a
  // buyer of props does not wonder why a flight controller sets the date.
  const lead = line.kind === 'target' && !campaign?.targetReached ? leadProduct(campaign?.shipsWith) : null;
  const shipLineEl = (
    <p className={`ship-line ${className}`.trim()} data-kind={line.kind}>
      {(line.kind === 'date' && geoText) || line.text}
    </p>
  );
  if (!lead) return shipLineEl;
  return (
    <>
      {shipLineEl}
      <p className="product-buy-ship">
        {(copyText('preorder.ships_with_wait') ?? 'This item ships when the {lead} target is reached.').replace('{lead}', lead)}
      </p>
    </>
  );
}
