/**
 * Preorder campaigns: per-SKU production batches and the state a buyer sees.
 *
 * `content/preorders.json` lists, per SKU, the batches in production order.
 * A batch is either paid stock (`paid: true`, Incutec already ordered it and
 * it carries its own ship date) or a funding target (the supplier order is
 * placed once that many units are ordered). Paid units come from Shopify
 * orders (`app/lib/shopify-orders.ts`); this module turns the two into the
 * state every surface renders, so the PDP, the cards, the feeds and the cart
 * line agree on one ship promise.
 *
 * Prices stay in Shopify: the compare-at price is the retail price and the
 * price is what the next unit costs. `priceTiers` says how the price steps
 * as paid units come in, for example the first 100 at 20% off and units 101
 * to 250 at 10% off, then retail. `app/lib/shopify-price-tier.ts` writes each
 * step to Shopify; until it has, a SKU whose Shopify price is below its tier
 * closes rather than sell under it.
 *
 * Kept pure and bundler-free (relative imports, no worker APIs) so the
 * node:test suites can load it.
 */

import type {Catalog, CatalogVariant} from './catalog.ts';
import {EU_COUNTRY_CODES} from './eu-countries.ts';

/** Allocation regions: EU member states, the US, or other international
 *  destinations. Missing country information retains the historical EU default. */
export type Region = 'EU' | 'US' | 'INT';

export const REGIONS: readonly Region[] = ['EU', 'US', 'INT'];

/** The region of a shipping country (ISO 3166-1 alpha-2). */
export function regionOf(country: string | null | undefined): Region {
  const code = country?.trim().toUpperCase();
  if (code === 'US') return 'US';
  return code && /^[A-Z]{2}$/.test(code) && !EU_COUNTRY_CODES.includes(code) ? 'INT' : 'EU';
}

/** Paid units of one SKU in order, oldest first, as runs of one region:
 *  what the batch allocation needs, since a batch may serve one region
 *  only. A plain number is that many EU units. */
export type UnitRuns = Array<{region: Region; units: number}>;

/** A SKU's paid units: a count (all EU) or its runs by region. */
export type PaidUnitsOf = number | UnitRuns;

export type CampaignBatch = {
  /** Units in this batch: the supplier order quantity. */
  units: number;
  /** Paid stock: Incutec has already ordered this batch. */
  paid?: boolean;
  /** The ship promise once the supplier order is placed, e.g.
   *  "ships early November 2026". Required for paid stock. */
  ships?: string;
  /** Reviewed final customer delivery date, separate from dispatch. The ship promise names it; null leaves it out. */
  deliveryBy?: string | null;
  /** The same for a US buyer (shipped direct by the fulfilment partner, duties included); a US promise names only this one, and leaves the delivery
   *  date out without it. */
  deliveryByUS?: string | null;
  /** A separately agreed international arrival deadline; never inherits EU or US dates. */
  deliveryByINT?: string | null;
  /** The regions this batch ships to; absent means every region. Paid
   *  stock in Belgium is `["EU"]`: a non-EU unit skips it for the next batch
   *  that serves the destination. A SKU's last funding batch serves every region. */
  regions?: Region[];
};

export type PriceTier = {
  /** The last paid unit that gets this step. */
  upTo: number;
  /** Share off the retail price, 0.2 for 20% off. */
  off: number;
};

/** One promise flows to product pages, cart lines and order confirmations.
 *  It states the ship date only, never a delivery date. */
function batchPromise(batch: CampaignBatch, fallback: string): string {
  return batch.ships?.trim() || fallback;
}

/** The agreed arrival deadline for a region, YYYY-MM-DD, or null. Used for
 *  visible checkout metadata and ordering the lines of a combined cart. */
function batchDeliveryDay(batch: CampaignBatch, region: Region): string | null {
  return (region === 'US' ? batch.deliveryByUS : region === 'INT' ? batch.deliveryByINT : batch.deliveryBy) ?? null;
}

export type CampaignConfig = {
  /** First day whose paid Shopify orders count, YYYY-MM-DD. */
  countFrom: string;
  /** Ship promise for a unit in a batch whose supplier order is not placed.
   *  It names the target deadline (`endsOn`) and the ship-by date
   *  (`shipsBy`), as terms 7bis.2 do; the tests hold the three in step. */
  pendingShips: string;
  /** The one ship-by date of every funding-target unit, YYYY-MM-DD: a
   *  target reached early does not ship earlier than planned. */
  shipsBy: string;
  /** Last day a funding target can be reached, YYYY-MM-DD. A buyer whose
   *  target is missed by then chooses a refund or to keep waiting. */
  endsOn: string;
  /** Price steps by paid units, in order: `upTo` is the last unit of the
   *  step and `off` its share off retail. Past the last step: retail. */
  priceTiers: PriceTier[];
  /** Per SKU: its batches, and optionally its own price steps in place of
   *  the campaign's (`tiersFor`). */
  skus: Record<string, {batches: CampaignBatch[]; priceTiers?: PriceTier[]}>;
  /** SKUs that ship with a campaign SKU instead of running their own count:
   *  accessories and spares. Flat price (no steps), and their units do not
   *  count toward the lead's batches. With `batch` the SKU ships with that
   *  batch of the lead, which must carry its own ship date; without it the
   *  SKU follows whatever batch the lead's next unit falls into. */
  shipsWith?: Record<string, ShipsWith>;
  /** How a non-EU buyer gets any other SKU the shop sells (in stock, or a
   *  preorder outside the campaign): it ships with a non-EU-serving batch of a
   *  campaign SKU (`batch`, no `stock`), so a non-EU order is never refused for
   *  a SKU the campaign does not list. Belgian stock stays EU only. */
  usStock?: ShipsWith;
  /** The dates orders were sold under before a date change. An order created
   *  before `before` (ISO timestamp) keeps these promises on its account page
   *  instead of the current ones (terms 7bis.3: a moved date is never applied
   *  silently to an existing order). */
  soldUnder?: SoldUnder;
};

export type SoldUnder = {
  before: string;
  shipsBy: string;
  /** Ship promise of a paid batch, e.g. "ships early November 2026". */
  paidShips: string;
  /** Funding-target batch delivery days, YYYY-MM-DD. */
  deliveryBy: string;
  deliveryByUS: string;
};

/** The campaign as an order created before `soldUnder.before` was sold: same
 *  batches, the promised dates of that time. Unchanged for any later order. */
export function configSoldUnder(config: CampaignConfig, createdAt: string | undefined): CampaignConfig {
  const old = config.soldUnder;
  if (!old || !createdAt || !(Date.parse(createdAt) < Date.parse(old.before))) return config;
  const skus: CampaignConfig['skus'] = {};
  for (const [sku, entry] of Object.entries(config.skus)) {
    skus[sku] = {
      ...entry,
      batches: entry.batches.map((b) =>
        b.paid
          ? {...b, ships: old.paidShips}
          : {...b, deliveryBy: b.deliveryBy ? old.deliveryBy : b.deliveryBy, deliveryByUS: b.deliveryByUS ? old.deliveryByUS : b.deliveryByUS},
      ),
    };
  }
  return {...config, shipsBy: old.shipsBy, skus};
}

export type ShipsWith = {
  /** The campaign SKU this one ships with. */
  sku: string;
  /** 1-based batch of the lead SKU, pinned: a batch with its own ship date,
   *  or a funding target, whose promise and target the SKU then shares. */
  batch?: number;
  /** With `batch`: units on hand for that batch. The first `stock` paid
   *  units of this SKU ship with `batch`, later ones with `after`. */
  stock?: number;
  /** With `stock`: the 1-based lead batch the units past stock ship with. */
  after?: number;
};

/** SKUs whose own paid units the campaign counts: every campaign SKU, and
 *  every SKU that ships with one from limited stock. */
export function countedSkus(config: CampaignConfig): Set<string> {
  const skus = new Set(Object.keys(config.skus));
  for (const [sku, rule] of Object.entries(config.shipsWith ?? {})) {
    if (rule.stock !== undefined) skus.add(sku);
  }
  return skus;
}

/** The price steps one SKU sells on: its own when set, else the campaign's.
 *  A SKU that ships with another has a flat price: no steps. */
export function tiersFor(config: CampaignConfig, sku: string): PriceTier[] {
  if (config.shipsWith?.[sku]) return [];
  return config.skus[sku]?.priceTiers ?? config.priceTiers;
}

function checkTiers(tiers: unknown, where: string): void {
  if (!Array.isArray(tiers)) {
    throw new Error(`preorders: ${where} must be an array`);
  }
  let last = 0;
  for (const tier of tiers as PriceTier[]) {
    if (!Number.isSafeInteger(tier?.upTo) || tier.upTo <= last) {
      throw new Error(`preorders: ${where} need whole, increasing upTo values`);
    }
    if (!(typeof tier.off === 'number') || !(tier.off > 0) || tier.off >= 1) {
      throw new Error(`preorders: ${where} ${tier.upTo} needs an off share between 0 and 1`);
    }
    last = tier.upTo;
  }
}

export type CampaignState = {
  /** Paid units ordered since `countFrom`. */
  ordered: number;
  /** 1-based batch the next ordered unit falls into. */
  batch: number;
  batchUnits: number;
  /** Units already ordered inside that batch. */
  batchOrdered: number;
  /** The next unit comes out of paid stock. */
  paidStock: boolean;
  /** The SKU's first funding target (its first batch that is not paid
   *  stock), or null when every batch is paid stock. */
  target: number | null;
  /** Units ordered toward the first funding target. */
  targetOrdered: number;
  targetReached: boolean;
  /** The ship promise for the next ordered unit. */
  shipPromise: string;
  /** The next unit's batch has no ship date of its own: it ships a set time
   *  after its funding target is reached, so its date depends on this SKU. */
  shipsOnTarget?: boolean;
  /** Set for a SKU that ships with another (`CampaignConfig.shipsWith`): the
   *  lead SKU whose batch, target and promise this state mirrors. */
  shipsWith?: string;
  /** The target deadline as a date, "15 December 2026". Set by
   *  `applyCampaign`; absent in a bare `campaignState`. */
  deadline?: string;
  /** For a unit waiting on a funding target: the latest planned ship date
   *  if the target is reached by the deadline, "31 March 2027". */
  latestShip?: string | null;
  /** The ship-by day of a unit waiting on a funding target, YYYY-MM-DD:
   *  `shipsBy`. Set by `applyCampaign`; null for a batch with its own date. */
  shipByDay?: string | null;
  /** The reviewed delivery day of the next unit's batch for the buyer's
   *  region, YYYY-MM-DD; null when the batch names none. */
  deliveryByDay?: string | null;
  /** The batch's own ship text once its supplier order is placed, "ships
   *  early November 2026"; null for a batch waiting on a funding target. */
  shipsText?: string | null;
  /** Units left in the paid batch the next unit comes out of; null when the
   *  next unit is not paid stock. A cart line must not ask for more. */
  paidLeft?: number | null;
  /** The next unit still gets a price step, so Shopify's price is under
   *  retail. */
  earlyPrice: boolean;
  /** The current step's last unit, null once every step is used up. */
  tierUpTo: number | null;
  /** Units left in the current step, 0 once every step is used up. */
  tierLeft: number;
  /** Share off retail for the next unit, 0 past the last step. */
  tierOff: number;
  /** What the next unit costs, from retail and the step. Null without a
   *  retail price. */
  price: number | null;
  /** What a unit costs after this step: the next step's price, or retail.
   *  Null without a retail price, or when this is already retail. */
  nextPrice: number | null;
  /** US buyers only: the ladder in USD, set by `withMarketPrices`. */
  usLadder?: UsdLadderStep[];
  /** Only the current international price is verified; no future local price ladder is inferred. */
  internationalPrice?: boolean;
  /** Every configured batch up to the one after the current, in order:
   *  sold-out batches stay listed, and one before the current that does not
   *  serve the buyer's region is `other_region`. */
  batches: Array<{
    batch: number;
    units: number;
    status: 'sold_out' | 'current' | 'next' | 'other_region';
    shipPromise: string;
    /** Paid stock (Incutec already ordered it), not a funding target. */
    paid: boolean;
    /** Where the batch ships: EU only for Belgian paid stock. */
    regions: Region[];
    /** Units already allocated to the batch. */
    ordered: number;
  }>;
};

/** Accept `content/preorders.json`, or throw on anything malformed. */
export function parseCampaignConfig(body: unknown): CampaignConfig {
  const c = body as Partial<CampaignConfig> | null;
  if (!c || typeof c !== 'object') throw new Error('preorders: not an object');
  if (typeof c.countFrom !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(c.countFrom)) {
    throw new Error('preorders: countFrom must be YYYY-MM-DD');
  }
  if (typeof c.endsOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(c.endsOn)) {
    throw new Error('preorders: endsOn must be YYYY-MM-DD');
  }
  checkTiers(c.priceTiers, 'priceTiers');
  if (typeof c.pendingShips !== 'string' || !c.pendingShips.trim()) {
    throw new Error('preorders: pendingShips is required');
  }
  if (!isCalendarDay(c.shipsBy) || c.shipsBy <= c.endsOn) {
    throw new Error('preorders: shipsBy must be a calendar date after endsOn');
  }
  if (!c.skus || typeof c.skus !== 'object' || Array.isArray(c.skus)) {
    throw new Error('preorders: skus must be an object');
  }
  for (const [sku, entry] of Object.entries(c.skus)) {
    if (!entry || !Array.isArray(entry.batches) || !entry.batches.length) {
      throw new Error(`preorders: ${sku} needs at least one batch`);
    }
    for (const batch of entry.batches) {
      if (!Number.isSafeInteger(batch.units) || batch.units < 1) {
        throw new Error(`preorders: ${sku} has a batch without positive units`);
      }
      if (batch.paid && !batch.ships?.trim()) {
        throw new Error(`preorders: ${sku} paid batch needs a ship promise`);
      }
      if (batch.deliveryBy != null && !isCalendarDay(batch.deliveryBy)) throw new Error(`preorders: ${sku} deliveryBy must be a calendar date`);
      if (batch.deliveryByUS != null && !isCalendarDay(batch.deliveryByUS)) throw new Error(`preorders: ${sku} deliveryByUS must be a calendar date`);
      if (batch.deliveryByINT != null && !isCalendarDay(batch.deliveryByINT)) throw new Error(`preorders: ${sku} deliveryByINT must be a calendar date`);
      if (batch.regions !== undefined) {
        if (
          !Array.isArray(batch.regions) ||
          !batch.regions.length ||
          batch.regions.some((r) => !REGIONS.includes(r))
        ) {
          throw new Error(`preorders: ${sku} regions must list ${REGIONS.join(' or ')}`);
        }
      }
    }
    const last = entry.batches[entry.batches.length - 1];
    if (!last.paid && last.regions && REGIONS.some((r) => !last.regions!.includes(r))) {
      throw new Error(`preorders: ${sku} last funding batch must serve every region`);
    }
    if (entry.priceTiers !== undefined) checkTiers(entry.priceTiers, `${sku} priceTiers`);
  }
  if (c.soldUnder !== undefined) {
    const o = c.soldUnder;
    if (!o || typeof o.before !== 'string' || Number.isNaN(Date.parse(o.before))) {
      throw new Error('preorders: soldUnder.before must be an ISO timestamp');
    }
    if (!isCalendarDay(o.shipsBy) || !isCalendarDay(o.deliveryBy) || !isCalendarDay(o.deliveryByUS)) {
      throw new Error('preorders: soldUnder dates must be calendar dates');
    }
    if (typeof o.paidShips !== 'string' || !o.paidShips.trim()) throw new Error('preorders: soldUnder.paidShips is required');
  }
  if (c.shipsWith !== undefined) {
    if (!c.shipsWith || typeof c.shipsWith !== 'object' || Array.isArray(c.shipsWith)) {
      throw new Error('preorders: shipsWith must be an object');
    }
    for (const [sku, rule] of Object.entries(c.shipsWith)) {
      if (c.skus[sku]) throw new Error(`preorders: ${sku} is a campaign SKU and cannot ship with another`);
      const lead = rule && typeof rule.sku === 'string' ? c.skus[rule.sku] : undefined;
      if (!lead) throw new Error(`preorders: ${sku} ships with an unknown campaign SKU`);
      const pinned = (n: unknown) => Number.isSafeInteger(n) ? lead.batches[(n as number) - 1] : undefined;
      if (rule.batch !== undefined && !pinned(rule.batch)) {
        throw new Error(`preorders: ${sku} ships with ${rule.sku} batch ${rule.batch}, which does not exist`);
      }
      if (rule.batch !== undefined && !pinned(rule.batch)?.ships?.trim() && rule.stock !== undefined) {
        throw new Error(`preorders: ${sku} stock needs a ${rule.sku} batch with its own ship date`);
      }
      if ((rule.stock === undefined) !== (rule.after === undefined)) {
        throw new Error(`preorders: ${sku} needs stock and after together`);
      }
      if (rule.stock !== undefined) {
        if (rule.batch === undefined || !Number.isSafeInteger(rule.stock) || rule.stock < 0) {
          throw new Error(`preorders: ${sku} stock must be a whole number with a pinned batch`);
        }
        if (!pinned(rule.after) || rule.after === rule.batch) {
          throw new Error(`preorders: ${sku} after must name another ${rule.sku} batch`);
        }
      }
    }
  }
  if (c.usStock !== undefined) {
    const rule = c.usStock;
    const lead = rule && typeof rule.sku === 'string' ? c.skus[rule.sku] : undefined;
    const pinned = rule && Number.isSafeInteger(rule.batch) ? lead?.batches[rule.batch! - 1] : undefined;
    if (!lead || !pinned || rule.stock !== undefined || rule.after !== undefined) {
      throw new Error('preorders: usStock needs a campaign SKU and an existing batch, without stock or after');
    }
    if (!servesRegion(pinned, 'US')) throw new Error('preorders: usStock batch must serve the US');
  }
  return c as CampaignConfig;
}

/** The shared non-EU accessory rule, stored under the existing `usStock` key.
 *  Null for a listed SKU and for an EU buyer. */
export function usStockRule(config: CampaignConfig, sku: string, region: Region): ShipsWith | null {
  if (region === 'EU' || !config.usStock || config.skus[sku] || config.shipsWith?.[sku]) return null;
  return config.usStock;
}

function isCalendarDay(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}

/** The campaign's time zone: `endsOn` is a Brussels calendar day. */
export const CAMPAIGN_TIME_ZONE = 'Europe/Brussels';

/** Minutes a time zone is ahead of UTC at one instant, from Intl. */
function zoneOffsetMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const local = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((local - Math.floor(at.getTime() / 1000) * 1000) / 60000);
}

/**
 * The instant the funding deadline passes: midnight at the end of `endsOn`
 * in Brussels. For "2026-12-31" that is 2027-01-01 00:00 CET, which is
 * 2026-12-31T23:00:00Z. Up to 23:59:59.999 on `endsOn` the targets are open.
 */
export function campaignEndsAt(endsOn: string, timeZone = CAMPAIGN_TIME_ZONE): Date {
  const [y, m, d] = endsOn.split('-').map(Number);
  const nextMidnightUtc = Date.UTC(y, m - 1, d + 1);
  // The offset at that local midnight; one refinement covers a DST change
  // between the UTC guess and the real instant.
  let offset = zoneOffsetMinutes(new Date(nextMidnightUtc), timeZone);
  offset = zoneOffsetMinutes(new Date(nextMidnightUtc - offset * 60000), timeZone);
  return new Date(nextMidnightUtc - offset * 60000);
}

/** Whether the funding deadline has passed at `now`. */
export function fundingClosed(config: Pick<CampaignConfig, 'endsOn'>, now: Date = new Date()): boolean {
  return now.getTime() >= campaignEndsAt(config.endsOn).getTime();
}

/** A campaign day as the site writes it: "2026-12-31" is "31 December 2026". */
export function campaignDate(isoDay: string): string {
  const [y, m, d] = isoDay.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/**
 * The ship-by day of a funding target reached by the deadline, YYYY-MM-DD:
 * `shipsBy`, the date in terms 7bis.2. Every funding-target unit ships by
 * it, however early its target is reached.
 */
export function latestShipDay(config: Pick<CampaignConfig, 'shipsBy'>): string {
  return config.shipsBy;
}

/** The ship-by date in words: "31 March 2027". */
export function latestShipDate(config: Pick<CampaignConfig, 'shipsBy'>): string {
  return campaignDate(latestShipDay(config));
}

/** The price at a step off retail, to the cent. Null without retail. */
export function tierPrice(retail: number | null, off: number): number | null {
  if (retail == null || !Number.isFinite(retail)) return null;
  return Math.round(retail * (1 - off) * 100) / 100;
}

/** One step of the price ladder: units `from` to `to` (null: no end) of a
 *  SKU cost `price`. Unit numbers count paid units, starting at 1. */
export type LadderStep = {from: number; to: number | null; price: number};

/** A US ladder step: Shopify's US market prices each step itself, so a step
 *  is `approx` ("about US$X") when the live rounding cannot prove it. */
export type UsdLadderStep = LadderStep & {approx: boolean};

/**
 * The whole price ladder for one SKU, as plain steps: with the default tiers
 * and a retail price of 39.00, units 1 to 100 cost 31.20, units 101 to 250
 * cost 35.10 and from unit 251 on it is retail. Shown as text, never as a
 * struck-through price.
 */
export function priceLadder(retail: number, priceTiers: PriceTier[]): LadderStep[] {
  const steps: LadderStep[] = [];
  let from = 1;
  for (const tier of priceTiers) {
    const price = tierPrice(retail, tier.off);
    if (price == null || tier.upTo < from) continue;
    steps.push({from, to: tier.upTo, price});
    from = tier.upTo + 1;
  }
  steps.push({from, to: null, price: Math.round(retail * 100) / 100});
  return steps;
}

/**
 * The key that decides whether two cart lines ship together. A line with a
 * fixed date (in stock, paid stock, or a batch whose supplier order is
 * placed) groups by that date. A line whose batch ships only once its own
 * funding target is reached groups by SKU and batch: two products with the
 * same "ships by 31 March 2027 if the target is reached" text still wait for two
 * different targets.
 */
export function shipGroupKey(
  sku: string | null,
  shipPromise: string | null,
  campaign: CampaignState | null | undefined,
): string {
  if (campaign && campaign.shipsOnTarget && !campaign.paidStock) {
    // A SKU that ships with another waits for the lead's target.
    return `target:${campaign.shipsWith ?? sku ?? ''}:${campaign.batch}`;
  }
  return `date:${shipPromise ?? ''}`;
}

/** The line attribute wording for a line that ships earlier than the rest
 *  of its order: it ships once, with the latest line, so it carries that
 *  line's ship-by date. Null when `latest` names no ship
 *  date to state. */
export function mixedShipPromise(
  latest: Pick<CampaignState, 'shipByDay' | 'shipsText'>,
): string | null {
  let when: string | null = null;
  if (latest.shipByDay) {
    when = `by ${campaignDate(latest.shipByDay)}`;
  } else if (latest.shipsText) {
    const rest = latest.shipsText.replace(/^ships\s+/i, '');
    when = /^(?:(?:early|mid|late)[- ])?[A-Za-z]+ \d{4}$/i.test(rest) ? `in ${rest}` : rest;
  }
  if (!when) return null;
  return `ships with the rest of this order ${when}`;
}

/** The day that orders a line's date against the other lines of its cart:
 *  its delivery day, else its ship-by day. Null when the state has neither. */
export function shipOrderDay(
  state: Pick<CampaignState, 'shipByDay' | 'deliveryByDay'> | null | undefined,
): string | null {
  return state?.deliveryByDay ?? state?.shipByDay ?? null;
}

/** Whether a batch ships to `region`: a batch without `regions` serves all. */
export function servesRegion(batch: Pick<CampaignBatch, 'regions'>, region: Region): boolean {
  return !batch.regions || batch.regions.includes(region);
}

/**
 * The batches units are allocated to, in order. The last one has no end
 * when it is a funding target: its `units` is the target, and every later
 * unit ships with it. Past a last batch of paid stock, one such open funding
 * batch of the same size follows, for every region.
 */
function openBatches(batches: CampaignBatch[]): CampaignBatch[] {
  const last = batches[batches.length - 1];
  return last.paid ? [...batches, {units: last.units}] : batches;
}

function toRuns(ordered: PaidUnitsOf): UnitRuns {
  if (Array.isArray(ordered)) return ordered;
  const units = Math.max(0, Math.floor(Number.isFinite(ordered) ? ordered : 0));
  return units ? [{region: 'EU', units}] : [];
}

/** Every paid unit of a SKU, whatever its region: the count the price
 *  steps and the funding target read. */
export function totalUnits(ordered: PaidUnitsOf): number {
  return toRuns(ordered).reduce((sum, run) => sum + Math.max(0, Math.floor(run.units) || 0), 0);
}

/** The paid units of one region. */
export function regionUnits(ordered: PaidUnitsOf, region: Region): number {
  return toRuns(ordered)
    .filter((run) => run.region === region)
    .reduce((sum, run) => sum + Math.max(0, Math.floor(run.units) || 0), 0);
}

/** 0-based index of the batch the next unit for `region` falls into: the
 *  first batch that serves the region and still has room (the open last
 *  batch always has room). `fill` is the units already in each batch. */
function nextIndex(list: CampaignBatch[], fill: number[], region: Region): number {
  for (let i = 0; i < list.length; i += 1) {
    if (!servesRegion(list[i], region)) continue;
    if (i === list.length - 1 || fill[i] < list[i].units) return i;
  }
  return list.length - 1;
}

/**
 * Units per batch after allocating `ordered` in order: each unit takes the
 * first batch with room that serves its region. The result has one entry
 * per configured batch, plus the open batch past a last paid one.
 */
export function batchFill(batches: CampaignBatch[], ordered: PaidUnitsOf): number[] {
  const list = openBatches(batches);
  const fill = list.map(() => 0);
  for (const run of toRuns(ordered)) {
    let left = Math.max(0, Math.floor(run.units) || 0);
    while (left > 0) {
      const i = nextIndex(list, fill, run.region);
      const room = i === list.length - 1 ? left : Math.min(left, list[i].units - fill[i]);
      fill[i] += room;
      left -= room;
    }
  }
  return fill;
}

/**
 * Allocate one unit for `region` into `fill` (from {@link batchFill}, or
 * all zero) and return its 1-based batch and entry. `fill` is updated.
 */
export function allocateUnit(
  batches: CampaignBatch[],
  fill: number[],
  region: Region,
): {batch: number; entry: CampaignBatch} {
  const list = openBatches(batches);
  while (fill.length < list.length) fill.push(0);
  const index = nextIndex(list, fill, region);
  fill[index] += 1;
  return {batch: index + 1, entry: list[index]};
}

/** The 1-based batch the next unit for `region` falls into after `ordered`,
 *  without allocating it. */
export function nextBatch(
  batches: CampaignBatch[],
  ordered: PaidUnitsOf,
  region: Region = 'EU',
): {batch: number; entry: CampaignBatch} {
  const list = openBatches(batches);
  const index = nextIndex(list, batchFill(batches, ordered), region);
  return {batch: index + 1, entry: list[index]};
}

/** The 1-based batch that paid unit `unit` (1-based) of a SKU falls into
 *  when every earlier unit shipped to the EU. */
export function batchOfUnit(batches: CampaignBatch[], unit: number): {batch: number; entry: CampaignBatch} {
  return nextBatch(batches, Math.max(0, unit - 1), 'EU');
}

/**
 * The campaign state for one SKU after `ordered` paid units, for the next
 * unit of a buyer in `region`. Once a funding target is reached, later
 * units ship with it (see {@link openBatches}). A US unit never falls into
 * a batch that serves only the EU. The price steps and the funding target
 * count every region.
 */
export function campaignState(
  batches: CampaignBatch[],
  ordered: PaidUnitsOf,
  pendingShips: string,
  priceTiers: PriceTier[],
  retail: number | null = null,
  region: Region = 'EU',
): CampaignState {
  const units = totalUnits(ordered);
  const list = openBatches(batches);
  const fill = batchFill(batches, ordered);
  const index = nextIndex(list, fill, region);
  const current = list[index];

  const tierIndex = priceTiers.findIndex((t) => units < t.upTo);
  const tier = tierIndex < 0 ? null : priceTiers[tierIndex];

  const targetIndex = batches.findIndex((b) => !b.paid);
  const target = targetIndex >= 0 ? batches[targetIndex].units : null;
  const targetOrdered = target === null ? 0 : Math.min(target, fill[targetIndex]);
  const targetReached = target !== null && targetOrdered >= target;

  return {
    ordered: units,
    batch: index + 1,
    batchUnits: current.units,
    batchOrdered: fill[index],
    paidStock: Boolean(current.paid),
    target,
    targetOrdered,
    targetReached,
    shipPromise: batchPromise(current, pendingShips),
    shipsOnTarget: !current.ships?.trim(),
    deliveryByDay: batchDeliveryDay(current, region),
    shipsText: current.ships?.trim() || null,
    paidLeft: current.paid ? current.units - fill[index] : null,
    earlyPrice: tier !== null,
    tierUpTo: tier?.upTo ?? null,
    tierLeft: tier ? tier.upTo - units : 0,
    tierOff: tier?.off ?? 0,
    price: tierPrice(retail, tier?.off ?? 0),
    nextPrice: tier ? tierPrice(retail, priceTiers[tierIndex + 1]?.off ?? 0) : null,
    batches: batches.slice(0, index + 2).map((b, i) => ({
      batch: i + 1,
      units: b.units,
      status:
        i < index
          ? servesRegion(b, region) ? 'sold_out' : 'other_region'
          : i === index ? 'current' : 'next',
      shipPromise: batchPromise(b, pendingShips),
      paid: Boolean(b.paid),
      regions: b.regions ?? [...REGIONS],
      ordered: fill[i] ?? 0,
    })),
  };
}

/**
 * The state of a SKU that ships with a campaign SKU: the lead's batch,
 * target and ship promise, at a flat price, with no price step and no units
 * of its own toward the lead. `leadOrdered` is the lead's paid units and
 * `ordered` this SKU's own. A SKU with `stock` sells its first `stock` units
 * from the pinned batch like paid stock (a cart line is capped at what is
 * left), then ships with the `after` batch. Otherwise it is never paid
 * stock, so a cart line is not capped by the lead's batch.
 */
export function shipsWithState(
  config: CampaignConfig,
  rule: ShipsWith,
  leadOrdered: PaidUnitsOf,
  price: number | null,
  ordered: PaidUnitsOf = 0,
  region: Region = 'EU',
): CampaignState {
  const lead = config.skus[rule.sku];
  const own = regionUnits(ordered, 'EU');
  const {batch, fromStock} = shipsWithBatch(rule, lead.batches, region, own);
  const state = batch
    ? pinnedBatchState(lead.batches, batch, config.pendingShips, leadOrdered, region)
    : campaignState(lead.batches, leadOrdered, config.pendingShips, tiersFor(config, rule.sku), null, region);
  // A US buyer's accessory that the lead's EU-only batch would carry for an EU
  // buyer stays listed, muted, like the lead's own EU-only batch.
  const pinned = rule.batch === undefined ? undefined : lead.batches[rule.batch - 1];
  const skipped: CampaignState['batches'] =
    pinned && !state.batches.some((b) => b.batch === rule.batch) && !servesRegion(pinned, region)
      ? [{
          batch: rule.batch!,
          units: pinned.units,
          status: 'other_region',
          shipPromise: batchPromise(pinned, config.pendingShips),
          paid: Boolean(pinned.paid),
          regions: pinned.regions ?? [...REGIONS],
          ordered: 0,
        }]
      : [];
  // An accessory that sells stock now and ships with the `after` batch past
  // it lists that batch next, as the lead does, so the rows match the US buy
  // box (where `after` is the buyer's own batch).
  const afterBatch = rule.stock !== undefined && rule.after !== undefined ? lead.batches[rule.after - 1] : undefined;
  const upcoming: CampaignState['batches'] =
    afterBatch && rule.after !== undefined && !state.batches.some((b) => b.batch === rule.after) && servesRegion(afterBatch, region)
      ? [{
          batch: rule.after,
          units: afterBatch.units,
          status: 'next',
          shipPromise: batchPromise(afterBatch, config.pendingShips),
          paid: Boolean(afterBatch.paid),
          regions: afterBatch.regions ?? [...REGIONS],
          ordered: 0,
        }]
      : [];
  return {
    ...state,
    batches: [...skipped, ...state.batches, ...upcoming],
    paidStock: fromStock,
    paidLeft: fromStock ? rule.stock! - own : null,
    shipsWith: rule.sku,
    earlyPrice: false,
    tierUpTo: null,
    tierLeft: 0,
    tierOff: 0,
    price,
    nextPrice: null,
  };
}

/**
 * The lead batch a unit of a SKU that ships with another takes, before the
 * lead's own count decides: the pinned `batch`, or with `stock` the pinned
 * batch while `euUnits` (this SKU's EU paid units) are under the stock and
 * `after` past it. Stock is on hand in Belgium, so a US unit never takes
 * it, and a pinned batch that does not serve the region is skipped: a US
 * unit takes `after` when that serves the US, otherwise the batch the
 * lead's next US unit falls into (`batch` undefined).
 */
export function shipsWithBatch(
  rule: ShipsWith,
  leadBatches: CampaignBatch[],
  region: Region,
  euUnits: number,
): {batch: number | undefined; fromStock: boolean} {
  const serves = (n: number | undefined) =>
    n !== undefined && Boolean(leadBatches[n - 1]) && servesRegion(leadBatches[n - 1], region);
  if (region === 'EU') {
    const fromStock = rule.stock !== undefined && euUnits < rule.stock;
    const batch = rule.stock !== undefined && !fromStock ? rule.after : rule.batch;
    return {batch: batch === undefined || serves(batch) ? batch : undefined, fromStock};
  }
  if (rule.stock !== undefined) return {batch: serves(rule.after) ? rule.after : undefined, fromStock: false};
  return {batch: serves(rule.batch) ? rule.batch : undefined, fromStock: false};
}

/** A lead batch as the state of a SKU pinned to it: its own ship date, or
 *  its funding target counted from the lead's `leadOrdered` paid units. */
function pinnedBatchState(
  batches: CampaignBatch[],
  batch: number,
  pendingShips: string,
  leadOrdered: PaidUnitsOf,
  region: Region = 'EU',
): CampaignState {
  const entry = batches[batch - 1];
  const promise = batchPromise(entry, pendingShips);
  const dated = Boolean(entry.ships?.trim());
  const targetOrdered = dated ? 0 : Math.min(entry.units, batchFill(batches, leadOrdered)[batch - 1] ?? 0);
  return {
    ordered: 0,
    batch,
    batchUnits: entry.units,
    batchOrdered: 0,
    paidStock: false,
    target: dated ? null : entry.units,
    targetOrdered,
    targetReached: !dated && targetOrdered >= entry.units,
    shipPromise: promise,
    shipsOnTarget: !dated,
    deliveryByDay: batchDeliveryDay(entry, region),
    shipsText: entry.ships?.trim() || null,
    paidLeft: null,
    earlyPrice: false,
    tierUpTo: null,
    tierLeft: 0,
    tierOff: 0,
    price: null,
    nextPrice: null,
    batches: [{batch, units: entry.units, status: 'current', shipPromise: promise, paid: Boolean(entry.paid), regions: entry.regions ?? [...REGIONS], ordered: 0}],
  };
}

/**
 * Apply the campaign to a catalog. Only a variant the catalog policy already
 * sells as `preorder` and that has a campaign entry is touched: it gets the
 * campaign state and the batch's ship promise. With `units` null (the paid
 * counts could not be verified) those variants close as sold out, because
 * their ship promise depends on the count. A variant Shopify still prices
 * under its step closes too, until the step is written.
 *
 * After the funding deadline (`endsOn`, end of day in Brussels) a variant
 * whose next unit would wait for a funding target closes as sold out: its
 * ship promise names a deadline that has passed. Paid stock, and a batch
 * with its own ship date (its supplier order is placed), keep selling.
 *
 * A SKU in `shipsWith` gets its lead's state at its own flat price
 * ({@link shipsWithState}) and closes on the same conditions, except the
 * price-step check: it has no steps.
 *
 * `region` is the buyer's: the batch, ship promise and paid-batch cap are
 * that region's next unit. The price step and its check count every region.
 */
export function applyCampaign(
  catalog: Catalog,
  config: CampaignConfig,
  units: Record<string, PaidUnitsOf> | null,
  now: Date = new Date(),
  region: Region = 'EU',
): Catalog {
  const closed = fundingClosed(config, now);
  return {
    ...catalog,
    campaign_counts: units ? 'verified' : 'unavailable',
    products: catalog.products.map((product) => ({
      ...product,
      variants: product.variants.map((variant): CatalogVariant => {
        const entry = config.skus[variant.sku];
        // A US buyer's unit of any other SKU ships with a US-serving batch:
        // an in-stock item becomes a preorder for that batch. Belgian stock
        // stays EU only. Sold out stays sold out.
        const usRule = usStockRule(config, variant.sku, region);
        const usIn = region !== 'EU' && variant.availability === 'in_stock' && Boolean(entry || config.shipsWith?.[variant.sku] || usRule);
        const rule = config.shipsWith?.[variant.sku] ?? usRule ?? undefined;
        if ((!entry && !rule) || (variant.availability !== 'preorder' && !usIn)) return variant;
        if (!units) {
          return {...variant, availability: 'sold_out', ship_promise: null, campaign: null};
        }
        if (rule) {
          const state = shipsWithState(
            config,
            rule,
            units[rule.sku] ?? 0,
            variant.price,
            units[variant.sku] ?? 0,
            region,
          );
          if (closed && state.shipsOnTarget) {
            return {...variant, availability: 'sold_out', ship_promise: null, campaign: null};
          }
          const dated: CampaignState = {
            ...state,
            deadline: campaignDate(config.endsOn),
            latestShip: state.shipsOnTarget ? latestShipDate(config) : null,
            shipByDay: state.shipsOnTarget ? latestShipDay(config) : null,
          };
          return {...variant, availability: 'preorder', ship_promise: state.shipPromise, campaign: dated};
        }
        if (!entry) return variant;
        const state = campaignState(
          entry.batches,
          units[variant.sku] ?? 0,
          config.pendingShips,
          tiersFor(config, variant.sku),
          variant.compare_price,
          region,
        );
        if (closed && state.shipsOnTarget && !state.paidStock) {
          return {...variant, availability: 'sold_out', ship_promise: null, campaign: null};
        }
        // Shopify still charges under this SKU's step, so the step has not
        // been written yet: close rather than sell under it.
        if (state.price != null && variant.price < state.price - 0.005) {
          return {...variant, availability: 'sold_out', ship_promise: null, campaign: null};
        }
        const dated: CampaignState = {
          ...state,
          deadline: campaignDate(config.endsOn),
          latestShip: state.shipsOnTarget && !state.paidStock ? latestShipDate(config) : null,
          shipByDay: state.shipsOnTarget && !state.paidStock ? latestShipDay(config) : null,
        };
        return {...variant, availability: 'preorder', ship_promise: state.shipPromise, campaign: dated};
      }),
    })),
  };
}

/** Whether any catalog variant is a campaign preorder, i.e. needs counts. */
export function needsCampaignCounts(catalog: Catalog, config: CampaignConfig, region: Region = 'EU'): boolean {
  return catalog.products.some((product) =>
    product.variants.some(
      (variant) =>
        (variant.availability === 'preorder' &&
          Boolean(config.skus[variant.sku] || config.shipsWith?.[variant.sku])) ||
        // A non-EU buyer's in-stock items ship with a campaign batch.
        (region !== 'EU' &&
          variant.availability === 'in_stock' &&
          Boolean(config.skus[variant.sku] || config.shipsWith?.[variant.sku] || usStockRule(config, variant.sku, region))),
    ),
  );
}

/** How much ship text a surface shows: `short` for a cart line, a dialog
 *  card or a listing card; `long` once, in the PDP buy box
 *  and as the one mixed-date note of a cart. */
export type ShipLabelForm = 'short' | 'long';

const SHORT_MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];
const LONG_MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

/** "31 March 2027" as "31 Mar 2027"; null for anything else. */
export function shortCampaignDate(longDate: string | null | undefined): string | null {
  const match = longDate?.trim().match(/^(\d{1,2}) ([A-Za-z]+) (\d{4})$/);
  if (!match) return null;
  const month = LONG_MONTHS.indexOf(match[2].toLowerCase());
  return month < 0 ? null : `${Number(match[1])} ${SHORT_MONTHS[month]} ${match[3]}`;
}

function capitalizeFirst(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

/** The ship-by date a funding-target promise names, "by 31 March 2027 if
 *  the target is reached", or null when it names none. */
function promiseLatestShip(promise: string): string | null {
  const match = promise.match(/\bby (\d{1,2} [A-Za-z]+ \d{4}) if\b/);
  return match ? match[1] : null;
}

function fundingShort(latestShip: string | null): string {
  const date = shortCampaignDate(latestShip);
  return date ? `Ships by ${date} if the target is reached` : 'Funding target';
}

/** The parts of a dated promise: "ships early November 2026" gives
 *  `{when: 'early Nov 2026'}`.
 *  Null when the promise names no month and year. Every surface builds its
 *  short ship line from these, so PDP, listings, cart, dialog and checkout
 *  name the same month and qualifier. */
export function datedShipParts(
  promise: string | null | undefined,
): {when: string} | null {
  const text = promise?.trim() ?? '';
  const match = text.match(/\b(?:(early|mid|late)[- ])?([A-Za-z]+) (\d{4})\b/i);
  const month = match ? LONG_MONTHS.indexOf(match[2].toLowerCase()) : -1;
  if (!match || month < 0) return null;
  const qualifier = match[1] ? `${match[1].toLowerCase()} ` : '';
  return {when: `${qualifier}${SHORT_MONTHS[month]} ${match[3]}`};
}

/** A dated promise, short: "Ships early Nov 2026".
 *  A promise that names no month and year keeps its own words. */
function datedShort(promise: string): string {
  const parts = datedShipParts(promise);
  if (!parts) return capitalizeFirst(promise.trim());
  return `Ships ${parts.when}`;
}

function longSentence(promise: string): string {
  const text = capitalizeFirst(promise.trim());
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/**
 * The ship text for the next unit of a campaign SKU, in two lengths.
 *
 * short: "Ships by 31 Mar 2027 if the target is reached" for a unit that waits for a funding
 * target, and the batch month for everything else, "Ships Nov 2026". long: the full promise as a sentence, "Ships
 * by 31 March 2027 if the target is reached by 15 December 2026, otherwise
 * you choose a refund or to wait."
 */
export function shipLabel(
  campaign: Pick<CampaignState, 'shipPromise' | 'paidStock' | 'shipsOnTarget' | 'latestShip'>,
  form: ShipLabelForm,
): string {
  if (form === 'long') return longSentence(campaign.shipPromise);
  if (campaign.shipsOnTarget && !campaign.paidStock) {
    return fundingShort(campaign.latestShip ?? promiseLatestShip(campaign.shipPromise));
  }
  return datedShort(campaign.shipPromise);
}

/**
 * `shipLabel` for a surface that only has the promise text, such as a cart
 * line or the add-to-cart dialog: a promise that names a latest ship date
 * "if the target is reached" is a funding target. Null without a promise.
 */
export function shipLabelFromPromise(
  promise: string | null | undefined,
  form: ShipLabelForm,
): string | null {
  const text = promise?.trim();
  if (!text) return null;
  if (form === 'long') return longSentence(text);
  const latest = promiseLatestShip(text);
  return latest || /\bafter its target\b/.test(text) ? fundingShort(latest) : datedShort(text);
}

/**
 * The one long ship sentence a cart shows: the funding-target promise in
 * full, once, when the cart holds a line waiting for a funding target. Every
 * line then carries only its short label. Null when no line waits for a
 * target.
 */
export function cartShipNote(promises: Array<string | null | undefined>): string | null {
  for (const promise of promises) {
    const text = promise?.trim();
    if (text && (promiseLatestShip(text) || /\bafter its target\b/.test(text))) {
      return shipLabelFromPromise(text, 'long');
    }
  }
  return null;
}

/**
 * The batch a ship promise names, as "March 2027": the ship-by month of a
 * funding-target promise, else the first month and year it names ("ships
 * early November 2026" gives "November 2026"). Null when it names none.
 */
export function promiseBatchMonth(promise: string | null | undefined): string | null {
  const text = promise?.trim() ?? '';
  const match = (promiseLatestShip(text) ?? text).match(/\b([A-Za-z]+) (\d{4})\b/);
  const month = match ? LONG_MONTHS.indexOf(match[1].toLowerCase()) : -1;
  return month < 0 ? null : `${capitalizeFirst(LONG_MONTHS[month])} ${match![2]}`;
}
