/**
 * The app as the commerce backend (incutec-app plan STOREFRONT-OFF-SHOPIFY): this site is a thin front that
 * reads the catalog and posts from the app and hands cart, checkout and order status to it. No price, tax or
 * order logic lives here.
 *
 * Off unless COMMERCE_SOURCE is exactly 'app'. Production and staging never set it (a test reads both wrangler
 * files), so every /shop route answers 404 there and the Shopify paths are untouched.
 *
 * The app sits behind Cloudflare Access: each call carries the Access service token and the app's storefront
 * service bearer. Catalog and posts are cached at the edge by their snapshot and served stale when the app does
 * not answer, so browsing survives an app outage; checkout does not, and says so.
 */
import {createCookie} from 'react-router';

export type AppEnv = Pick<
  Env,
  'COMMERCE_SOURCE' | 'APP_API_URL' | 'APP_ACCESS_CLIENT_ID' | 'APP_ACCESS_CLIENT_SECRET' | 'APP_STOREFRONT_TOKEN' | 'APP_PROJECT' | 'SESSION_SECRET'
>;

export function appCommerceEnabled(env: Partial<AppEnv>): boolean {
  return env.COMMERCE_SOURCE === 'app' && Boolean(env.APP_API_URL);
}

/** 404 for every /shop route while the app source is off. */
export function requireAppCommerce(env: Partial<AppEnv>): void {
  if (!appCommerceEnabled(env)) throw new Response('Not found', {status: 404});
}

export class AppUnavailable extends Error {}

export type Envelope<T> = {ok: boolean; data?: T; error?: {code: string; detail: string}};

/** One app operation: POST <APP_API_URL>/api/ops/<name> with the JSON args. Throws AppUnavailable on transport trouble. */
export async function appOp<T>(env: AppEnv, name: string, args: Record<string, unknown>, fetcher: typeof fetch = fetch): Promise<Envelope<T>> {
  const url = `${(env.APP_API_URL ?? '').replace(/\/+$/, '')}/api/ops/${encodeURIComponent(name)}`;
  let res: Response;
  try {
    res = await fetcher(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'CF-Access-Client-Id': env.APP_ACCESS_CLIENT_ID ?? '',
        'CF-Access-Client-Secret': env.APP_ACCESS_CLIENT_SECRET ?? '',
        authorization: `Bearer ${env.APP_STOREFRONT_TOKEN ?? ''}`,
      },
      body: JSON.stringify({project: env.APP_PROJECT ?? '', ...args}),
    });
  } catch {
    throw new AppUnavailable(`${name}: app unreachable`);
  }
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) throw new AppUnavailable(`${name}: app answered HTTP ${res.status}`);
  return (await res.json()) as Envelope<T>;
}

/**
 * A snapshot op (catalog, posts) with stale-if-error: a fresh answer refreshes the edge copy; an app that does
 * not answer serves the last copy (up to `staleSeconds`). No copy and no app: AppUnavailable.
 */
export async function snapshot<T>(env: AppEnv, name: string, cache: Cache | null, fetcher: typeof fetch = fetch, staleSeconds = 86400): Promise<T> {
  const key = new Request(`https://app-snapshot.invalid/${name}/${encodeURIComponent(env.APP_PROJECT ?? '')}`);
  try {
    const out = await appOp<T>(env, name, {}, fetcher);
    if (!out.ok || out.data === undefined) throw new AppUnavailable(`${name}: ${out.error?.code ?? 'no data'}`);
    if (cache) {
      await cache.put(key, new Response(JSON.stringify(out.data), {headers: {'content-type': 'application/json', 'cache-control': `max-age=${staleSeconds}`}}));
    }
    return out.data;
  } catch (err) {
    const hit = cache ? await cache.match(key) : undefined;
    if (hit) return (await hit.json()) as T;
    throw err instanceof AppUnavailable ? err : new AppUnavailable(`${name}: ${String(err)}`);
  }
}

export function edgeCache(): Cache | null {
  const c = (globalThis as {caches?: {default?: Cache}}).caches;
  return c?.default ?? null;
}

// ---- Shapes the app answers (incutec-app server/commerce/catalog.py, checkout.py) ----

export type AppVariant = {
  id: string;
  sku: string;
  title: string;
  price: string | null;
  price_minor: number | null;
  compare_at_minor: number | null;
  available: boolean;
  options: Record<string, string>;
};
export type AppProduct = {
  id: string;
  handle: string;
  title: string;
  type: string;
  tags: string[];
  description_html: string;
  seo: {title: string; description: string};
  image: {url: string; alt: string} | null;
  media: Array<{url: string; alt: string}>;
  variants: AppVariant[];
};
export type AppCatalog = {currency: string; products: AppProduct[]; version: string};
export type AppPost = {
  handle: string;
  title: string;
  published_at: string;
  excerpt: string | null;
  tags: string[];
  author: string | null;
  image: {url: string; alt: string} | null;
  content_html: string;
};
export type CartLine = {variant: string; qty: number};
export type AppliedDiscount = {
  code: string | null;
  title: string;
  method: 'code' | 'automatic';
  class: 'product' | 'order' | 'shipping';
  kind: 'percent' | 'fixed' | 'free_shipping' | 'bxgy';
  value: number;
  minor: number;
};
export type Quote = {
  lines: Array<{variant: string; sku?: string; title: string; variant_title: string; qty: number; unit_minor: number; total_minor: number; sale_mode?: 'in_stock' | 'preorder' | 'sold_out'; ship_promise?: string | null; vat_rate?: number; vat_minor?: number; /** This line's share of the discounts; absent from an older app. */ discount_minor?: number}>;
  currency: string;
  subtotal_minor: number;
  shipping_minor: number;
  total_minor: number;
  vat_rate: number;
  vat_included_minor: number;
  /** The app's own wording of the VAT line, e.g. "Includes VAT (19%)". Absent from an older app. */
  vat_label?: string;
  shipping_vat_minor?: number;
  /** The applied discount code, its amount off the subtotal, or why a code given does not apply. */
  discount?: {code: string; kind: 'percent' | 'fixed' | 'free_shipping'; value: number; minor: number} | null;
  discount_minor?: number;
  /** Every discount applied, automatic ones included. Absent from an older app (then `discount` is all there is). */
  discounts?: AppliedDiscount[];
  discount_problem?: string | null;
  /** Free-shipping progress; null when the app offers none. */
  free_shipping?: {threshold_minor: number; remaining_minor: number} | null;
  pickup?: boolean;
  pickup_available?: boolean;
  /** The shipping charge before pickup, a free-shipping threshold or a code. */
  shipping_standard_minor?: number;
  /** Countries the app ships to (the picker); empty means no list was given. */
  ship_countries?: string[];
};

/** The VAT line's wording: the app's `vat_label`; from an older app (no label) the amount is shown without a rate, never a
 *  guessed one. */
export function vatLabel(quote: Pick<Quote, 'vat_label'>): string {
  return quote.vat_label?.trim() || 'Includes VAT';
}

export function formatMoney(minor: number | null | undefined, currency = 'EUR'): string {
  if (minor == null) return '';
  return new Intl.NumberFormat('en-IE', {style: 'currency', currency}).format(minor / 100);
}

// ---- Cart: a signed cookie of lines; the app prices them ----

const MAX_LINES = 20;
const MAX_QTY = 20;

export function cartCookie(env: Pick<AppEnv, 'SESSION_SECRET'>) {
  return createCookie('od_app_cart', {
    httpOnly: true,
    // The whole site: the buy buttons post to /api/shopify/cart and the cart link is /cart, both outside /shop.
    path: '/',
    sameSite: 'lax',
    secure: true,
    secrets: [env.SESSION_SECRET],
    maxAge: 60 * 60 * 24 * 14,
  });
}

/** Lines from untrusted input: known shape, positive bounded quantities, one line per variant. */
export function cleanLines(raw: unknown): CartLine[] {
  if (!Array.isArray(raw)) return [];
  const out = new Map<string, number>();
  for (const l of raw) {
    const v = (l as {variant?: unknown})?.variant;
    const q = (l as {qty?: unknown})?.qty;
    if (typeof v !== 'string' || !v || v.length > 200 || typeof q !== 'number' || !Number.isInteger(q)) continue;
    const qty = Math.min(MAX_QTY, (out.get(v) ?? 0) + q);
    if (qty <= 0) out.delete(v);
    else out.set(v, qty);
  }
  return [...out.entries()].slice(0, MAX_LINES).map(([variant, qty]) => ({variant, qty}));
}

export async function readCart(request: Request, env: Pick<AppEnv, 'SESSION_SECRET'>): Promise<CartLine[]> {
  const value = await cartCookie(env).parse(request.headers.get('Cookie'));
  return cleanLines(value);
}

export async function writeCart(lines: CartLine[], env: Pick<AppEnv, 'SESSION_SECRET'>): Promise<string> {
  return cartCookie(env).serialize(cleanLines(lines));
}

/** The status token of the buyer's last order, kept beside the cart so the status page needs no account. */
export function orderCookie(env: Pick<AppEnv, 'SESSION_SECRET'>) {
  return createCookie('od_app_order', {
    httpOnly: true,
    path: '/shop',
    sameSite: 'lax',
    secure: true,
    secrets: [env.SESSION_SECRET],
    maxAge: 60 * 60 * 24 * 30,
  });
}

/** The app accepts an https return URL only. A local dev server is plain http, so there (never in a build) the
 *  origin is named as https: bank transfer has no payment step to come back from. */
export function returnOrigin(origin: string, dev: boolean): string {
  return dev && origin.startsWith('http://') ? `https://${origin.slice('http://'.length)}` : origin;
}

/**
 * Whether an order number belongs to an email, asked of the app (storefront.order_match: only `matched` and the number
 * come back, and "no such order" looks like "wrong email"). Used by support tickets in app mode instead of Shopify.
 * Never throws: an app that does not answer is "not matched".
 */
export async function appOrderMatch(env: AppEnv, number: string, email: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  try {
    const out = await appOp<{matched: boolean}>(env, 'storefront.order_match', {number, email}, fetcher);
    return out.ok && out.data?.matched === true;
  } catch {
    console.warn('[support] app order match failed');
    return false;
  }
}
