/**
 * Short tracking links of the films: GET /v/<slug> answers 302 to the target the app holds for that slug
 * (op `storefront.video_links`, answer `{links: {slug: target}, version}`). Not commerce: it works in both
 * commerce modes, as long as APP_API_URL is set; without it /v/* falls through to the normal 404.
 *
 * The table is read through the shared snapshot helper (edge copy, last good copy when the app is down) and held
 * in memory for a short time per isolate, so a hit costs no app call. A target is only ever a same-site path
 * starting with a single '/', so the table can never become an open redirect.
 */
import {edgeCache, snapshot, type AppEnv} from './app-api.ts';

export type VideoLinks = {links: Record<string, string>; version: string};

const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const LINKS_TTL_MS = 60_000;

let memo: {key: string; at: number; value: VideoLinks} | null = null;

/** Test hook: forget the in-memory copy. */
export function resetVideoLinksMemo(): void {
  memo = null;
}

/** A same-site relative target, or null: starts with one '/', no '//', no backslash, no scheme, no control characters. */
export function safeTarget(target: unknown): string | null {
  if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//')) return null;
  if (target.includes('\\') || [...target].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)) return null;
  try {
    const parsed = new URL(target, 'https://site.invalid');
    if (parsed.origin !== 'https://site.invalid') return null;
  } catch {
    return null;
  }
  return target;
}

async function links(env: AppEnv, cache: Cache | null, fetcher: typeof fetch, now: number): Promise<VideoLinks> {
  const key = `${env.APP_API_URL}|${env.APP_PROJECT ?? ''}`;
  if (memo && memo.key === key && now - memo.at < LINKS_TTL_MS) return memo.value;
  try {
    const value = await snapshot<VideoLinks>(env, 'storefront.video_links', cache, fetcher);
    memo = {key, at: now, value};
    return value;
  } catch (err) {
    // Neither the app nor an edge copy answered: keep the last good copy in memory, and retry in a minute.
    if (memo && memo.key === key) {
      memo = {...memo, at: now};
      return memo.value;
    }
    throw err;
  }
}

/** Null when the path is not /v/<slug> (the request goes on); otherwise the redirect, or a 404 Response to be replaced by the site's page. */
export async function handleVideoLink(
  request: Request,
  env: Partial<AppEnv>,
  cache: Cache | null = edgeCache(),
  fetcher: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<Response | null> {
  const url = new URL(request.url);
  const m = /^\/v\/([^/]+)$/.exec(url.pathname);
  if (!m) return null;
  if (!env.APP_API_URL || (request.method !== 'GET' && request.method !== 'HEAD')) return null;
  const slug = decodeURIComponent(m[1] ?? '');
  if (!SLUG.test(slug)) return null;
  let table: VideoLinks;
  try {
    table = await links(env as AppEnv, cache, fetcher, now);
  } catch {
    return null;
  }
  const target = Object.hasOwn(table.links ?? {}, slug) ? safeTarget(table.links[slug]) : null;
  if (!target) return null;
  return new Response(null, {status: 302, headers: {location: new URL(target, url.origin).toString(), 'cache-control': 'public, max-age=60', 'x-robots-tag': 'noindex'}});
}
