/**
 * Same-origin, edge-cached product images from Odoo.
 *
 * The catalog hands out Odoo image URLs
 * (`<shop>/web/image/<model>/<id>/<field>?unique=<hash>`). Hot-linking them
 * made every product image depend on Odoo answering at the moment a visitor
 * loads the page: an Odoo restart or a slow response broke every gallery,
 * and a protected staging origin (Basic auth) broke every preview image.
 *
 * Instead the catalog mapper rewrites them to `/img/odoo/<model>/<id>/<field>`
 * and this Worker handler serves them:
 *
 * - Only allowlisted models and fields are proxied, so the route is never an
 *   open proxy onto the shop.
 * - Responses live in the Workers Cache API with a long public TTL. The
 *   `unique` hash changes whenever Odoo's image changes, so an entry keyed by
 *   it is immutable and never revalidated against Odoo.
 * - Each success also refreshes a "latest" entry keyed without the hash. When
 *   Odoo is down and a new hash is not cached yet, that last known image is
 *   served instead.
 * - Only when nothing was ever cached does a visitor get a small neutral
 *   placeholder (never the browser's broken-image icon), marked `no-store`.
 * - Upstream Basic auth (`CATALOG_HTTP_USER` / `CATALOG_HTTP_PASSWORD`, the
 *   preview Worker's staging credential) is added server-side only and never
 *   reaches the browser. Redirects are not followed, so it can only reach the
 *   configured shop origin.
 *
 * Kept free of worker globals and bundler aliases (relative imports only,
 * dependencies injected) so the node:test suite can load it.
 */

export const ODOO_IMAGE_PREFIX = '/img/odoo/';

const DEFAULT_SHOP_URL = 'https://shop.incutec.com';
const ALLOWED_MODELS = new Set(['product.template', 'product.product', 'product.image']);
const ALLOWED_FIELDS = new Set([
  'image_1920',
  'image_1024',
  'image_512',
  'image_256',
  'image_128',
]);
const UNIQUE_RE = /^[0-9a-zA-Z_-]{1,64}$/;
const ID_RE = /^[1-9][0-9]{0,9}$/;

/** One year: the hash in the key makes a stored image immutable. */
const IMMUTABLE_TTL_S = 365 * 24 * 60 * 60;
/** Without a hash the image may change under the same URL. */
const MUTABLE_TTL_S = 24 * 60 * 60;
const UPSTREAM_TIMEOUT_MS = 8000;
const MAX_BYTES = 10 * 1024 * 1024;

export type OdooImageRef = {
  model: string;
  id: string;
  field: string;
  unique: string | null;
};

export type OdooImageEnv = {
  PUBLIC_SHOP_URL?: string;
  CATALOG_HTTP_USER?: string;
  CATALOG_HTTP_PASSWORD?: string;
};

export type OdooImageDeps = {
  env: OdooImageEnv;
  /** The Workers cache; absent (or failing) degrades to a plain proxy. */
  cache?: Cache;
  waitUntil?: (p: Promise<unknown>) => void;
  /** Injected for tests; defaults to the global fetch. */
  fetcher?: typeof fetch;
};

function isAllowed(model: string, id: string, field: string): boolean {
  return ALLOWED_MODELS.has(model) && ID_RE.test(id) && ALLOWED_FIELDS.has(field);
}

function cleanUnique(value: string | null): string | null {
  return value && UNIQUE_RE.test(value) ? value : null;
}

/**
 * The storefront URL for a catalog image: Odoo `/web/image/...` URLs that
 * pass the allowlist become the same-origin route; anything else is
 * returned unchanged.
 */
export function toStorefrontImageUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const match = /^\/web\/image\/([^/]+)\/([^/]+)\/([^/]+)\/?$/.exec(parsed.pathname);
  if (!match) return url;
  const [, model, id, field] = match;
  if (!isAllowed(model, id, field)) return url;
  const unique = cleanUnique(parsed.searchParams.get('unique'));
  return `${ODOO_IMAGE_PREFIX}${model}/${id}/${field}${unique ? `?unique=${unique}` : ''}`;
}

/** Parse a request URL on the image route, or null when it is not allowed. */
export function parseImageRoute(url: URL): OdooImageRef | null {
  if (!url.pathname.startsWith(ODOO_IMAGE_PREFIX)) return null;
  const parts = url.pathname.slice(ODOO_IMAGE_PREFIX.length).split('/');
  if (parts.length !== 3) return null;
  const [model, id, field] = parts;
  if (!isAllowed(model, id, field)) return null;
  const raw = url.searchParams.get('unique');
  const unique = cleanUnique(raw);
  if (raw !== null && unique === null) return null;
  return {model, id, field, unique};
}

function shopOrigin(env: OdooImageEnv): string {
  return (env.PUBLIC_SHOP_URL || DEFAULT_SHOP_URL).replace(/\/+$/, '');
}

function upstreamUrl(env: OdooImageEnv, ref: OdooImageRef): string {
  const base = `${shopOrigin(env)}/web/image/${ref.model}/${ref.id}/${ref.field}`;
  return ref.unique ? `${base}?unique=${ref.unique}` : base;
}

/**
 * Cache keys. The shop origin is part of the key so a preview (staging) and
 * a production catalog never share entries.
 */
function cacheKeys(siteOrigin: string, env: OdooImageEnv, ref: OdooImageRef) {
  const scope = encodeURIComponent(new URL(shopOrigin(env)).host);
  const base = `${siteOrigin}${ODOO_IMAGE_PREFIX}${ref.model}/${ref.id}/${ref.field}?shop=${scope}`;
  return {
    exact: new Request(ref.unique ? `${base}&unique=${ref.unique}` : base),
    latest: new Request(`${base}&latest=1`),
  };
}

async function cacheMatch(cache: Cache | undefined, key: Request) {
  if (!cache) return undefined;
  try {
    return (await cache.match(key)) ?? undefined;
  } catch {
    return undefined;
  }
}

async function cachePut(cache: Cache | undefined, key: Request, response: Response) {
  if (!cache) return;
  try {
    await cache.put(key, response);
  } catch {
    // A cache that refuses a write only costs a future hit.
  }
}

function authHeader(env: OdooImageEnv): string | null {
  if (!env.CATALOG_HTTP_USER || !env.CATALOG_HTTP_PASSWORD) return null;
  return `Basic ${btoa(`${env.CATALOG_HTTP_USER}:${env.CATALOG_HTTP_PASSWORD}`)}`;
}

/** Fetch the image bytes from Odoo, or throw. */
async function fetchUpstream(
  deps: OdooImageDeps,
  ref: OdooImageRef,
): Promise<{body: ArrayBuffer; contentType: string}> {
  const headers = new Headers({Accept: 'image/*'});
  const auth = authHeader(deps.env);
  if (auth) headers.set('Authorization', auth);
  const response = await (deps.fetcher ?? fetch)(upstreamUrl(deps.env, ref), {
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (response.status !== 200) {
    throw new Error(`odoo-image: upstream returned ${response.status}`);
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!/^image\/[a-z0-9.+-]+/i.test(contentType)) {
    throw new Error(`odoo-image: upstream returned ${contentType || 'no content type'}`);
  }
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > MAX_BYTES) throw new Error('odoo-image: upstream image too large');
  const body = await response.arrayBuffer();
  if (body.byteLength === 0 || body.byteLength > MAX_BYTES) {
    throw new Error('odoo-image: upstream image empty or too large');
  }
  return {body, contentType};
}

function imageResponse(body: ArrayBuffer, contentType: string, ttl: number): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': `public, max-age=${ttl}${ttl === IMMUTABLE_TTL_S ? ', immutable' : ''}`,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/** Neutral square shown only when Odoo is down and nothing was ever cached. */
const PLACEHOLDER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">' +
  '<rect width="64" height="64" fill="#8a8a8a" fill-opacity="0.12"/></svg>';

function placeholder(): Response {
  return new Response(PLACEHOLDER_SVG, {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Image-Fallback': 'placeholder',
    },
  });
}

function finalize(request: Request, response: Response, source: string): Response {
  const headers = new Headers(response.headers);
  headers.set('X-Image-Source', source);
  headers.delete('Set-Cookie');
  return new Response(request.method === 'HEAD' ? null : response.body, {
    status: response.status,
    headers,
  });
}

/**
 * Fetch from Odoo and store under both keys. Throws when Odoo fails; the
 * caller decides what to serve instead.
 */
async function refresh(
  deps: OdooImageDeps,
  ref: OdooImageRef,
  keys: {exact: Request; latest: Request},
): Promise<Response> {
  const {body, contentType} = await fetchUpstream(deps, ref);
  const ttl = ref.unique ? IMMUTABLE_TTL_S : MUTABLE_TTL_S;
  const store = Promise.all([
    cachePut(deps.cache, keys.exact, imageResponse(body, contentType, ttl)),
    cachePut(deps.cache, keys.latest, imageResponse(body, contentType, IMMUTABLE_TTL_S)),
  ]);
  if (deps.waitUntil) deps.waitUntil(store);
  else await store;
  return imageResponse(body, contentType, ttl);
}

/** The Worker handler for `GET|HEAD /img/odoo/<model>/<id>/<field>`. */
export async function handleOdooImage(
  request: Request,
  deps: OdooImageDeps,
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', {status: 405, headers: {Allow: 'GET, HEAD'}});
  }
  const url = new URL(request.url);
  const ref = parseImageRoute(url);
  if (!ref) return new Response('Not found', {status: 404});

  const keys = cacheKeys(url.origin, deps.env, ref);
  const hit = await cacheMatch(deps.cache, keys.exact);
  if (hit) return finalize(request, hit, 'cache');

  try {
    return finalize(request, await refresh(deps, ref, keys), 'origin');
  } catch (error) {
    console.error('[odoo-image]', ref.model, ref.id, ref.field, String(error));
  }

  const stale = await cacheMatch(deps.cache, keys.latest);
  if (stale) {
    const headers = new Headers(stale.headers);
    // A stale copy must not be pinned for a year under the new hash.
    headers.set('Cache-Control', 'public, max-age=60');
    return finalize(request, new Response(stale.body, {status: 200, headers}), 'stale');
  }
  return finalize(request, placeholder(), 'placeholder');
}

/** Every image URL a catalog document references, deduplicated. */
export function catalogImageUrls(catalog: {
  products: Array<{images?: string[]; variants?: Array<{image?: string | null}>}>;
}): string[] {
  const urls = new Set<string>();
  for (const product of catalog.products) {
    for (const image of product.images ?? []) urls.add(image);
    for (const variant of product.variants ?? []) {
      if (variant.image) urls.add(variant.image);
    }
  }
  return [...urls];
}

/**
 * Fill the cache for every catalog image that is not cached yet, a few at a
 * time. Used after an isolate starts (a deploy spins up fresh isolates) so an
 * Odoo outage right after a deploy still finds the images at the edge.
 * Never throws; returns how many images were fetched.
 */
export async function warmOdooImages(
  siteOrigin: string,
  imageUrls: string[],
  deps: OdooImageDeps,
  concurrency = 4,
): Promise<number> {
  const refs: OdooImageRef[] = [];
  for (const raw of imageUrls) {
    const path = toStorefrontImageUrl(raw);
    if (!path.startsWith(ODOO_IMAGE_PREFIX)) continue;
    const ref = parseImageRoute(new URL(path, siteOrigin));
    if (ref) refs.push(ref);
  }
  let fetched = 0;
  let next = 0;
  const worker = async () => {
    while (next < refs.length) {
      const ref = refs[next++];
      const keys = cacheKeys(siteOrigin, deps.env, ref);
      if (await cacheMatch(deps.cache, keys.exact)) continue;
      try {
        await refresh({...deps, waitUntil: undefined}, ref, keys);
        fetched++;
      } catch {
        // Odoo is down or the image is gone; the visitor path handles it.
      }
    }
  };
  await Promise.all(Array.from({length: Math.min(concurrency, refs.length)}, worker));
  return fetched;
}
