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
import {fetchShopifyCatalog} from './shopify-storefront.ts';

export const DEFAULT_CATALOG_URL =
  'https://erp.incutec.com/incutec/catalog.json';
export const DEFAULT_SHOP_URL = 'https://shop.incutec.com';

/** Fresh window: the contract's 5 minutes. */
const FRESH_MS = 5 * 60 * 1000;
/** How long a stale copy still beats an empty catalog. */
const STALE_MS = 60 * 60 * 1000;

type Cached = {catalog: Catalog; fetchedAt: number};

/** Per-isolate memory, isolated by endpoint so preview/prod clients never mix. */
const memoByUrl = new Map<string, Cached>();
const inflightByUrl = new Map<string, Promise<Catalog>>();

export type CatalogClient = {
  /** The catalog, from memory, the worker cache, or the network. */
  get: () => Promise<Catalog>;
  /** Where buy links and portal links point. */
  shopUrl: string;
  shopifyPreview: boolean;
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
  const shopifyPreview = env.SHOPIFY_ADAPTER_PREVIEW === '1';
  const credentials =
    env.CATALOG_HTTP_USER && env.CATALOG_HTTP_PASSWORD
      ? {user: env.CATALOG_HTTP_USER, password: env.CATALOG_HTTP_PASSWORD}
      : undefined;

  const get = async (): Promise<Catalog> => {
    if (shopifyPreview) return fetchShopifyCatalog(env);
    const now = Date.now();
    const memo = memoByUrl.get(url);
    if (memo && now - memo.fetchedAt < FRESH_MS) return memo.catalog;
    const existing = inflightByUrl.get(url);
    if (existing) return existing;

    const request = load(url, cache, waitUntil, credentials)
      .then((loaded) => {
        memoByUrl.set(url, loaded);
        return loaded.catalog;
      })
      .catch((error) => {
        console.error('[catalog] fetch failed', error);
        const fallback = memoByUrl.get(url);
        if (fallback && Date.now() - fallback.fetchedAt < STALE_MS) {
          return fallback.catalog;
        }
        throw new Response('Catalog temporarily unavailable.', {
          status: 503,
          headers: {'Retry-After': '60', 'Cache-Control': 'no-store'},
        });
      })
      .finally(() => {
        inflightByUrl.delete(url);
      });
    inflightByUrl.set(url, request);

    return request;
  };

  return {get, shopUrl: shop, shopifyPreview};
}

async function load(
  url: string,
  cache?: Cache,
  waitUntil?: (p: Promise<unknown>) => void,
  credentials?: {user: string; password: string},
): Promise<Cached> {
  const request = new Request(url, {headers: {Accept: 'application/json'}});

  if (cache) {
    const hit = await cache.match(request).catch(() => undefined);
    if (hit) {
      const fetchedAt = Number(hit.headers.get('x-catalog-age') ?? '0');
      const catalog = parseCatalog(await hit.json());
      const age = Date.now() - fetchedAt;
      if (Number.isFinite(fetchedAt) && fetchedAt > 0 && age < STALE_MS) {
        if (age >= FRESH_MS) {
          // Stale-while-revalidate: serve the cached copy, refresh behind it.
          const refresh = fetchAndStore(request, cache, credentials).catch(() => {});
          if (waitUntil) waitUntil(refresh);
        }
        return {catalog, fetchedAt};
      }
      // A cache implementation may retain an entry beyond max-age. Never
      // extend the one-hour fallback window by treating that hit as new.
    }
  }

  return fetchAndStore(request, cache, credentials);
}

async function fetchAndStore(
  cacheRequest: Request,
  cache?: Cache,
  credentials?: {user: string; password: string},
): Promise<Cached> {
  const headers = new Headers(cacheRequest.headers);
  if (credentials) {
    headers.set(
      'Authorization',
      `Basic ${btoa(`${credentials.user}:${credentials.password}`)}`,
    );
  }
  // Reject redirects so credentials can only reach the configured catalog
  // origin. The uncredentialed cache key remains safe for Cache API storage.
  const response = await fetch(new Request(cacheRequest, {headers}), {
    redirect: 'manual',
  });
  if (!response.ok) {
    throw new Error(`catalog: ${cacheRequest.url} returned ${response.status}`);
  }
  const body = await response.text();
  const catalog = parseCatalog(JSON.parse(body));
  const fetchedAt = Date.now();
  if (cache) {
    const stored = new Response(body, {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        // Keep the last good response available for the full fallback window.
        // x-catalog-age still makes it stale after five minutes and triggers a
        // background refresh; the longer TTL only protects cold isolates.
        'Cache-Control': `max-age=${STALE_MS / 1000}`,
        'x-catalog-age': String(fetchedAt),
      },
    });
    await cache.put(cacheRequest, stored).catch(() => {});
  }
  return {catalog, fetchedAt};
}

/** Test seam: drop the per-isolate memory. */
export function resetCatalogMemo(): void {
  memoByUrl.clear();
  inflightByUrl.clear();
}
