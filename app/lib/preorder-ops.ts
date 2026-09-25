/**
 * One preorder reconcile pass, shared by the Shopify `orders/paid` webhook
 * and the Worker's five-minute scheduled handler:
 *
 * 1. Price steps: re-read the paid counts and write each SKU's step
 *    (`shopify-price-tier.ts`). A failure here throws, so the webhook
 *    answers 500 and Shopify retries.
 * 2. Holds: hold and tag every paid preorder order not yet done
 *    (`preorder-fulfilment.ts`). A failure here is logged and recorded but
 *    does not fail the pass: the next scheduled run retries it, and a
 *    webhook that keeps failing would be removed by Shopify, taking the
 *    price steps with it.
 *
 * Both write to Shopify, so both run only when
 * `SHOPIFY_PRICE_TIER_WRITE_ENABLED` is `1` (production after launch).
 */

import type {CampaignConfig} from './preorder-campaign.ts';
import {syncPreorderHolds} from './preorder-fulfilment.ts';
import {recordOps} from './preorder-ops-status.ts';
import {fetchPaidUnits} from './shopify-orders.ts';
import {syncPriceTiers, type TierChange} from './shopify-price-tier.ts';

type OpsEnv = Parameters<typeof syncPriceTiers>[0];

export type ReconcileResult = {
  changed: TierChange[];
  skipped: Record<string, string>;
  /** Orders held and tagged in this pass. */
  held: string[];
  /** Order name to error, or `_` when the hold pass itself failed. */
  holdErrors: Record<string, string>;
};

export async function reconcilePreorders(
  env: OpsEnv,
  config: CampaignConfig,
  fetcher: typeof fetch = fetch,
): Promise<ReconcileResult> {
  let units: Record<string, number>;
  try {
    units = await fetchPaidUnits(env, config.countFrom, new Set(Object.keys(config.skus)), fetcher);
    recordOps('paidCounts');
  } catch (error) {
    recordOps('paidCounts', {error});
    throw error;
  }

  let changed: TierChange[];
  let skipped: Record<string, string>;
  try {
    ({changed, skipped} = await syncPriceTiers(env, config, units, {apply: true, fetcher}));
    recordOps('priceSync', {detail: changed.length ? `stepped ${changed.map((c) => c.sku).join(', ')}` : undefined});
  } catch (error) {
    recordOps('priceSync', {error});
    throw error;
  }

  let held: string[] = [];
  let holdErrors: Record<string, string> = {};
  try {
    const holds = await syncPreorderHolds(env, config, {apply: true, fetcher});
    holdErrors = holds.errors;
    held = holds.planned.map((p) => p.orderName).filter((name) => !(name in holdErrors));
    const failed = Object.keys(holdErrors);
    recordOps(
      'holdSync',
      failed.length
        ? {error: `${failed.length} order(s) not held or tagged: ${failed.join(', ')}: ${Object.values(holdErrors)[0]}`}
        : {detail: held.length ? `held ${held.join(', ')}` : undefined},
    );
  } catch (error) {
    holdErrors = {_: error instanceof Error ? error.message.slice(0, 200) : 'hold pass failed'};
    recordOps('holdSync', {error});
  }
  if (Object.keys(holdErrors).length) {
    console.error('[preorders] hold pass incomplete', JSON.stringify(holdErrors));
  }
  return {changed, skipped, held, holdErrors};
}
