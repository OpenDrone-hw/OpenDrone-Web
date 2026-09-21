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
 * Prices stay in Shopify. The early price is Shopify's price with its
 * compare-at price as the price after the target; this module only says
 * whether the "early price" label applies.
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

export type CampaignConfig = {
  /** First day whose paid Shopify orders count, YYYY-MM-DD. */
  countFrom: string;
  /** Ship promise for a unit in a batch whose supplier order is not placed. */
  pendingShips: string;
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
  /** Shopify's price is the preorder price: paid stock, or the first
   *  funding target, not reached yet. */
  earlyPrice: boolean;
};

/** Accept `content/preorders.json`, or throw on anything malformed. */
export function parseCampaignConfig(body: unknown): CampaignConfig {
  const c = body as Partial<CampaignConfig> | null;
  if (!c || typeof c !== 'object') throw new Error('preorders: not an object');
  if (typeof c.countFrom !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(c.countFrom)) {
    throw new Error('preorders: countFrom must be YYYY-MM-DD');
  }
  if (typeof c.pendingShips !== 'string' || !c.pendingShips.trim()) {
    throw new Error('preorders: pendingShips is required');
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

/**
 * The campaign state for one SKU after `ordered` paid units. Past the last
 * configured batch, further batches repeat the last batch's size with the
 * pending ship promise.
 */
export function campaignState(
  batches: CampaignBatch[],
  ordered: number,
  pendingShips: string,
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
    earlyPrice: (targetIndex < 0 || index <= targetIndex) && !targetReached,
  };
}

/**
 * Apply the campaign to a catalog. Only a variant the catalog policy already
 * sells as `preorder` and that has a campaign entry is touched: it gets the
 * campaign state and the batch's ship promise. With `units` null (the paid
 * counts could not be verified) those variants close as sold out, because
 * their ship promise depends on the count.
 */
export function applyCampaign(
  catalog: Catalog,
  config: CampaignConfig,
  units: Record<string, number> | null,
): Catalog {
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
        const state = campaignState(entry.batches, units[variant.sku] ?? 0, config.pendingShips);
        return {...variant, ship_promise: state.shipPromise, campaign: state};
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
