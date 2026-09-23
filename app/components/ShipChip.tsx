import {copyText} from '~/lib/copy';
import {shipMonth, shortShipPromise} from '~/lib/product-content';
import {
  campaignDate,
  latestShipDate,
  parseCampaignConfig,
  shortCampaignDate,
  type CampaignState,
} from '~/lib/preorder-campaign';
import preorders from '../../content/preorders.json';

const CAMPAIGN = parseCampaignConfig(preorders);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The ship chip text for a line: "Ships Oct 2026" for a dated batch, "ETA
 * 11 Mar 2027" for a funding target, "ETA 11 Mar 2027 if funded" with
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
    const month = shipMonth(promise);
    if (month) text = shipWord('ships', month);
  } else {
    const eta = shortCampaignDate(latestShipDate(CAMPAIGN));
    if (eta) {
      text = ifFunded
        ? (copyText('preorder.ship_eta_if_funded') ?? 'ETA {date} if funded').replace('{date}', eta)
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
 * `Ships Oct 2026` for a dated batch, `ETA 11 Mar 2027` for a funding
 * target, `Deadline 31 Dec 2026` for its deadline. Dates come in short.
 */
export function shipWord(kind: 'ships' | 'eta' | 'deadline', date: string): string {
  const fallback = {ships: 'Ships {date}', eta: 'ETA {date}', deadline: 'Deadline {date}'}[kind];
  return (copyText(`preorder.ship_${kind}`) ?? fallback).replace('{date}', date);
}

/**
 * The ship line under a Pre-order button. A dated batch reads "Ships Oct
 * 2026"; a funding target "Deadline 31 Dec 2026 · ETA 11 Mar 2027 if
 * funded", and "ETA 11 Mar 2027" once it is funded.
 */
export function shipLine(
  campaign: CampaignState | null | undefined,
  promise: string | null | undefined,
): {kind: 'date' | 'target'; text: string} | null {
  const short = shortShipPromise(campaign?.shipPromise ?? promise);
  if (!short) return null;
  if (short.kind === 'date') {
    const month = shipMonth(campaign?.shipPromise ?? promise);
    return {kind: 'date', text: month ? shipWord('ships', month) : short.text};
  }
  const eta = shortCampaignDate(campaign?.latestShip ?? latestShipDate(CAMPAIGN)) ?? '';
  if (campaign?.targetReached) return {kind: 'target', text: shipWord('eta', eta)};
  const deadline =
    shortCampaignDate(campaign?.deadline ?? campaignDate(CAMPAIGN.endsOn)) ?? CAMPAIGN.endsOn;
  const ifFunded = (copyText('preorder.ship_eta_if_funded') ?? 'ETA {date} if funded').replace(
    '{date}',
    eta,
  );
  return {kind: 'target', text: `${shipWord('deadline', deadline)} · ${ifFunded}`};
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
