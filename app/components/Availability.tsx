import {copyText} from '~/lib/copy';
import {
  availabilityRows,
  targetDates,
  type BatchRow,
  type Words,
} from '~/lib/availability';
import {campaignDate, latestShipDate, parseCampaignConfig, type CampaignState, type Region} from '~/lib/preorder-campaign';
import {leadProduct} from '~/components/ShipChip';
import preorders from '../../content/preorders.json';

const CAMPAIGN = parseCampaignConfig(preorders);

/** The words of this block, from `content/copy/preorder.json`. */
export const preorderWords: Words = (key, fallback, vars = {}) =>
  (copyText(`preorder.${key}`) ?? fallback).replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );

/**
 * Which batches a buyer can choose between and which one is theirs: one row
 * per batch, "Batch 1 · Ships early Nov 2026 · EU only · 249 left" and "March
 * 2027 batch · EU and US · Deadline 15 Dec 2026 · Ships by 31 Mar 2027 if the
 * target is reached". The buyer's batch is highlighted; one their region cannot
 * get stays listed and says so. A SKU with a single batch gets a single row.
 */
export function Availability({
  campaign,
  region,
  className = '',
}: {
  campaign: CampaignState;
  region: Region;
  className?: string;
}) {
  const dates = targetDates(
    campaign.deadline ?? campaignDate(CAMPAIGN.endsOn),
    campaign.latestShip ?? latestShipDate(CAMPAIGN),
  );
  const rows = availabilityRows(campaign, dates, region, preorderWords);
  if (!rows.length) return null;
  // An accessory whose batch is another product's funding target says so, as
  // its ship line does, so a buyer of a capacitor does not wonder what "the
  // target" is.
  const current = campaign.batches.find((b) => b.batch === campaign.batch);
  const lead = current && !current.paid && !campaign.targetReached ? leadProduct(campaign.shipsWith) : null;
  return (
    <>
      <ul className={`avail ${className}`.trim()} data-batches={rows.length}>
        {rows.map((row) => (
          <AvailabilityRow key={row.batch} row={row} />
        ))}
      </ul>
      {lead ? (
        <p className="product-buy-ship">
          {(copyText('preorder.ships_with_wait') ?? 'This item ships when the {lead} target is reached.').replace('{lead}', lead)}
        </p>
      ) : null}
    </>
  );
}

function AvailabilityRow({row}: {row: BatchRow}) {
  return (
    <li className="avail-row" data-state={row.state} aria-current={row.state === 'current' ? 'true' : undefined}>
      <span className="avail-head">
        <strong className="avail-label">{row.label}</strong>
        <span className="avail-scope">{row.scope}</span>
        {row.note ? <span className="avail-note">{row.note}</span> : null}
      </span>
      <span className="avail-detail">{row.detail}</span>
    </li>
  );
}
