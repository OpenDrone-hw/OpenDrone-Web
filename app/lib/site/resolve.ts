/**
 * The site on a request's hostname, read from the app (`storefront.site`, `storefront.page`) when SITE_SOURCE is exactly
 * 'app' and APP_API_URL is set; otherwise, and on any failure with nothing cached, the bundled default, so opendrone.be is
 * unchanged. A host the app does not know answers null: the caller responds 404, never another site's content.
 *
 * Cached at the edge by host (fresh for FRESH_SECONDS, served stale up to STALE_SECONDS when the app does not answer).
 * The app takes no `project` here: the host names the site.
 */
import {AppUnavailable, edgeCache, type AppEnv, type Envelope} from '../commerce/app-api.ts';
import {defaultSite, siteFromAnswer, type AppSiteAnswer, type SiteConfig} from './config.ts';

export type SiteEnv = Partial<Pick<AppEnv, 'APP_API_URL' | 'APP_ACCESS_CLIENT_ID' | 'APP_ACCESS_CLIENT_SECRET' | 'APP_STOREFRONT_TOKEN'>> & {SITE_SOURCE?: string};

const FRESH_SECONDS = 60;
const STALE_SECONDS = 86400;

export function siteFromAppEnabled(env: SiteEnv): boolean {
  return env.SITE_SOURCE === 'app' && Boolean(env.APP_API_URL);
}

/** One app operation with the Access service token and the storefront bearer; `not_found` answers null. */
async function siteOp<T>(env: SiteEnv, name: string, args: Record<string, unknown>, fetcher: typeof fetch): Promise<T | null> {
  let res: Response;
  try {
    res = await fetcher(`${(env.APP_API_URL ?? '').replace(/\/+$/, '')}/api/ops/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'CF-Access-Client-Id': env.APP_ACCESS_CLIENT_ID ?? '',
        'CF-Access-Client-Secret': env.APP_ACCESS_CLIENT_SECRET ?? '',
        authorization: `Bearer ${env.APP_STOREFRONT_TOKEN ?? ''}`,
      },
      body: JSON.stringify(args),
    });
  } catch {
    throw new AppUnavailable(`${name}: app unreachable`);
  }
  if (!(res.headers.get('content-type') ?? '').includes('application/json')) throw new AppUnavailable(`${name}: app answered HTTP ${res.status}`);
  const out = (await res.json()) as Envelope<T>;
  if (out.ok && out.data !== undefined) return out.data;
  if (out.error?.code === 'not_found') return null;
  throw new AppUnavailable(`${name}: ${out.error?.code ?? 'no data'}`);
}

export type Resolver = {fetcher?: typeof fetch; cache?: Cache | null; now?: () => number};

/** Fresh edge copy, else the app, else a stale copy; `undefined` when the app cannot be asked and nothing is cached. */
async function cached<T>(env: SiteEnv, key: string, args: Record<string, unknown>, name: string, r: Resolver): Promise<T | null | undefined> {
  const cache = r.cache === undefined ? edgeCache() : r.cache;
  const now = r.now ?? Date.now;
  const k = new Request(`https://app-site.invalid/${name}/${encodeURIComponent(key)}`);
  const hit = cache ? await cache.match(k).catch(() => undefined) : undefined;
  const stored = hit ? ((await hit.json().catch(() => null)) as {at: number; data: T} | null) : null;
  if (stored && now() - stored.at < FRESH_SECONDS * 1000) return stored.data;
  try {
    const data = await siteOp<T>(env, name, args, r.fetcher ?? fetch);
    if (data !== null && cache) {
      await cache
        .put(k, new Response(JSON.stringify({at: now(), data}), {headers: {'content-type': 'application/json', 'cache-control': `max-age=${STALE_SECONDS}`}}))
        .catch(() => undefined);
    }
    return data;
  } catch {
    return stored ? stored.data : undefined;
  }
}

/** The site for the request's host, or null when the app says no site is published there (respond 404). */
export async function resolveSite(request: Request, env: SiteEnv, r: Resolver = {}): Promise<SiteConfig | null> {
  if (!siteFromAppEnabled(env)) return defaultSite();
  const host = new URL(request.url).hostname.toLowerCase();
  const answer = await cached<AppSiteAnswer>(env, host, {host}, 'storefront.site', r);
  if (answer === undefined) return defaultSite();
  return answer === null ? null : siteFromAnswer(answer);
}

export type AppPage = {title: string; slug: string; kind: string; seo_title?: string | null; description?: string | null; body: string};

/** One page of the site on this host, only for a slug of the site's own page index (never the home page, whose route exists). */
export async function resolvePage(site: SiteConfig, host: string, slug: string, env: SiteEnv, r: Resolver = {}): Promise<AppPage | null> {
  if (!site.fromApp || !siteFromAppEnabled(env) || !slug || !site.pages.some((p) => p.slug === slug && p.kind !== 'home')) return null;
  const h = host.toLowerCase();
  return (await cached<AppPage>(env, `${h}/${slug}`, {host: h, slug}, 'storefront.page', r)) ?? null;
}
