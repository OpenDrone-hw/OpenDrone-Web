/**
 * App mode (COMMERCE_SOURCE=app): the shop images the app copied (incutec-app server/commerce/media.py) are served from
 * the site's own path, `APP_MEDIA_PATH` (default /shop-media; the app's `[commerce] media_path` must be the same value).
 * GET <path>/<sha256>.<ext> is proxied to the app's GET /media/site/<sha256>.<ext> with the service headers, only an
 * image answer passes, and the edge keeps it for as long as the app's cache headers say (the app sends immutable).
 * Anything else under the path, or any other method, is a 404.
 */
import {appCommerceEnabled, type AppEnv} from './app-api.ts';

export const DEFAULT_MEDIA_PATH = '/shop-media';
/** A copy's public file name: the sha256 of its bytes and an extension. */
const NAME = /^[0-9a-f]{64}\.[a-z0-9]{2,5}$/;
const PASS = ['content-type', 'cache-control', 'etag', 'content-length', 'x-content-type-options', 'content-security-policy'];

export function mediaPath(env: Pick<AppEnv, never> & {APP_MEDIA_PATH?: string}): string {
  const raw = (env.APP_MEDIA_PATH ?? '').trim().replace(/\/+$/, '');
  if (!raw) return DEFAULT_MEDIA_PATH;
  return raw.startsWith('/') ? raw : `/${raw}`;
}

const notFound = () => new Response('Not found', {status: 404, headers: {'Cache-Control': 'no-store'}});

/** The media proxy's answer, or null when the request is not under the media path (or not app mode). */
export async function handleAppMedia(
  request: Request,
  env: AppEnv & {APP_MEDIA_PATH?: string},
  cache: Cache | null = null,
  fetcher: typeof fetch = fetch,
  keep: (work: Promise<unknown>) => void = () => {},
): Promise<Response | null> {
  if (!appCommerceEnabled(env)) return null;
  const base = mediaPath(env);
  const {pathname} = new URL(request.url);
  if (!pathname.startsWith(`${base}/`)) return null;
  const name = pathname.slice(base.length + 1);
  if ((request.method !== 'GET' && request.method !== 'HEAD') || !NAME.test(name)) return notFound();
  const key = new Request(request.url, {method: 'GET'});
  const hit = cache ? await cache.match(key) : undefined;
  if (hit) return request.method === 'HEAD' ? new Response(null, hit) : hit;
  let upstream: Response;
  try {
    upstream = await fetcher(`${(env.APP_API_URL ?? '').replace(/\/+$/, '')}/media/site/${name}`, {
      method: 'GET',
      headers: {
        'CF-Access-Client-Id': env.APP_ACCESS_CLIENT_ID ?? '',
        'CF-Access-Client-Secret': env.APP_ACCESS_CLIENT_SECRET ?? '',
        authorization: `Bearer ${env.APP_STOREFRONT_TOKEN ?? ''}`,
      },
    });
  } catch {
    return new Response('Media unavailable', {status: 502, headers: {'Cache-Control': 'no-store'}});
  }
  const type = (upstream.headers.get('content-type') ?? '').toLowerCase();
  if (upstream.status === 404 || !upstream.ok || !type.startsWith('image/')) {
    await upstream.body?.cancel();
    return upstream.status >= 500 ? new Response('Media unavailable', {status: 502, headers: {'Cache-Control': 'no-store'}}) : notFound();
  }
  const headers = new Headers();
  for (const h of PASS) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  const response = new Response(upstream.body, {status: 200, headers});
  // Respect the app's own cache headers: only a response that allows caching is kept at the edge.
  if (cache && /max-age=\d+|s-maxage=\d+/.test(headers.get('cache-control') ?? '') && !/no-store|private/.test(headers.get('cache-control') ?? '')) {
    keep(cache.put(key, response.clone()));
  }
  return request.method === 'HEAD' ? new Response(null, response) : response;
}
