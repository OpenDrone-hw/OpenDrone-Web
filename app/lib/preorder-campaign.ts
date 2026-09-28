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

export type CampaignBatch = {
  /** Units in this batch: the supplier order quantity. */
  units: number;
  /** Paid stock: Incutec has already ordered this batch. */
  paid?: boolean;
  /** The ship promise once the supplier order is placed, e.g.
   *  "ships late October 2026". Required for paid stock. */
  ships?: string;
  /** Reviewed final customer delivery date, separate from dispatch. The ship promise names it; null leaves it out. */
  deliveryBy?: string | null;
};

export type PriceTier = {
  /** The last paid unit that gets this step. */
  upTo: number;
  /** Share off the retail price, 0.2 for 20% off. */
  off: number;
};

/** One promise flows to product pages, cart lines and order confirmations.
 *  A batch with a placed supplier order (`ships`) states its delivery date
 *  outright; a funding target states it on the condition of its target. */
function batchPromise(batch: CampaignBatch, fallback: string): string {
  const ships = batch.ships?.trim();
  const delivery = batch.deliveryBy ? campaignDate(batch.deliveryBy) : null;
  if (!ships) {
    return delivery ? `${fallback}; if the target is reached in time, delivered by ${delivery}` : fallback;
  }
  return delivery ? `${ships}, delivered by ${delivery}` : ships;
}

/** The delivery date a promise names, short: "30 Nov 2026". Null without one. */
export function promiseDeliveredBy(promise: string | null | undefined): string | null {
  const m = /delivered by (\d{1,2} [A-Z][a-z]+ \d{4})/.exec(promise ?? '');
  return m ? shortCampaignDate(m[1]) : null;
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
};

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
  /** The target deadline as a date, "22 November 2026". Set by
   *  `applyCampaign`; absent in a bare `campaignState`. */
  deadline?: string;
  /** For a unit waiting on a funding target: the latest planned ship date
   *  if the target is reached by the deadline, "14 March 2027". */
  latestShip?: string | null;
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
  /** Every configured batch up to the one after the current, in order:
   *  sold-out batches stay listed. */
  batches: Array<{
    batch: number;
    units: number;
    status: 'sold_out' | 'current' | 'next';
    shipPromise: string;
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
    }
    if (entry.priceTiers !== undefined) checkTiers(entry.priceTiers, `${sku} priceTiers`);
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
  return c as CampaignConfig;
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

/** The ship-by date in words: "14 March 2027". */
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
 * same "ships by 14 March 2027 if the target is reached" text still wait for two
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

/**
 * The batch the next unit falls into after `units` paid units: its 0-based
 * index, the units before it and the batch. The last batch has no end when
 * it is a funding target: its `units` is the target, and every later unit
 * ships with it. Past a last batch of paid stock, one such open funding
 * batch of the same size follows.
 */
function batchAt(
  batches: CampaignBatch[],
  units: number,
): {index: number; start: number; current: CampaignBatch} {
  let start = 0;
  for (let index = 0; ; index += 1) {
    const last = index >= batches.length - 1;
    const current =
      index < batches.length ? batches[index] : {units: batches[batches.length - 1].units};
    if ((last && !current.paid) || units < start + current.units) return {index, start, current};
    start += current.units;
  }
}

/** The 1-based batch that paid unit `unit` (1-based) of a SKU falls into
 *  (see {@link batchAt}). */
export function batchOfUnit(batches: CampaignBatch[], unit: number): {batch: number; entry: CampaignBatch} {
  const {index, current} = batchAt(batches, Math.max(0, unit - 1));
  return {batch: index + 1, entry: current};
}

/**
 * The campaign state for one SKU after `ordered` paid units. Once a funding
 * target is reached, later units ship with it (see {@link batchAt}).
 */
export function campaignState(
  batches: CampaignBatch[],
  ordered: number,
  pendingShips: string,
  priceTiers: PriceTier[],
  retail: number | null = null,
): CampaignState {
  const units = Math.max(0, Math.floor(Number.isFinite(ordered) ? ordered : 0));
  const {index, start, current} = batchAt(batches, units);

  const tierIndex = priceTiers.findIndex((t) => units < t.upTo);
  const tier = tierIndex < 0 ? null : priceTiers[tierIndex];

  let targetStart = 0;
  let targetIndex = -1;
  for (let i = 0; i < batches.length; i += 1) {
    if (!batches[i].paid) {
      targetIndex = i;
      break;
    }
    targetStart += batches[i].units;
  }
  const target = targetIndex >= 0 ? batches[targetIndex].units : null;
  const targetOrdered =
    target === null ? 0 : Math.min(target, Math.max(0, units - targetStart));
  const targetReached = target !== null && targetOrdered >= target;

  return {
    ordered: units,
    batch: index + 1,
    batchUnits: current.units,
    batchOrdered: units - start,
    paidStock: Boolean(current.paid),
    target,
    targetOrdered,
    targetReached,
    shipPromise: batchPromise(current, pendingShips),
    shipsOnTarget: !current.ships?.trim(),
    paidLeft: current.paid ? current.units - (units - start) : null,
    earlyPrice: tier !== null,
    tierUpTo: tier?.upTo ?? null,
    tierLeft: tier ? tier.upTo - units : 0,
    tierOff: tier?.off ?? 0,
    price: tierPrice(retail, tier?.off ?? 0),
    nextPrice: tier ? tierPrice(retail, priceTiers[tierIndex + 1]?.off ?? 0) : null,
    batches: batches.slice(0, index + 2).map((b, i) => ({
      batch: i + 1,
      units: b.units,
      status: i < index ? 'sold_out' : i === index ? 'current' : 'next',
      shipPromise: batchPromise(b, pendingShips),
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
  leadOrdered: number,
  price: number | null,
  ordered = 0,
): CampaignState {
  const lead = config.skus[rule.sku];
  const own = Math.max(0, Math.floor(Number.isFinite(ordered) ? ordered : 0));
  const fromStock = rule.stock !== undefined && own < rule.stock;
  const batch = rule.stock !== undefined && !fromStock ? rule.after : rule.batch;
  const state = batch
    ? pinnedBatchState(lead.batches, batch, config.pendingShips, leadOrdered)
    : campaignState(lead.batches, leadOrdered, config.pendingShips, tiersFor(config, rule.sku));
  return {
    ...state,
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

/** A lead batch as the state of a SKU pinned to it: its own ship date, or
 *  its funding target counted from the lead's `leadOrdered` paid units. */
function pinnedBatchState(
  batches: CampaignBatch[],
  batch: number,
  pendingShips: string,
  leadOrdered: number,
): CampaignState {
  const entry = batches[batch - 1];
  const promise = batchPromise(entry, pendingShips);
  const dated = Boolean(entry.ships?.trim());
  const start = batches.slice(0, batch - 1).reduce((sum, b) => sum + b.units, 0);
  const counted = Math.max(0, Math.floor(Number.isFinite(leadOrdered) ? leadOrdered : 0));
  const targetOrdered = dated ? 0 : Math.min(entry.units, Math.max(0, counted - start));
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
    paidLeft: null,
    earlyPrice: false,
    tierUpTo: null,
    tierLeft: 0,
    tierOff: 0,
    price: null,
    nextPrice: null,
    batches: [{batch, units: entry.units, status: 'current', shipPromise: promise}],
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
 */
export function applyCampaign(
  catalog: Catalog,
  config: CampaignConfig,
  units: Record<string, number> | null,
  now: Date = new Date(),
): Catalog {
  const closed = fundingClosed(config, now);
  return {
    ...catalog,
    campaign_counts: units ? 'verified' : 'unavailable',
    products: catalog.products.map((product) => ({
      ...product,
      variants: product.variants.map((variant): CatalogVariant => {
        const entry = config.skus[variant.sku];
        const rule = config.shipsWith?.[variant.sku];
        if ((!entry && !rule) || variant.availability !== 'preorder') return variant;
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
          );
          if (closed && state.shipsOnTarget) {
            return {...variant, availability: 'sold_out', ship_promise: null, campaign: null};
          }
          const dated: CampaignState = {
            ...state,
            deadline: campaignDate(config.endsOn),
            latestShip: state.shipsOnTarget ? latestShipDate(config) : null,
          };
          return {...variant, ship_promise: state.shipPromise, campaign: dated};
        }
        if (!entry) return variant;
        const state = campaignState(
          entry.batches,
          units[variant.sku] ?? 0,
          config.pendingShips,
          tiersFor(config, variant.sku),
          variant.compare_price,
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
        };
        return {...variant, ship_promise: state.shipPromise, campaign: dated};
      }),
    })),
  };
}

/** Whether any catalog variant is a campaign preorder, i.e. needs counts. */
export function needsCampaignCounts(catalog: Catalog, config: CampaignConfig): boolean {
  return catalog.products.some((product) =>
    product.variants.some(
      (variant) =>
        variant.availability === 'preorder' &&
        Boolean(config.skus[variant.sku] || config.shipsWith?.[variant.sku]),
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

/** "14 March 2027" as "14 Mar 2027"; null for anything else. */
export function shortCampaignDate(longDate: string | null | undefined): string | null {
  const match = longDate?.trim().match(/^(\d{1,2}) ([A-Za-z]+) (\d{4})$/);
  if (!match) return null;
  const month = LONG_MONTHS.indexOf(match[2].toLowerCase());
  return month < 0 ? null : `${Number(match[1])} ${SHORT_MONTHS[month]} ${match[3]}`;
}

function capitalizeFirst(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

/** The ship-by date a funding-target promise names, "by 14 March 2027 if
 *  the target is reached", or null when it names none. */
function promiseLatestShip(promise: string): string | null {
  const match = promise.match(/\bby (\d{1,2} [A-Za-z]+ \d{4}) if\b/);
  return match ? match[1] : null;
}

function fundingShort(latestShip: string | null): string {
  const date = shortCampaignDate(latestShip);
  return date ? `Ships by ${date} if the target is reached` : 'Funding target';
}

/** A dated promise, short: "ships late October 2026" gives "Ships Oct
 *  2026". A promise that names no month and year keeps its own words. */
function datedShort(promise: string): string {
  const match = promise.match(/\b([A-Za-z]+) (\d{4})\b/);
  const month = match ? LONG_MONTHS.indexOf(match[1].toLowerCase()) : -1;
  return month < 0 ? capitalizeFirst(promise.trim()) : `Ships ${SHORT_MONTHS[month]} ${match![2]}`;
}

function longSentence(promise: string): string {
  const text = capitalizeFirst(promise.trim());
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/**
 * The ship text for the next unit of a campaign SKU, in two lengths.
 *
 * short: "Ships by 14 Mar 2027 if the target is reached" for a unit that waits for a funding
 * target, and the batch month for everything else, "Ships Oct 2026". long: the full promise as a sentence, "Ships
 * by 14 March 2027 if the target is reached by 22 November 2026, otherwise
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
