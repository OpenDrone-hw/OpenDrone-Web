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
 * to 250 at 10% off, then retail, counted the way the product page step bar
 * reads for an EU buyer ({@link tierUnits}). `app/lib/shopify-price-tier.ts` writes each
 * step to Shopify; until it has, a SKU whose Shopify price is below its tier
 * closes rather than sell under it.
 *
 * Kept pure and bundler-free (relative imports, no worker APIs) so the
 * node:test suites can load it.
 */

import type {Catalog, CatalogVariant} from './catalog.ts';
import {CAMPAIGN_CONFIRMED} from './campaign-file.ts';
import {EU_COUNTRY_CODES, IMPORT_COUNTRY_CODES} from './eu-countries.ts';

/** Allocation regions: EU member states, the US, NEAR (UK, Switzerland,
 *  Norway: `IMPORT_COUNTRY_CODES`, the March batch with import VAT and duties
 *  paid on delivery; its own region so it can get a stock pool later), or
 *  other international destinations. Missing country information retains the
 *  historical EU default. */
export type Region = 'EU' | 'US' | 'NEAR' | 'INT';

export const REGIONS: readonly Region[] = ['EU', 'US', 'NEAR', 'INT'];

/** The region of a shipping country (ISO 3166-1 alpha-2). */
export function regionOf(country: string | null | undefined): Region {
  const code = country?.trim().toUpperCase();
  if (code === 'US') return 'US';
  if (code && IMPORT_COUNTRY_CODES.includes(code)) return 'NEAR';
  return code && /^[A-Z]{2}$/.test(code) && !EU_COUNTRY_CODES.includes(code) ? 'INT' : 'EU';
}

/** The region of a destination served through Shopify's international market: NEAR for GB, CH, NO, else INT. */
export function internationalRegion(country: string | null | undefined): Region {
  return regionOf(country) === 'NEAR' ? 'NEAR' : 'INT';
}

/** A paid line's recorded attributes, as the cart writes them (shopify-storefront.ts):
 *  `_batch` "SKU:N", `_ship_region` (absent: EU), the promise in `Preorder` or `_ship_promise`. */
export type RecordedLine = {
  sku?: string | null;
  attributes?: ReadonlyArray<{key: string; value?: string | null}> | null;
};

const attr = (line: RecordedLine, key: string) => line.attributes?.find((a) => a.key === key)?.value?.trim() || null;

/**
 * True for a line sold to a non-EU destination (recorded `_ship_region` INT
 * or NEAR) with a paid batch: its `_batch` names a paid batch, or (a line
 * from before `_batch`) its promise is a paid batch's `ships`. Before
 * 2026-11-03 paid batch 1 served the EU and every other non-US destination
 * together (GB, CH and NO were INT), so such a line was sold batch 1 stock and
 * keeps it: it fills the batches as an EU unit (`lineAllocationRegion`).
 * New non-EU carts never record a paid batch (`paidRegions` ["EU"]), and an
 * EU line shipped abroad records no non-EU region, so neither is kept.
 * Read from the order itself, so it does not depend on when a deploy happens.
 */
export function grandfatheredPaidLine(config: Pick<CampaignConfig, 'skus' | 'soldUnder'>, line: RecordedLine): boolean {
  const recorded = attr(line, '_ship_region');
  if (recorded !== 'INT' && recorded !== 'NEAR') return false;
  const batch = attr(line, '_batch');
  const match = batch ? /^([A-Za-z0-9-]+):(\d+)$/.exec(batch) : null;
  if (match) return config.skus[match[1]]?.batches[Number(match[2]) - 1]?.paid === true;
  const promise = attr(line, 'Preorder') ?? attr(line, '_ship_promise');
  const sku = line.sku?.trim();
  return Boolean(promise && sku && paidPromises(config, sku).has(promise));
}

/** The region a line's units fill the batches in: its shipping region, or
 *  EU for a grandfathered paid line ({@link grandfatheredPaidLine}). */
export function lineAllocationRegion(region: Region, grandfathered: boolean): Region {
  return grandfathered && isInternationalRegion(region) ? 'EU' : region;
}

/** The paid stack's ship promise as the /preorder page shows it to a buyer
 *  in `region`: only where paid stock ships (`paidRegions`, the EU). NEAR,
 *  INT and US buyers see no "ships late November" lane and no "order them
 *  separately" line. */
export function stackPaidShips(region: Region, paidShips: string | null, paidRegions: readonly Region[] | undefined): string | null {
  return (paidRegions ?? ['EU']).includes(region) ? paidShips : null;
}

/** True for a region outside the EU and the US: NEAR and INT ship through
 *  Shopify's international market (destination currency, rates at checkout). */
export function isInternationalRegion(region: Region): boolean {
  return region === 'NEAR' || region === 'INT';
}

/** Paid units of one SKU in order, oldest first, as runs of one region:
 *  what the batch allocation needs, since a batch may serve one region
 *  only. A plain number is that many EU units. A run with `march` comes
 *  from an order that also holds a line not shipping with paid stock: it
 *  ships as one parcel with that line, so its units skip paid batches
 *  ({@link shipsOnlyWithPaid}, founder 2026-11-01). */
export type UnitRuns = Array<{region: Region; units: number; march?: boolean}>;

/** A SKU's paid units: a count (all EU) or its runs by region. */
export type PaidUnitsOf = number | UnitRuns;

export type CampaignBatch = {
  /** Units in this batch: the supplier order quantity. */
  units: number;
  /** Paid stock only: units of `units` held back from sale (review units).
   *  Customers can buy `units - reserved` ({@link sellableUnits}); reserved
   *  units are not orders, so price steps and funding targets never count them. */
  reserved?: number;
  /** Paid stock: Incutec has already ordered this batch. */
  paid?: boolean;
  /** The ship promise once the supplier order is placed, e.g.
   *  "ships early November 2026". Required for paid stock. */
  ships?: string;
  /** Paid stock that is on hand in Belgium: it ships within a few working
   *  days of the order, so `ships` names no month ("in stock in Belgium,
   *  ships to EU addresses in a few working days") and the batch has no
   *  delivery date of its own (terms 7.1 govern). */
  inStock?: boolean;
  /** Reviewed final customer delivery date, separate from dispatch. The ship promise names it; null leaves it out. */
  deliveryBy?: string | null;
  /** The same for a US buyer (shipped direct by the fulfilment partner, duties included); a US promise names only this one, and leaves the delivery
   *  date out without it. */
  deliveryByUS?: string | null;
  /** A separately agreed international arrival deadline; never inherits EU or US dates. */
  deliveryByINT?: string | null;
  /** The regions this batch ships to; absent means every region, except a
   *  paid batch, which takes the campaign's `paidRegions`. A unit of another
   *  region skips it for the next batch that serves the destination. A SKU's
   *  last funding batch serves every region. */
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
  // NEAR takes a funding batch like INT. Should a paid batch ever serve NEAR
  // (`paidRegions`), it keeps that batch's `deliveryBy`, as the EU does.
  if (region === 'NEAR') return (batch.paid ? batch.deliveryBy : batch.deliveryByINT) ?? null;
  return (region === 'US' ? batch.deliveryByUS : region === 'INT' ? batch.deliveryByINT : batch.deliveryBy) ?? null;
}

export type CampaignConfig = {
  /** First day whose paid Shopify orders count, YYYY-MM-DD. */
  countFrom: string;
  /** Ship promise for a unit in a batch whose supplier order is not placed.
   *  Left out of a confirmed campaign's file: the parser writes it from
   *  `shipsBy` ("ships by 31 March 2027"), so the date lives in one field. */
  pendingShips: string;
  /** Every funding batch is produced whatever its count (founder 2026-11-11,
   *  terms 2.9): no unit waits for a target, `pendingShips` names the ship-by
   *  date only, the meters read as a confirmed batch and no SKU closes for a
   *  missed target. Absent or false: a batch without `ships` is a funding
   *  target with the deadline `endsOn`. */
  confirmed?: boolean;
  /** Confirmed campaigns only: what happens to the funding batches after
   *  `endsOn` ({@link AfterEndsOn}). Absent: `retail`. */
  afterEndsOn?: AfterEndsOn;
  /** The one ship-by date of every funding-target unit, YYYY-MM-DD: a
   *  target reached early does not ship earlier than planned. */
  shipsBy: string;
  /** Last day a funding target can be reached, YYYY-MM-DD. A buyer whose
   *  target is missed by then chooses a refund or to keep waiting. */
  endsOn: string;
  /** Price steps by paid units, in order: `upTo` is the last unit of the
   *  step and `off` its share off retail. Past the last step: retail. */
  priceTiers: PriceTier[];
  /** Where paid stock (Belgium) ships: the regions of every paid batch that
   *  lists none of its own. The one entry that decides who gets batch 1
   *  (founder 2026-11-03: the EU only; NEAR, INT and the US take March). */
  paidRegions?: Region[];
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
  /** What earlier orders were promised, oldest first. An order created
   *  before an entry's `before` (ISO timestamp) keeps that entry's promises
   *  on its account page, in the hold pass and in the notify scripts instead
   *  of the current ones (terms 7bis.3 and 15.1: a later version never
   *  changes what an existing order was promised). One entry, or a list. */
  soldUnder?: SoldUnder | SoldUnder[];
  /** The instant the buy now or pre-order choice went live (ISO timestamp,
   *  set with `BATCH_CHOICE = "1"`). From then on an order line of a board's
   *  `Pre-order` variant is a March unit ({@link preorderChoiceLine}); before
   *  it that variant sold batch 1 stock. Absent: the choice never ran. */
  choiceFrom?: string;
};

/** What the funding batches do after `endsOn` in a confirmed campaign:
 *  `closed` stops their ordering, `retail` keeps it open at the retail price
 *  (no price step), `earlyBird` keeps it open with the price steps running. */
export type AfterEndsOn = 'closed' | 'retail' | 'earlyBird';
export const AFTER_ENDS_ON: readonly AfterEndsOn[] = ['closed', 'retail', 'earlyBird'];

export type SoldUnder = {
  before: string;
  /** The ship-by date of that time, when it differed. */
  shipsBy?: string;
  /** The funding promise those orders carry, when it differed. One that
   *  names a target ("by <date> if the target is reached by <date>, ...")
   *  is still recognised everywhere ({@link fundingPromise}). */
  pendingShips?: string;
  /** Ship promise of a paid batch, e.g. "ships early November 2026". */
  paidShips: string;
  /** Delivery day those orders were given for paid stock, YYYY-MM-DD. */
  paidDeliveryBy?: string;
  /** Funding-target batch delivery days, YYYY-MM-DD, when they differed. */
  deliveryBy?: string;
  deliveryByUS?: string;
};

/** `soldUnder` as a list, oldest first. */
export function soldUnderEras(config: Pick<CampaignConfig, 'soldUnder'>): SoldUnder[] {
  const eras = config.soldUnder === undefined ? [] : Array.isArray(config.soldUnder) ? config.soldUnder : [config.soldUnder];
  return [...eras].sort((a, b) => Date.parse(a.before) - Date.parse(b.before));
}

/** The campaign as an order created at `createdAt` was sold: same batches,
 *  the promises of the earliest `soldUnder` entry it falls before. Unchanged
 *  for an order after the last entry. */
export function configSoldUnder(config: CampaignConfig, createdAt: string | undefined): CampaignConfig {
  const old = createdAt ? soldUnderEras(config).find((era) => Date.parse(createdAt) < Date.parse(era.before)) : undefined;
  if (!old) return config;
  const skus: CampaignConfig['skus'] = {};
  for (const [sku, entry] of Object.entries(config.skus)) {
    skus[sku] = {
      ...entry,
      batches: entry.batches.map((b) =>
        b.paid
          ? {...b, inStock: undefined, ships: old.paidShips, deliveryBy: old.paidDeliveryBy ?? b.deliveryBy}
          : {
              ...b,
              deliveryBy: b.deliveryBy && old.deliveryBy ? old.deliveryBy : b.deliveryBy,
              deliveryByUS: b.deliveryByUS && old.deliveryByUS ? old.deliveryByUS : b.deliveryByUS,
            },
      ),
    };
  }
  return {...config, shipsBy: old.shipsBy ?? config.shipsBy, pendingShips: old.pendingShips ?? config.pendingShips, skus};
}

/** Every ship promise a paid batch of `sku` has carried: its `ships` today
 *  and the `paidShips` of each `soldUnder` entry. A line from before the
 *  `_batch` attribute is matched to paid stock by these. */
export function paidPromises(config: Pick<CampaignConfig, 'skus' | 'soldUnder'>, sku: string): Set<string> {
  const out = new Set<string>();
  const batches = config.skus[sku]?.batches ?? [];
  if (!batches.some((b) => b.paid)) return out;
  for (const b of batches) if (b.paid && b.ships?.trim()) out.add(b.ships.trim());
  for (const era of soldUnderEras(config)) out.add(era.paidShips.trim());
  return out;
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
export function tiersFor(config: CampaignConfig, sku: string, now: Date = new Date()): PriceTier[] {
  if (config.shipsWith?.[sku]) return [];
  // A confirmed campaign that stays open at retail after `endsOn` has no
  // price step from then on: the storefront, the step bar and the Shopify
  // price writer (shopify-price-tier.ts) all read this one list.
  if (afterEndsOn(config, now) === 'retail') return [];
  return config.skus[sku]?.priceTiers ?? config.priceTiers;
}

/**
 * What applies to the funding batches of a confirmed campaign at `now`:
 * null before the end of `endsOn` (and always for a campaign that is not
 * confirmed, whose deadline closes unreached targets instead), else the
 * configured mode, `retail` when none is set.
 */
export function afterEndsOn(
  config: Pick<CampaignConfig, 'confirmed' | 'afterEndsOn' | 'endsOn'>,
  now: Date = new Date(),
): AfterEndsOn | null {
  if (!config.confirmed || !fundingClosed(config, now)) return null;
  return config.afterEndsOn ?? 'retail';
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
  /** The campaign is confirmed (`CampaignConfig.confirmed`): this unit's
   *  funding batch is produced whatever its count, so `targetReached` is
   *  true and nothing reads as waiting for a target. Set by `applyCampaign`. */
  confirmed?: boolean;
  /** The next unit is paid stock on hand (`CampaignBatch.inStock`): it ships
   *  within a few working days and has no ship month or delivery day. */
  inStock?: boolean;
  /** The next unit still gets a price step, so Shopify's price is under
   *  retail. */
  earlyPrice: boolean;
  /** The current step's last unit, null once every step is used up. */
  tierUpTo: number | null;
  /** Units left in the current step, 0 once every step is used up. */
  tierLeft: number;
  /** The units the price step counts ({@link tierUnits}); absent on a state
   *  without steps. */
  tierOrdered?: number;
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
  if (!isCalendarDay(c.shipsBy) || c.shipsBy <= c.endsOn) {
    throw new Error('preorders: shipsBy must be a calendar date after endsOn');
  }
  // A confirmed campaign's promise is the ship-by date alone, so it is
  // written from `shipsBy` and the date is typed once.
  const pendingShips =
    c.pendingShips === undefined && c.confirmed === true ? confirmedShipPromise(c.shipsBy) : c.pendingShips;
  if (typeof pendingShips !== 'string' || !pendingShips.trim()) {
    throw new Error('preorders: pendingShips is required');
  }
  if (!c.skus || typeof c.skus !== 'object' || Array.isArray(c.skus)) {
    throw new Error('preorders: skus must be an object');
  }
  if (c.paidRegions !== undefined) {
    if (!Array.isArray(c.paidRegions) || !c.paidRegions.length || c.paidRegions.some((r) => !REGIONS.includes(r))) {
      throw new Error(`preorders: paidRegions must list ${REGIONS.join(' or ')}`);
    }
    // Every reader after this point sees the regions on the paid batch itself.
    for (const entry of Object.values(c.skus)) {
      for (const batch of entry?.batches ?? []) {
        if (batch?.paid && batch.regions === undefined) batch.regions = [...c.paidRegions];
      }
    }
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
      if (batch.inStock !== undefined) {
        if (typeof batch.inStock !== 'boolean') throw new Error(`preorders: ${sku} inStock must be true or false`);
        if (batch.inStock && !batch.paid) throw new Error(`preorders: ${sku} inStock needs a paid batch`);
      }
      if (batch.reserved !== undefined) {
        if (!batch.paid) throw new Error(`preorders: ${sku} reserved units need a paid batch`);
        if (!Number.isSafeInteger(batch.reserved) || batch.reserved < 0 || batch.reserved >= batch.units) {
          throw new Error(`preorders: ${sku} reserved must be a whole number from 0 to below units`);
        }
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
  if (c.choiceFrom !== undefined && (typeof c.choiceFrom !== 'string' || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(c.choiceFrom) || !Number.isFinite(Date.parse(c.choiceFrom)))) {
    throw new Error('preorders: choiceFrom must be an ISO timestamp in UTC');
  }
  if (c.confirmed !== undefined && typeof c.confirmed !== 'boolean') throw new Error('preorders: confirmed must be true or false');
  if (c.afterEndsOn !== undefined && !AFTER_ENDS_ON.includes(c.afterEndsOn)) {
    throw new Error(`preorders: afterEndsOn must be ${AFTER_ENDS_ON.join(', ')}`);
  }
  if (c.soldUnder !== undefined) {
    for (const o of Array.isArray(c.soldUnder) ? c.soldUnder : [c.soldUnder]) {
      if (!o || typeof o.before !== 'string' || Number.isNaN(Date.parse(o.before))) {
        throw new Error('preorders: soldUnder.before must be an ISO timestamp');
      }
      for (const day of [o.shipsBy, o.deliveryBy, o.deliveryByUS, o.paidDeliveryBy]) {
        if (day !== undefined && !isCalendarDay(day)) throw new Error('preorders: soldUnder dates must be calendar dates');
      }
      if (typeof o.paidShips !== 'string' || !o.paidShips.trim()) throw new Error('preorders: soldUnder.paidShips is required');
      if (o.pendingShips !== undefined && (typeof o.pendingShips !== 'string' || !o.pendingShips.trim())) {
        throw new Error('preorders: soldUnder.pendingShips must be text');
      }
    }
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
  return {...c, pendingShips} as CampaignConfig;
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

/** The promise of a confirmed batch: "ships by 31 March 2027". */
export function confirmedShipPromise(shipsBy: string): string {
  return `ships by ${campaignDate(shipsBy)}`;
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
  // A confirmed batch waits for no target: every line of it ships together
  // by the one ship-by date, so they share one group. It is not a `date:`
  // group: a cart of stock and this batch still splits (`splitPlan`).
  if (campaign && campaign.shipsOnTarget && !campaign.paidStock && campaign.confirmed) {
    return `batch:${campaign.shipByDay ?? shipPromise ?? ''}`;
  }
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
  state: (Pick<CampaignState, 'shipByDay' | 'deliveryByDay'> & Partial<Pick<CampaignState, 'inStock' | 'paidStock'>>) | null | undefined,
): string | null {
  // Stock on hand ships now: it sorts before every dated line.
  return state?.deliveryByDay ?? state?.shipByDay ?? (state?.inStock && state.paidStock ? STOCK_ORDER_DAY : null);
}

/** The order day of stock on hand: before any real date. */
export const STOCK_ORDER_DAY = '0000-00-00';

/** Whether a batch ships to `region`: a batch without `regions` serves all. */
export function servesRegion(batch: Pick<CampaignBatch, 'regions'>, region: Region): boolean {
  return !batch.regions || batch.regions.includes(region);
}

/** The units customers can buy from a batch: its supplier quantity less
 *  any `reserved` units held back from sale. Every batch cap, batch count
 *  and batch tag uses this, never `units` alone. */
export function sellableUnits(batch: Pick<CampaignBatch, 'units' | 'reserved'>): number {
  return batch.units - (batch.reserved ?? 0);
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

/**
 * Whether an order ships with paid stock only (founder 2026-11-01): every
 * line with units is a campaign SKU that has a paid batch, or a `shipsWith`
 * SKU pinned to a paid batch (a stocked one only while its units fit the
 * stock). Any other line, a motor, frame, receiver or prop, makes the whole
 * order ship in March, boards included, so its units skip paid batches.
 * `stockUsed` is the units each stocked SKU has already taken from stock.
 */
export function shipsOnlyWithPaid(
  config: Pick<CampaignConfig, 'skus' | 'shipsWith'>,
  lines: Array<{sku: string | null | undefined; quantity: number; preorder?: boolean}>,
  stockUsed: Record<string, number> = {},
): boolean {
  for (const line of lines) {
    if (!(line.quantity > 0)) continue;
    // The buyer chose the pre-order variant of a board ({@link preorderChoiceLine}).
    if (line.preorder) return false;
    const sku = line.sku?.trim();
    if (!sku) return false;
    const rule = config.shipsWith?.[sku];
    if (rule) {
      const lead = config.skus[rule.sku]?.batches ?? [];
      if (rule.stock !== undefined) {
        if (!lead[(rule.batch ?? 0) - 1]?.paid || (stockUsed[sku] ?? 0) + line.quantity > rule.stock) return false;
      } else if (!lead[(rule.batch ?? 0) - 1]?.paid) return false;
    } else if (!config.skus[sku]?.batches.some((b) => b.paid)) return false;
  }
  return true;
}

/**
 * Whether an order line is a board bought as a pre-order: its variant title
 * as the order recorded it names the `Pre-order` value of the `Batch` option
 * ("20×20 / Pre-order") and the order was created at or after `choiceFrom`.
 * Such a line ships in March and makes its whole order a March order, so it
 * takes no batch 1 stock. Before `choiceFrom` (and without one) the same
 * variant sold batch 1 stock, so the title decides nothing. The price is
 * bound to the variant by Shopify, so this cannot be edited from a cart.
 */
export function preorderChoiceLine(
  config: Pick<CampaignConfig, 'choiceFrom'>,
  line: {variantTitle?: string | null},
  createdAt: string | null | undefined,
): boolean {
  if (!config.choiceFrom || !createdAt) return false;
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created) || created < Date.parse(config.choiceFrom)) return false;
  return (line.variantTitle ?? '').split(' / ').some((part) => part.trim() === 'Pre-order');
}

/** Every paid unit of a SKU, whatever its region: the count the price
 *  steps and the funding target read. */
export function totalUnits(ordered: PaidUnitsOf): number {
  return toRuns(ordered).reduce((sum, run) => sum + Math.max(0, Math.floor(run.units) || 0), 0);
}

/** The paid units of one region that ship with paid stock: `march` units
 *  leave the stock on hand untouched. */
export function regionUnits(ordered: PaidUnitsOf, region: Region): number {
  return toRuns(ordered)
    .filter((run) => run.region === region && !run.march)
    .reduce((sum, run) => sum + Math.max(0, Math.floor(run.units) || 0), 0);
}

/** 0-based index of the batch the next unit for `region` falls into: the
 *  first batch that serves the region and still has room (the open last
 *  batch always has room). `fill` is the units already in each batch. */
function nextIndex(list: CampaignBatch[], fill: number[], region: Region, march = false): number {
  for (let i = 0; i < list.length; i += 1) {
    if (!servesRegion(list[i], region)) continue;
    if (march && list[i].paid) continue;
    if (i === list.length - 1 || fill[i] < sellableUnits(list[i])) return i;
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
      const i = nextIndex(list, fill, run.region, run.march);
      const room = i === list.length - 1 ? left : Math.min(left, sellableUnits(list[i]) - fill[i]);
      fill[i] += room;
      left -= room;
    }
  }
  return fill;
}

/**
 * Allocate one unit for `region` into `fill` (from {@link batchFill}, or
 * all zero) and return its 1-based batch and entry. `fill` is updated.
 * A `march` unit (its order ships with a line outside paid stock) skips paid batches.
 */
export function allocateUnit(
  batches: CampaignBatch[],
  fill: number[],
  region: Region,
  march = false,
): {batch: number; entry: CampaignBatch} {
  const list = openBatches(batches);
  while (fill.length < list.length) fill.push(0);
  const index = nextIndex(list, fill, region, march);
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
 * The units the price step counts: where the product page step bar
 * (`stepBarView`) of an EU buyer stands, so the price follows the bar. That
 * is the sellable units of the batches before the EU buyer's batch that
 * serve the EU (sold out to them) plus the units already in that batch. An
 * EU-only batch of paid stock counts only its own units, and a batch of
 * another region never moves the step. Shopify holds one price per variant
 * for every region, so the EU buyer's batch sets it (founder 2026-10-24).
 */
export function tierUnits(batches: CampaignBatch[], ordered: PaidUnitsOf): number {
  const list = openBatches(batches);
  // Price steps keep counting every paid unit as one ladder: `march` units
  // fill the batches as they did before the batch-1-only rule.
  const fill = batchFill(batches, toRuns(ordered).map(({region, units}) => ({region, units})));
  const index = nextIndex(list, fill, 'EU');
  const before = list.slice(0, index).filter((b) => servesRegion(b, 'EU')).reduce((sum, b) => sum + sellableUnits(b), 0);
  return before + fill[index];
}

/**
 * The campaign state for one SKU after `ordered` paid units, for the next
 * unit of a buyer in `region`. Once a funding target is reached, later
 * units ship with it (see {@link openBatches}). A US unit never falls into
 * a batch that serves only the EU. The funding target counts every region;
 * the price step counts {@link tierUnits}.
 */
export function campaignState(
  batches: CampaignBatch[],
  ordered: PaidUnitsOf,
  pendingShips: string,
  priceTiers: PriceTier[],
  retail: number | null = null,
  region: Region = 'EU',
  /** The next unit is a pre-order: it skips paid batches, like the units of
   *  an order that ships in March. */
  march = false,
): CampaignState {
  const units = totalUnits(ordered);
  const list = openBatches(batches);
  const fill = batchFill(batches, ordered);
  const index = nextIndex(list, fill, region, march);
  const current = list[index];

  const stepUnits = tierUnits(batches, ordered);
  const tierIndex = priceTiers.findIndex((t) => stepUnits < t.upTo);
  const tier = tierIndex < 0 ? null : priceTiers[tierIndex];

  const targetIndex = batches.findIndex((b) => !b.paid);
  const target = targetIndex >= 0 ? batches[targetIndex].units : null;
  const targetOrdered = target === null ? 0 : Math.min(target, fill[targetIndex]);
  const targetReached = target !== null && targetOrdered >= target;

  return {
    ordered: units,
    batch: index + 1,
    batchUnits: sellableUnits(current),
    batchOrdered: fill[index],
    paidStock: Boolean(current.paid),
    target,
    targetOrdered,
    targetReached,
    shipPromise: batchPromise(current, pendingShips),
    shipsOnTarget: !current.ships?.trim(),
    deliveryByDay: batchDeliveryDay(current, region),
    shipsText: current.ships?.trim() || null,
    paidLeft: current.paid ? sellableUnits(current) - fill[index] : null,
    ...(current.paid && current.inStock ? {inStock: true} : {}),
    earlyPrice: tier !== null,
    tierUpTo: tier?.upTo ?? null,
    tierLeft: tier ? tier.upTo - stepUnits : 0,
    tierOrdered: stepUnits,
    tierOff: tier?.off ?? 0,
    price: tierPrice(retail, tier?.off ?? 0),
    nextPrice: tier ? tierPrice(retail, priceTiers[tierIndex + 1]?.off ?? 0) : null,
    batches: batches.slice(0, index + 2).map((b, i) => ({
      batch: i + 1,
      units: sellableUnits(b),
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
          units: sellableUnits(pinned),
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
          units: sellableUnits(afterBatch),
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
    batchUnits: sellableUnits(entry),
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
    batches: [{batch, units: sellableUnits(entry), status: 'current', shipPromise: promise, paid: Boolean(entry.paid), regions: entry.regions ?? [...REGIONS], ordered: 0}],
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
 * ship promise names a deadline that has passed. Paid stock, a batch
 * with its own ship date (its supplier order is placed) and a funding
 * target that was reached keep selling: the deadline only matters to a
 * target still missing units.
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
  /** A wholesale buyer outside the EU (an applied wholesale code): batch 1
   *  stock is offered to them too, shipped by courier, import charges theirs
   *  (founder 2026-11-11). Consumers outside the EU never get it. */
  dealer = false,
): Catalog {
  const confirmed = Boolean(config.confirmed);
  // A confirmed batch never closes for a missed target: after `endsOn` it
  // closes only in the `closed` mode. Otherwise the deadline closes every
  // target still missing units.
  const closed = confirmed ? afterEndsOn(config, now) === 'closed' : fundingClosed(config, now);
  /** A funding unit of a confirmed campaign waits for no target. */
  const settle = (state: CampaignState): CampaignState =>
    confirmed && state.shipsOnTarget && !state.paidStock ? {...state, targetReached: true, confirmed: true} : state;
  return {
    ...catalog,
    campaign_counts: units ? 'verified' : 'unavailable',
    campaign_skus: campaignSkus(config),
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
          if (closed && state.shipsOnTarget && (confirmed || !state.targetReached)) {
            return {...variant, availability: 'sold_out', ship_promise: null, campaign: null};
          }
          const dated: CampaignState = {
            ...settle(state),
            deadline: campaignDate(config.endsOn),
            latestShip: state.shipsOnTarget ? latestShipDate(config) : null,
            shipByDay: state.shipsOnTarget ? latestShipDay(config) : null,
          };
          return {...variant, availability: 'preorder', ship_promise: state.shipPromise, campaign: dated};
        }
        if (!entry) return variant;
        const tiers = tiersFor(config, variant.sku, now);
        const stateFor = (march: boolean) =>
          campaignState(entry.batches, units[variant.sku] ?? 0, config.pendingShips, tiers, variant.compare_price, region, march);
        const date = (state: CampaignState): CampaignState => ({
          ...settle(state),
          deadline: campaignDate(config.endsOn),
          latestShip: state.shipsOnTarget && !state.paidStock ? latestShipDate(config) : null,
          shipByDay: state.shipsOnTarget && !state.paidStock ? latestShipDay(config) : null,
        });
        /** Whether the unit `state` describes is sold at the price Shopify
         *  charges for this variant today. */
        const open = (state: CampaignState): boolean => {
          if (closed && state.shipsOnTarget && !state.paidStock && (confirmed || !state.targetReached)) return false;
          // Shopify still charges under this SKU's step, so the step has not
          // been written yet: close rather than sell under it.
          return !(state.price != null && variant.price < state.price - 0.005);
        };
        const soldOut: CatalogVariant = {...variant, availability: 'sold_out', ship_promise: null, campaign: null};
        // A board with a `Buy now` variant (`BATCH_CHOICE`): batch 1 stock is
        // that variant, at its own retail price, for an EU buyer while units
        // are left; the entry's own Shopify variant is the pre-order and
        // never takes batch 1 stock.
        if (variant.buy_now) {
          const {buy_now: buyNow, ...entryVariant} = variant;
          const march = stateFor(true);
          const preorder = open(march)
            ? {merchandise_id: variant.merchandise_id, price: variant.price, compare_price: variant.compare_price, ship_promise: march.shipPromise, campaign: date(march)}
            : null;
          const exportStock = dealer && region !== 'EU';
          const stock = exportStock
            ? campaignState(entry.batches, units[variant.sku] ?? 0, config.pendingShips, tiers, variant.compare_price, 'EU', false)
            : stateFor(false);
          const stocked = (region === 'EU' || exportStock) && buyNow.available && stock.paidStock && (stock.paidLeft ?? 0) > 0;
          if (stocked) {
            return {
              ...entryVariant,
              offer: 'buy_now',
              merchandise_id: buyNow.merchandise_id,
              price: buyNow.price,
              compare_price: null,
              availability: 'preorder',
              ship_promise: stock.shipPromise,
              // Retail, whatever the step: stock has no price step.
              campaign: {...date(stock), earlyPrice: false, tierUpTo: null, tierLeft: 0, tierOff: 0, price: null, nextPrice: null},
              ...(preorder ? {preorder_offer: preorder} : {}),
            };
          }
          if (!preorder) return {...soldOut, buy_now: undefined, offer: 'preorder'};
          return {...entryVariant, offer: 'preorder', availability: 'preorder', ship_promise: preorder.ship_promise, campaign: preorder.campaign};
        }
        const state = stateFor(false);
        if (!open(state)) return soldOut;
        return {...variant, availability: 'preorder', ship_promise: state.shipPromise, campaign: date(state)};
      }),
    })),
  };
}

/** Every SKU the campaign lists: `skus` and `shipsWith`. */
export function campaignSkus(config: Pick<CampaignConfig, 'skus' | 'shipsWith'>): string[] {
  return [...new Set([...Object.keys(config.skus), ...Object.keys(config.shipsWith ?? {})])];
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

/**
 * A funding-batch promise read from its text: the ship-by date it names and
 * whether it was sold on a target. Two wordings exist on orders:
 * - "ships by 31 March 2027": the confirmed batch (terms 2.9);
 * - "ships by 31 March 2027 if the target is reached by 15 December 2026,
 *   otherwise ...": sold before the batch was confirmed (`conditional`).
 * Both belong to the same batch. Null for any other promise, such as a
 * month ("ships late November 2026"), stock on hand, or a mixed-order line
 * ("ships with the rest of this order by ...").
 */
export function fundingPromise(promise: string | null | undefined): {latestShip: string; conditional: boolean} | null {
  const text = promise?.trim() ?? '';
  const conditional = text.match(/\bby (\d{1,2} [A-Za-z]+ \d{4}) if\b/);
  if (conditional) return {latestShip: conditional[1], conditional: true};
  const plain = text.match(/^ships by (\d{1,2} [A-Za-z]+ \d{4})(?:[.,;]|$)/i);
  return plain ? {latestShip: plain[1], conditional: false} : null;
}

/** Stock on hand on a chip or a cart line: the short form of its promise. */
export const STOCK_SHORT = 'In stock, ships in a few working days';

/** A promise of stock on hand ("in stock in Belgium, ships to EU addresses
 *  in a few working days", `CampaignBatch.inStock`): it names no month. */
export function stockPromise(promise: string | null | undefined): boolean {
  return /^in stock\b/i.test(promise?.trim() ?? '');
}

/** Whether a promise read from its text alone still waits for a target: a
 *  conditional promise, unless the campaign is confirmed (then an order sold
 *  on a target is part of the confirmed batch, terms 7bis.3bis). */
export function waitsForTarget(promise: string | null | undefined, confirmed: boolean = CAMPAIGN_CONFIRMED): boolean {
  const text = promise?.trim() ?? '';
  if (/\bafter its target\b/.test(text)) return !confirmed;
  return Boolean(fundingPromise(text)?.conditional) && !confirmed;
}

/** The ship-by date a funding promise names, or null when it names none. */
function promiseLatestShip(promise: string): string | null {
  return fundingPromise(promise)?.latestShip ?? null;
}

function fundingShort(latestShip: string | null, conditional: boolean): string {
  const date = shortCampaignDate(latestShip);
  if (!date) return conditional ? 'Funding target' : 'Confirmed batch';
  return conditional ? `Ships by ${date} if the target is reached` : `Ships by ${date}`;
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
  if (stockPromise(promise)) return STOCK_SHORT;
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
  campaign: Pick<CampaignState, 'shipPromise' | 'paidStock' | 'shipsOnTarget' | 'latestShip'> & Partial<Pick<CampaignState, 'confirmed'>>,
  form: ShipLabelForm,
): string {
  if (form === 'long') {
    const latest = campaign.confirmed ? promiseLatestShip(campaign.shipPromise) : null;
    return latest ? `Ships by ${latest}.` : longSentence(campaign.shipPromise);
  }
  if (campaign.shipsOnTarget && !campaign.paidStock) {
    return fundingShort(
      campaign.latestShip ?? promiseLatestShip(campaign.shipPromise),
      !campaign.confirmed && waitsForTarget(campaign.shipPromise, false),
    );
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
  confirmed: boolean = CAMPAIGN_CONFIRMED,
): string | null {
  const text = promise?.trim();
  if (!text) return null;
  const latest = promiseLatestShip(text);
  const funding = Boolean(latest) || /\bafter its target\b/.test(text);
  // An order sold on a target is part of the confirmed batch: its long
  // sentence drops the condition too.
  const waits = waitsForTarget(text, confirmed);
  if (form === 'long') return funding && latest && !waits ? `Ships by ${latest}.` : longSentence(text);
  return funding ? fundingShort(latest, waits) : datedShort(text);
}

/**
 * The one long ship sentence a cart shows: the funding-target promise in
 * full, once, when the cart holds a line waiting for a funding target. Every
 * line then carries only its short label. Null when no line waits for a
 * target.
 */
export function cartShipNote(
  promises: Array<string | null | undefined>,
  confirmed: boolean = CAMPAIGN_CONFIRMED,
): string | null {
  for (const promise of promises) {
    const text = promise?.trim();
    if (text && waitsForTarget(text, confirmed)) {
      return shipLabelFromPromise(text, 'long', confirmed);
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
