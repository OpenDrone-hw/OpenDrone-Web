/**
 * Fetching and caching half of the Odoo catalog.
 *
 * One `GET CATALOG_URL` per worker isolate per five minutes, stored in the
 * worker cache so every isolate on the same colo shares it. When the fetch
 * fails the last good copy is served for up to an hour. A true cold miss is
 * a 503, never an empty catalog that turns valid product URLs into false 404s.
 *
 * The pure half, including every type and mapper, is `app/lib/catalog.ts`.
 */

import {parseCatalog, type Catalog} from './catalog.ts';

export const DEFAULT_CATALOG_URL =
  'https://erp.incutec.eu/incutec/catalog.json';
export const DEFAULT_SHOP_URL = 'https://shop.incutec.com';

/** Fresh window: the contract's 5 minutes. */
const FRESH_MS = 5 * 60 * 1000;
/** How long a stale copy still beats an empty catalog. */
const STALE_MS = 60 * 60 * 1000;

type Cached = {catalog: Catalog; fetchedAt: number};

/** Per-isolate memory, so repeated loaders in one request pay nothing. */
let memo: Cached | null = null;
let inflight: Promise<Catalog> | null = null;

export type CatalogClient = {
  /** The catalog, from memory, the worker cache, or the network. */
  get: () => Promise<Catalog>;
  /** Where buy links and portal links point. */
  shopUrl: string;
};

export function catalogUrl(env: Env): string {
  return env.CATALOG_URL || DEFAULT_CATALOG_URL;
}

export function shopUrl(env: Env): string {
  return (env.PUBLIC_SHOP_URL || DEFAULT_SHOP_URL).replace(/\/+$/, '');
}

export function createCatalogClient({
  env,
  cache,
  waitUntil,
}: {
  env: Env;
  cache?: Cache;
  waitUntil?: (p: Promise<unknown>) => void;
}): CatalogClient {
  const url = catalogUrl(env);
  const shop = shopUrl(env);

  const get = async (): Promise<Catalog> => {
    const now = Date.now();
    if (memo && now - memo.fetchedAt < FRESH_MS) return memo.catalog;
    if (inflight) return inflight;

    inflight = load(url, cache, waitUntil)
      .then((catalog) => {
        memo = {catalog, fetchedAt: Date.now()};
        return catalog;
      })
      .catch((error) => {
        console.error('[catalog] fetch failed', error);
        if (memo && Date.now() - memo.fetchedAt < STALE_MS) return memo.catalog;
        throw new Response('Catalog temporarily unavailable.', {
          status: 503,
          headers: {'Retry-After': '60', 'Cache-Control': 'no-store'},
        });
      })
      .finally(() => {
        inflight = null;
      });

    return inflight;
  };

  return {get, shopUrl: shop};
}

async function load(
  url: string,
  cache?: Cache,
  waitUntil?: (p: Promise<unknown>) => void,
): Promise<Catalog> {
  const request = new Request(url, {headers: {Accept: 'application/json'}});

  if (cache) {
    const hit = await cache.match(request).catch(() => undefined);
    if (hit) {
      const age = Number(hit.headers.get('x-catalog-age') ?? '0');
      const catalog = parseCatalog(await hit.json());
      if (Date.now() - age < FRESH_MS) return catalog;
      // Stale-while-revalidate: serve the cached copy, refresh behind it.
      const refresh = fetchAndStore(request, cache).catch(() => {});
      if (waitUntil) waitUntil(refresh);
      return catalog;
    }
  }

  return fetchAndStore(request, cache);
}

async function fetchAndStore(request: Request, cache?: Cache): Promise<Catalog> {
  const response = await fetch(request);
  if (!response.ok) {
    throw new Error(`catalog: ${request.url} returned ${response.status}`);
  }
  const body = await response.text();
  const catalog = parseCatalog(JSON.parse(body));
  if (cache) {
    const stored = new Response(body, {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        // Keep the last good response available for the full fallback window.
        // x-catalog-age still makes it stale after five minutes and triggers a
        // background refresh; the longer TTL only protects cold isolates.
        'Cache-Control': `max-age=${STALE_MS / 1000}`,
        'x-catalog-age': String(Date.now()),
      },
    });
    await cache.put(request, stored).catch(() => {});
  }
  return catalog;
}

/** Test seam: drop the per-isolate memory. */
export function resetCatalogMemo(): void {
  memo = null;
  inflight = null;
}
