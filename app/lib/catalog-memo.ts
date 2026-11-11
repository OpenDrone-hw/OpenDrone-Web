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

/** How long the cart loader right after a Ship to switch reuses the catalog
 *  the switch just read (cart-replan.ts), and the switch marker lives. */
export const REPLAN_REUSE_MS = 15_000;

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
  const startedAt = now();
  const catalog = await load();
  rememberCatalog(market, catalog, startedAt);
  return structuredClone(catalog);
}

/** Keep a catalog read from Shopify (the cart's `fresh` path too), so a
 *  read moments later in this isolate can reuse it (`recentCatalog`).
 *  `fetchedAt` is when the read STARTED: its data is no newer than that. A
 *  slow read that started before the kept one never replaces it, and never
 *  makes an older catalog look younger. */
export function rememberCatalog(market: string, catalog: Catalog, fetchedAt: number): void {
  const kept = catalogMemo.get(market);
  if (kept && kept.fetchedAt >= fetchedAt) return;
  catalogMemo.set(market, {catalog: structuredClone(catalog), fetchedAt});
}

/** The memoised catalog for `market` when it is younger than `maxAgeMs`,
 *  else a new read (kept in the memo). The cart loader right after a Ship to
 *  switch reads the catalog the switch's POST just read (cart-replan.ts). */
export async function recentCatalog(
  market: string,
  maxAgeMs: number,
  load: () => Promise<Catalog>,
  now: () => number = Date.now,
): Promise<Catalog> {
  const hit = catalogMemo.get(market);
  if (hit && now() - hit.fetchedAt < maxAgeMs) return structuredClone(hit.catalog);
  const startedAt = now();
  const catalog = await load();
  rememberCatalog(market, catalog, startedAt);
  return structuredClone(catalog);
}

/** A fresh Shopify read that is also kept in the memo, stamped when it
 *  started (catalog-client `fresh`). */
export async function readAndRemember(market: string, load: () => Promise<Catalog>, now: () => number = Date.now): Promise<Catalog> {
  const startedAt = now();
  const catalog = await load();
  rememberCatalog(market, catalog, startedAt);
  return catalog;
}

/** For tests: forget every memoised catalog. */
export function clearCatalogMemo(): void {
  catalogMemo.clear();
}
