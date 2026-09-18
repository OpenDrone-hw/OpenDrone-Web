/**
 * Fetching and caching half of the live funding overlay.
 *
 * Same shape as `app/lib/catalog-client.ts`: one `GET FUNDING_URL` per
 * worker isolate per freshness window, stored in the worker cache so every
 * isolate on the same colo shares it, with the last good copy served for a
 * while past that on a failed fetch.
 *
 * Two differences from the catalog client, both because this feed is
 * optional and cosmetic rather than load-bearing:
 *  - the freshness window is the contract's 60 seconds, not 5 minutes;
 *  - a request that times out, 404s (the endpoint is not deployed yet), or
 *    otherwise fails, with no usable stale copy either, resolves to
 *    `EMPTY_FUNDING_OVERLAY` instead of rejecting. The catalog's own
 *    numbers are always a valid page; this feed only ever improves on them.
 *
 * The pure half, including every type, the parser and the merge, is
 * `app/lib/funding-overlay.ts`.
 */

import {
  EMPTY_FUNDING_OVERLAY,
  parseFundingOverlay,
  type FundingOverlay,
} from './funding-overlay.ts';

export const DEFAULT_FUNDING_URL = 'https://erp.incutec.com/incutec/funding.json';

/** Fresh window: the contract's 60 seconds. */
const FRESH_MS = 60 * 1000;
/** How long a stale copy still beats falling back to the catalog's numbers. */
const STALE_MS = 60 * 60 * 1000;
/** A wedged or slow endpoint must never wedge a product page. */
const TIMEOUT_MS = 2000;

type Cached = {overlay: FundingOverlay; fetchedAt: number};

/** Per-isolate memory, isolated by endpoint so preview/prod clients never mix. */
const memoByUrl = new Map<string, Cached>();
const inflightByUrl = new Map<string, Promise<FundingOverlay>>();
/**
 * When the last fetch failed, per endpoint. A failure is remembered for one
 * freshness window: without this an endpoint that answers 404 (production
 * until `incutec_funding` is installed there) or times out was fetched again
 * on every single page render, up to `TIMEOUT_MS` each, for a feed that is
 * cosmetic.
 */
const failedAtByUrl = new Map<string, number>();

export type FundingOverlayClient = {
  /** The live overlay, from memory, the worker cache, or the network. Never
   *  rejects: a missing, slow, or 404 feed resolves to an empty overlay. */
  get: () => Promise<FundingOverlay>;
};

export function fundingOverlayUrl(env: Env): string {
  return env.FUNDING_URL || DEFAULT_FUNDING_URL;
}

export function createFundingOverlayClient({
  env,
  cache,
  waitUntil,
}: {
  env: Env;
  cache?: Cache;
  waitUntil?: (p: Promise<unknown>) => void;
}): FundingOverlayClient {
  const url = fundingOverlayUrl(env);
  // Same origin and staging basic auth as the catalog (both served by
  // incutec_catalog_api): no separate credential pair to configure.
  const credentials =
    env.CATALOG_HTTP_USER && env.CATALOG_HTTP_PASSWORD
      ? {user: env.CATALOG_HTTP_USER, password: env.CATALOG_HTTP_PASSWORD}
      : undefined;

  const get = async (): Promise<FundingOverlay> => {
    const now = Date.now();
    const memo = memoByUrl.get(url);
    if (memo && now - memo.fetchedAt < FRESH_MS) return memo.overlay;
    const failedAt = failedAtByUrl.get(url);
    if (failedAt !== undefined && now - failedAt < FRESH_MS) {
      return memo && now - memo.fetchedAt < STALE_MS
        ? memo.overlay
        : EMPTY_FUNDING_OVERLAY;
    }
    const existing = inflightByUrl.get(url);
    if (existing) return existing;

    const request = load(url, cache, waitUntil, credentials)
      .then((loaded) => {
        memoByUrl.set(url, loaded);
        failedAtByUrl.delete(url);
        return loaded.overlay;
      })
      .catch((error) => {
        console.error('[funding-overlay] fetch failed', error);
        failedAtByUrl.set(url, Date.now());
        const fallback = memoByUrl.get(url);
        if (fallback && Date.now() - fallback.fetchedAt < STALE_MS) {
          return fallback.overlay;
        }
        // Cosmetic-only: no stale copy either, so the catalog's own
        // numbers stand. Never a 503 here, unlike the catalog client.
        return EMPTY_FUNDING_OVERLAY;
      })
      .finally(() => {
        inflightByUrl.delete(url);
      });
    inflightByUrl.set(url, request);

    return request;
  };

  return {get};
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
      const fetchedAt = Number(hit.headers.get('x-funding-age') ?? '0');
      const overlay = parseFundingOverlay(await hit.json());
      const age = Date.now() - fetchedAt;
      if (Number.isFinite(fetchedAt) && fetchedAt > 0 && age < STALE_MS) {
        if (age >= FRESH_MS) {
          // Stale-while-revalidate: serve the cached copy, refresh behind it.
          const refresh = fetchAndStore(request, cache, credentials).catch(() => {});
          if (waitUntil) waitUntil(refresh);
        }
        return {overlay, fetchedAt};
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
  // Reject redirects so credentials can only reach the configured funding
  // origin. The uncredentialed cache key remains safe for Cache API storage.
  const response = await fetch(new Request(cacheRequest, {headers}), {
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`funding-overlay: ${cacheRequest.url} returned ${response.status}`);
  }
  const body = await response.text();
  const overlay = parseFundingOverlay(JSON.parse(body));
  const fetchedAt = Date.now();
  if (cache) {
    const stored = new Response(body, {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        // Keep the last good response available for the full fallback
        // window. x-funding-age still makes it stale after 60 seconds and
        // triggers a background refresh; the longer TTL only protects cold
        // isolates.
        'Cache-Control': `max-age=${STALE_MS / 1000}`,
        'x-funding-age': String(fetchedAt),
      },
    });
    await cache.put(cacheRequest, stored).catch(() => {});
  }
  return {overlay, fetchedAt};
}

/** Test seam: drop the per-isolate memory. */
export function resetFundingOverlayMemo(): void {
  memoByUrl.clear();
  inflightByUrl.clear();
  failedAtByUrl.clear();
}
