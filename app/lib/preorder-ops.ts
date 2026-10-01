/**
 * One preorder reconcile pass, shared by the Shopify `orders/paid` webhook
 * and the Worker's five-minute scheduled handler. The webhook answers 202
 * before the pass runs, so Shopify never retries a failed pass: the next
 * scheduled run is the retry.
 *
 * 1. Price steps, only while `SHOPIFY_PRICE_TIER_WRITE_ENABLED` is `1`:
 *    re-read the paid counts and write each SKU's step
 *    (`shopify-price-tier.ts`). A failure is logged and recorded and does
 *    not stop the holds.
 * 2. Holds, whatever the price-step switch and whatever step 1 did: hold
 *    and tag every paid preorder order not yet done
 *    (`preorder-fulfilment.ts`). The hold pass reads the orders itself and
 *    needs no paid count. Off only on a Worker with `STAGING_PASSWORD`
 *    (`preorderHoldsEnabled`), since staging shares the production store.
 *
 * A failure in either step is logged, recorded (`preorder-ops-status.ts`)
 * and returned; the pass itself never throws.
 */

import type {CampaignConfig} from './preorder-campaign.ts';
import {syncPreorderHolds} from './preorder-fulfilment.ts';
import {recordOps} from './preorder-ops-status.ts';
import {fetchPaidUnits} from './shopify-orders.ts';
import {priceTierWritesEnabled, syncPriceTiers, type TierChange} from './shopify-price-tier.ts';

type OpsEnv = Parameters<typeof syncPriceTiers>[0] & Partial<Pick<Env, 'STAGING_PASSWORD'>>;

export type ReconcileResult = {
  changed: TierChange[];
  skipped: Record<string, string>;
  /** Why the paid counts or the price steps failed, or null. */
  priceError: string | null;
  /** Orders held and tagged in this pass. */
  held: string[];
  /** Order name to error, or `_` when the hold pass itself failed. */
  holdErrors: Record<string, string>;
};

/** Holds run on every Worker but staging, which shares the production
 *  Shopify store and must not write to its orders. */
export function preorderHoldsEnabled(env: Partial<Pick<Env, 'STAGING_PASSWORD'>>): boolean {
  return !env.STAGING_PASSWORD?.trim();
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message.slice(0, 200) : fallback;
}

export async function reconcilePreorders(
  env: OpsEnv,
  config: CampaignConfig,
  fetcher: typeof fetch = fetch,
): Promise<ReconcileResult> {
  let changed: TierChange[] = [];
  let skipped: Record<string, string> = {};
  let priceError: string | null = null;
  if (priceTierWritesEnabled(env)) {
    let units: Record<string, number> | null = null;
    try {
      units = await fetchPaidUnits(env, config.countFrom, new Set(Object.keys(config.skus)), fetcher);
      recordOps('paidCounts');
    } catch (error) {
      recordOps('paidCounts', {error});
      priceError = errorText(error, 'paid counts failed');
    }
    if (units) {
      try {
        ({changed, skipped} = await syncPriceTiers(env, config, units, {apply: true, fetcher}));
        recordOps('priceSync', {detail: changed.length ? `stepped ${changed.map((c) => c.sku).join(', ')}` : undefined});
      } catch (error) {
        recordOps('priceSync', {error});
        priceError = errorText(error, 'price sync failed');
      }
    }
    if (priceError) console.error('[preorders] price steps not synced', priceError);
  }

  let held: string[] = [];
  let holdErrors: Record<string, string> = {};
  if (preorderHoldsEnabled(env)) {
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
      holdErrors = {_: errorText(error, 'hold pass failed')};
      recordOps('holdSync', {error});
    }
    if (Object.keys(holdErrors).length) {
      console.error('[preorders] hold pass incomplete', JSON.stringify(holdErrors));
    }
  }
  return {changed, skipped, priceError, held, holdErrors};
}
