/**
 * A short per-isolate memo of Shopify catalog reads, keyed by market, for
 * page rendering. The cart and checkout paths bypass it (`catalog.fresh`).
 *
 * Bundler-free (type imports only) so the node:test suites can load it.
 */

import type {Catalog} from './catalog.ts';

/** How long a page may show a Shopify catalog read by an earlier request in
 *  the same isolate. Paid counts are memoised for the same minute
 *  (`paidUnitRuns`); the cart and checkout always read fresh. */
export const CATALOG_TTL_MS = 60_000;

const catalogMemo = new Map<string, {catalog: Catalog; fetchedAt: number}>();

/** The Shopify catalog for `market`, from the memo while it is younger than
 *  CATALOG_TTL_MS. Only finished results are kept, never an in-flight
 *  promise: a promise shared across Worker requests hangs the isolate when
 *  the request that started it ends first (#617). Each caller gets its own
 *  copy, so no request can change another's catalog. */
export async function memoCatalog(
  market: string,
  load: () => Promise<Catalog>,
  now: () => number = Date.now,
): Promise<Catalog> {
  const hit = catalogMemo.get(market);
  if (hit && now() - hit.fetchedAt < CATALOG_TTL_MS) return structuredClone(hit.catalog);
  const catalog = await load();
  catalogMemo.set(market, {catalog, fetchedAt: now()});
  return structuredClone(catalog);
}

/** For tests: forget every memoised catalog. */
export function clearCatalogMemo(): void {
  catalogMemo.clear();
}
