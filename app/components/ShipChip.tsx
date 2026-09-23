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

/**
 * One short ship line for a cart or dialog row: "Funding target · ships by
 * 11 March 2027 if reached", or "Ships late October 2026". The full
 * funding-target condition is stated once per surface, not on every row.
 */
export function ShipChip({
  promise,
  className = 'cart-line-preorder',
  labelOnly = false,
}: {
  promise: string | null | undefined;
  className?: string;
  /** Compact rows: a funding target shows its label alone; the date is in
   *  the terms line of the same surface. */
  labelOnly?: boolean;
}) {
  const short = shortShipPromise(promise);
  if (!short) return null;
  return (
    <small className={`ship-chip ${className}`} data-kind={short.kind}>
      {short.label ? (
        <>
          <span className="ship-chip-label">
            {copyText('cart.ship_label_target') ?? short.label}
          </span>
          {labelOnly ? null : ' · '}
        </>
      ) : null}
      {short.label && labelOnly ? null : short.text}
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
