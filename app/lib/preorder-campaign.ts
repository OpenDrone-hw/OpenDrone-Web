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
};

export type PriceTier = {
  /** The last paid unit that gets this step. */
  upTo: number;
  /** Share off the retail price, 0.2 for 20% off. */
  off: number;
};

export type CampaignConfig = {
  /** First day whose paid Shopify orders count, YYYY-MM-DD. */
  countFrom: string;
  /** Ship promise for a unit in a batch whose supplier order is not placed.
   *  It names the target deadline (`endsOn`) and the latest planned ship
   *  date (`latestShipDate`), as terms 7bis.2 do; the tests hold the three
   *  in step. */
  pendingShips: string;
  /** Weeks from a reached funding target to shipping; 10 when absent. */
  shipWeeksAfterTarget?: number;
  /** Last day a funding target can be reached, YYYY-MM-DD. A buyer whose
   *  target is missed by then chooses a refund or to keep waiting. */
  endsOn: string;
  /** Price steps by paid units, in order: `upTo` is the last unit of the
   *  step and `off` its share off retail. Past the last step: retail. */
  priceTiers: PriceTier[];
  skus: Record<string, {batches: CampaignBatch[]}>;
};

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
  /** The target deadline as a date, "31 December 2026". Set by
   *  `applyCampaign`; absent in a bare `campaignState`. */
  deadline?: string;
  /** For a unit waiting on a funding target: the latest planned ship date
   *  if the target is reached by the deadline, "11 March 2027". */
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
  if (!Array.isArray(c.priceTiers)) {
    throw new Error('preorders: priceTiers must be an array');
  }
  let last = 0;
  for (const tier of c.priceTiers) {
    if (!Number.isSafeInteger(tier?.upTo) || tier.upTo <= last) {
      throw new Error('preorders: priceTiers need whole, increasing upTo values');
    }
    if (!(typeof tier.off === 'number') || !(tier.off > 0) || tier.off >= 1) {
      throw new Error(`preorders: priceTiers ${tier.upTo} needs an off share between 0 and 1`);
    }
    last = tier.upTo;
  }
  if (typeof c.pendingShips !== 'string' || !c.pendingShips.trim()) {
    throw new Error('preorders: pendingShips is required');
  }
  if (
    c.shipWeeksAfterTarget !== undefined &&
    (!Number.isSafeInteger(c.shipWeeksAfterTarget) || c.shipWeeksAfterTarget < 1)
  ) {
    throw new Error('preorders: shipWeeksAfterTarget must be a whole number of weeks');
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
    }
  }
  return c as CampaignConfig;
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

/** Weeks from a reached funding target to shipping, when the config
 *  does not say. */
export const DEFAULT_SHIP_WEEKS = 10;

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
 * The latest planned ship day for a funding target reached on the deadline:
 * `endsOn` plus `shipWeeksAfterTarget` weeks, YYYY-MM-DD. For 2026-12-31 and
 * 10 weeks that is 2027-03-11, the date in terms 7bis.2.
 */
export function latestShipDay(
  config: Pick<CampaignConfig, 'endsOn' | 'shipWeeksAfterTarget'>,
): string {
  const [y, m, d] = config.endsOn.split('-').map(Number);
  const weeks = config.shipWeeksAfterTarget ?? DEFAULT_SHIP_WEEKS;
  return new Date(Date.UTC(y, m - 1, d + weeks * 7))
    .toISOString()
    .slice(0, 10);
}

/** The latest planned ship date in words: "11 March 2027". */
export function latestShipDate(
  config: Pick<CampaignConfig, 'endsOn' | 'shipWeeksAfterTarget'>,
): string {
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
 * same "ships about 10 weeks after its target" text still wait for two
 * different targets.
 */
export function shipGroupKey(
  sku: string | null,
  shipPromise: string | null,
  campaign: CampaignState | null | undefined,
): string {
  if (campaign && campaign.shipsOnTarget && !campaign.paidStock) {
    return `target:${sku ?? ''}:${campaign.batch}`;
  }
  return `date:${shipPromise ?? ''}`;
}

/**
 * The campaign state for one SKU after `ordered` paid units. Past the last
 * configured batch, further batches repeat the last batch's size with the
 * pending ship promise.
 */
export function campaignState(
  batches: CampaignBatch[],
  ordered: number,
  pendingShips: string,
  priceTiers: PriceTier[],
  retail: number | null = null,
): CampaignState {
  const units = Math.max(0, Math.floor(Number.isFinite(ordered) ? ordered : 0));
  let start = 0;
  let index = 0;
  let current: CampaignBatch = batches[0];
  for (;;) {
    current =
      index < batches.length
        ? batches[index]
        : {units: batches[batches.length - 1].units};
    if (units < start + current.units) break;
    start += current.units;
    index += 1;
  }

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
    shipPromise: current.ships?.trim() || pendingShips,
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
      shipPromise: b.ships?.trim() || pendingShips,
    })),
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
        if (!entry || variant.availability !== 'preorder') return variant;
        if (!units) {
          return {...variant, availability: 'sold_out', ship_promise: null, campaign: null};
        }
        const state = campaignState(
          entry.batches,
          units[variant.sku] ?? 0,
          config.pendingShips,
          config.priceTiers,
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
      (variant) => variant.availability === 'preorder' && Boolean(config.skus[variant.sku]),
    ),
  );
}
