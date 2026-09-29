/**
 * The batch availability block of a campaign SKU, as plain data: which batches
 * a buyer can choose between, where each one ships, and which one is theirs.
 * The product page, the cart line and the checkout line property all read the
 * same words from here. Pure and relative-imported, so node:test runs it
 * without Vite; the words come from `content/copy/preorder.json` through the
 * `words` lookup the caller passes.
 */

import {
  datedShipParts,
  promiseBatchMonth,
  promiseDeliveredBy,
  shortCampaignDate,
  type CampaignState,
} from './preorder-campaign.ts';

export type Words = (key: string, fallback: string, vars?: Record<string, string | number>) => string;

type Batch = CampaignState['batches'][number];

export type BatchRow = {
  batch: number;
  /** "Batch 1" for paid stock, "March 2027 batch" for a funding target. */
  label: string;
  /** Where it ships: "EU only", "EU and US". */
  scope: string;
  /** The ship words: dated, or deadline and ship-by for a funding target. */
  detail: string;
  /** The buyer's batch is `current`; a batch their region cannot get is
   *  `other_region`. */
  state: Batch['status'];
  /** "249 left", "Sold out", "Not available in the US"; null when nothing to add. */
  note: string | null;
};

/** The dates a funding-target row names, short ("15 Dec 2026"). */
export type TargetDates = {deadline: string; eta: string};

function scopeOf(regions: Batch['regions'], words: Words): string {
  if (regions.length === 1 && regions[0] === 'EU') return words('scope_eu', 'EU only');
  if (regions.length === 1 && regions[0] === 'US') return words('scope_us', 'US only');
  return words('scope_both', 'EU and US');
}

/** "Batch 1" for paid stock, "March 2027 batch" for anything else. */
export function batchLabel(batch: Pick<Batch, 'batch' | 'paid' | 'shipPromise'>, words: Words): string {
  const month = batch.paid ? null : promiseBatchMonth(batch.shipPromise);
  return month
    ? words('batch_month', '{month} batch', {month})
    : words('batch_n', 'Batch {n}', {n: batch.batch});
}

/** The batch inside a sentence: "batch 1", "the March 2027 batch". */
export function batchPhrase(batch: Pick<Batch, 'batch' | 'paid' | 'shipPromise'>, words: Words): string {
  const month = batch.paid ? null : promiseBatchMonth(batch.shipPromise);
  return month
    ? words('batch_phrase_month', 'the {month} batch', {month})
    : words('batch_phrase_n', 'batch {n}', {n: batch.batch});
}

/** The batch a buyer's next unit falls into, from the campaign state. */
export function currentBatch(campaign: Pick<CampaignState, 'batches' | 'batch'>): Batch | null {
  return campaign.batches.find((b) => b.batch === campaign.batch) ?? null;
}

/**
 * "Batch 1 · EU only" or "March 2027 batch · EU and US": the one wording of
 * the cart line and the checkout line property.
 */
export function batchText(campaign: Pick<CampaignState, 'batches' | 'batch'>, words: Words): string | null {
  const b = currentBatch(campaign);
  return b ? `${batchLabel(b, words)} · ${scopeOf(b.regions, words)}` : null;
}

function detailOf(b: Batch, dates: TargetDates, reached: boolean, words: Words): string {
  const delivered = promiseDeliveredBy(b.shipPromise);
  const withDelivery = (text: string) =>
    delivered ? `${text} · ${words('ship_delivered', 'Delivered by {date}', {date: delivered})}` : text;
  const waits = /\bif the target is reached\b/.test(b.shipPromise);
  if (!waits) {
    const parts = datedShipParts(b.shipPromise);
    return withDelivery(parts ? words('ship_ships', 'Ships {date}', {date: parts.when}) : b.shipPromise);
  }
  const eta = words('ship_eta', 'Ships by {date}', {date: dates.eta});
  if (reached) return withDelivery(eta);
  return withDelivery(
    `${words('ship_deadline', 'Deadline {date}', {date: dates.deadline})} · ${words('ship_eta_if_funded', 'Ships by {date} if the target is reached', {date: dates.eta})}`,
  );
}

/**
 * The rows of the availability block: every batch up to the buyer's, with the
 * next one after it. A batch the buyer's region cannot get stays listed and
 * says so. Empty without a campaign state.
 */
export function availabilityRows(
  campaign: Pick<CampaignState, 'batches' | 'targetReached' | 'batch'>,
  dates: TargetDates,
  region: 'EU' | 'US',
  words: Words,
): BatchRow[] {
  return campaign.batches.map((b) => {
    let note: string | null = null;
    if (b.status === 'other_region') {
      note = words('not_in_region', 'Not available in the {region}', {region: region === 'US' ? 'US' : 'EU'});
    } else if (b.status === 'sold_out') {
      note = words('batch_sold_out', 'Sold out');
    } else if (b.paid) {
      note = words('batch_left', '{count} left', {count: Math.max(0, b.units - b.ordered)});
    }
    return {
      batch: b.batch,
      label: batchLabel(b, words),
      scope: scopeOf(b.regions, words),
      detail: detailOf(b, dates, !b.paid && campaign.targetReached && b.batch === campaign.batch, words),
      state: b.status,
      note,
    };
  });
}

/** The short dates a funding-target row names, from the campaign's long ones. */
export function targetDates(deadlineLong: string | null | undefined, etaLong: string | null | undefined): TargetDates {
  return {
    deadline: shortCampaignDate(deadlineLong) ?? deadlineLong ?? '',
    eta: shortCampaignDate(etaLong) ?? etaLong ?? '',
  };
}
