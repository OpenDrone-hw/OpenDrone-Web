import type {Route} from './+types/api.status.campaign';
import {CAMPAIGN} from '~/lib/catalog-client';
import {fetchPreorderOrders, holdHealth, type OverfullBatch} from '~/lib/preorder-fulfilment';
import {preorderHoldsEnabled} from '~/lib/preorder-ops';
import {opsStatus} from '~/lib/preorder-ops-status';
import {paidUnits} from '~/lib/shopify-orders';
import {priceTierWritesEnabled, syncPriceTiers} from '~/lib/shopify-price-tier';

/**
 * Campaign health for an uptime monitor: `GET /api/status/campaign`.
 *
 * - `skus`: per campaign SKU, whether the storefront sells it (`open`) and
 *   its availability word. A SKU closes when the paid counts cannot be read
 *   or Shopify still prices it under its step, so `closed` on a SKU that
 *   should sell is the thing to alert on (`allOpen: false`).
 * - `paidCounts`: whether the Admin API answered, read now.
 * - `priceSync`: whether the Worker writes steps, and the SKUs whose Shopify
 *   price is not yet at its step (a dry run, read now).
 * - `holds`: read now, the paid orders the hold planner
 *   (`planPreorderHolds`) says need a fulfillment hold they do not have
 *   (`unheld`), and the batches whose `batch:SKU:N` tags carry more units
 *   than the batch has (`overfull`). `error` when the orders could not be
 *   read; `unheld` is then null. `holdsOk` is false on any of the three.
 * - `lastRuns`: the last webhook or scheduled run of each job seen by this
 *   Worker isolate, with its time and error. Best effort: another isolate
 *   may have run later.
 *
 * No secrets, no order or customer data: the counts are the ones the
 * product pages show, and holds report counts and batch names only. Never
 * cached. Answers 200 when every SKU is open and `holdsOk`, and 503
 * otherwise, so a plain HTTP check can alert on it.
 */

const NO_STORE = {'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex'};

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 200);
}

export async function loader({context}: Route.LoaderArgs) {
  const env = context.env;
  const checkedAt = new Date().toISOString();
  const skus = Object.keys(CAMPAIGN.skus);

  let catalogError: string | null = null;
  const availability = new Map<string, string>();
  let countsVerified: boolean | null = null;
  try {
    const catalog = await context.catalog.get();
    countsVerified = catalog.campaign_counts === undefined ? null : catalog.campaign_counts === 'verified';
    for (const product of catalog.products) {
      for (const variant of product.variants) {
        if (CAMPAIGN.skus[variant.sku]) availability.set(variant.sku, variant.availability);
      }
    }
  } catch (error) {
    catalogError = message(error);
  }

  let units: Record<string, number> | null = null;
  let countsError: string | null = null;
  try {
    units = await paidUnits(env, CAMPAIGN.countFrom, new Set(skus));
  } catch (error) {
    countsError = message(error);
  }

  const writesEnabled = priceTierWritesEnabled(env);
  let pending: string[] | null = null;
  let priceError: string | null = null;
  if (units) {
    try {
      const plan = await syncPriceTiers(env, CAMPAIGN, units, {apply: false});
      pending = plan.changed.map((change) => change.sku);
    } catch (error) {
      priceError = message(error);
    }
  }

  let unheld: number | null = null;
  let overfull: OverfullBatch[] = [];
  let holdsError: string | null = null;
  try {
    ({unheld, overfull} = holdHealth(await fetchPreorderOrders(env, CAMPAIGN.countFrom), CAMPAIGN));
  } catch (error) {
    holdsError = message(error);
  }
  const holdsOk = holdsError === null && unheld === 0 && overfull.length === 0;

  const skuStatus = Object.fromEntries(
    skus.map((sku) => {
      const word = availability.get(sku) ?? null;
      return [
        sku,
        {
          open: word === 'preorder' || word === 'in_stock',
          availability: word ?? 'not on the storefront',
          ordered: units ? (units[sku] ?? 0) : null,
        },
      ];
    }),
  );
  const allOpen = Object.values(skuStatus).every((s) => s.open);

  return Response.json(
    {
      checkedAt,
      allOpen,
      catalog: {ok: catalogError === null, error: catalogError, countsVerified},
      skus: skuStatus,
      paidCounts: {ok: countsError === null, error: countsError},
      priceSync: {writesEnabled, pending, error: priceError},
      holdsOk,
      holds: {enabled: preorderHoldsEnabled(env), unheld, overfull, error: holdsError},
      lastRuns: opsStatus(),
    },
    {status: allOpen && holdsOk ? 200 : 503, headers: NO_STORE},
  );
}
