/**
 * The roadmap statuses an open shop shows.
 *
 * A board with a paid first production batch belongs under `status-beta`,
 * but its repo topic is changed by hand (docs/product-status.md), so an open
 * shop (production or the staging Worker) can run ahead of the topic and
 * would file the board under alpha while its product page says "First
 * production batch". This overlay takes the paid batches in
 * `content/preorders.json` as the source instead: while the shop is open, a
 * roadmap entry whose SKU has a paid batch reads at least beta. A closed
 * shop gets the topic statuses unchanged, and the static fallbacks in
 * roadmap-data.ts stay behind the topics as that file requires.
 *
 * Kept pure with relative imports so the node:test suites can load it.
 */

import {ROADMAP, STATUS_ORDER, type ProductStatus} from './roadmap-data.ts';
import type {CampaignConfig} from './preorder-campaign.ts';

/** The Shopify SKU each board on the roadmap sells as. */
export const ROADMAP_SKUS: Record<string, string> = {
  openfc_lite_30: 'OPENFC-LITE-3030',
  openfc_lite_mini_20: 'OPENFC-LITE-2020',
  openesc_20: 'OPENESC-2020',
  openesc_30: 'OPENESC-3030',
  openrx_lite: 'OPENRX-LITE',
  openrx_lite_ufl: 'OPENRX-LITE-UFL',
  openrx_mono: 'OPENRX-MONO',
  openrx_gemini: 'OPENRX-GEMINI',
};

/**
 * `flags` (repo link to topic status) with every board that has a paid
 * batch raised to beta while `shopOpen`. Never lowers a status.
 */
export function launchedStatusFlags(
  flags: Record<string, ProductStatus>,
  shopOpen: boolean,
  config: Pick<CampaignConfig, 'skus'>,
): Record<string, ProductStatus> {
  if (!shopOpen) return flags;
  const out = {...flags};
  for (const item of ROADMAP) {
    const sku = ROADMAP_SKUS[item.id];
    if (!item.link || !sku) continue;
    const paid = config.skus[sku]?.batches.some((b) => b.paid);
    if (!paid) continue;
    const current = out[item.link] ?? item.status;
    if (STATUS_ORDER.indexOf(current) > STATUS_ORDER.indexOf('beta')) {
      out[item.link] = 'beta';
    }
  }
  return out;
}
