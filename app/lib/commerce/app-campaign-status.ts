/**
 * `GET /api/status/campaign` in app mode (COMMERCE_SOURCE=app): the same fields the uptime monitor reads, filled from
 * the app's catalog snapshot (the app applies the campaign and counts the paid units). Nothing here calls Shopify,
 * whose Admin token is revoked once the store closes. Pure so the node:test suites can load it.
 *
 * 503 stays honest: the status code is 503 only when a campaign SKU is not open on the storefront, which includes the
 * app not answering (no catalog, so no SKU is open). Counts the app could not read (`campaign_counts: unavailable`)
 * show in `paidCounts` and close the preorder SKUs the same way.
 */
import type {Catalog} from '../catalog.ts';

export type AppCampaignStatus = {
  catalog: {ok: boolean; error: string | null; countsVerified: boolean | null};
  skus: Record<string, {open: boolean; availability: string; ordered: number | null}>;
  paidCounts: {ok: boolean; error: string | null};
  allOpen: boolean;
};

export function appCampaignStatus(catalog: Catalog | null, catalogError: string | null, skus: string[]): AppCampaignStatus {
  const availability = new Map<string, {word: string; ordered: number | null}>();
  for (const product of catalog?.products ?? []) {
    for (const variant of product.variants) {
      if (skus.includes(variant.sku)) availability.set(variant.sku, {word: variant.availability, ordered: variant.campaign?.ordered ?? null});
    }
  }
  const countsVerified = !catalog || catalog.campaign_counts === undefined ? null : catalog.campaign_counts === 'verified';
  const skuStatus = Object.fromEntries(
    skus.map((sku) => {
      const hit = availability.get(sku);
      return [
        sku,
        {
          open: hit?.word === 'preorder' || hit?.word === 'in_stock',
          availability: hit?.word ?? 'not on the storefront',
          ordered: hit?.ordered ?? null,
        },
      ];
    }),
  );
  return {
    catalog: {ok: catalogError === null && catalog !== null, error: catalogError, countsVerified},
    skus: skuStatus,
    paidCounts: {
      ok: catalog !== null && countsVerified !== false,
      error: catalog === null ? 'app catalog not read' : countsVerified === false ? 'the app could not read the paid counts' : null,
    },
    allOpen: Object.values(skuStatus).every((s) => s.open),
  };
}
