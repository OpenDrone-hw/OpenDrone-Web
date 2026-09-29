import type {Catalog} from './catalog.ts';
import {type Region} from './preorder-campaign.ts';
import {type RegistrationsFile} from './registrations.ts';
import {blockedIpCountry, shipCountryCookie, shippingQuote} from './shipping-rates.ts';
import {
  cartSummary,
  checkoutOpen,
  regionForDestination,
  rederiveLines,
  type CartSummary,
} from './shopify-cart-action.ts';
import type {CartLineUpdate, ShopifyCart} from './shopify-storefront.ts';
import {usSalesRate} from './us-sales.ts';

type CartCountryEnv = Pick<Env, 'SHOPIFY_CHECKOUT_WRITE_ENABLED' | 'PUBLIC_COMING_SOON' | 'PUBLIC_US_SALES'>;

export type CartCountryDependencies = {
  registrations?: RegistrationsFile;
  /** The open US rate for isolated tests; runtime reads `usSalesRate(env)`. */
  usRate?: number | null;
  getCartId: () => string | undefined;
  /** `cartBuyerIdentityUpdate` with the country code; throws on a user error. */
  setCountry: (cartId: string, countryCode: string) => Promise<void>;
  /** The session cart as Shopify prices it now (in the market of its buyer
   *  country); null when Shopify no longer has it. */
  getCart?: (cartId: string) => Promise<ShopifyCart | null>;
  /** The campaign-aware catalog for a region: its ship promises. */
  fetchCatalog?: (region: Region) => Promise<Catalog>;
  updateCartLines?: (cartId: string, lines: CartLineUpdate[]) => Promise<ShopifyCart>;
  logError?: (message: string) => void;
};

const NO_STORE = {'Cache-Control': 'no-store'};

function reply(body: Record<string, unknown>, status: number): Response {
  return Response.json(body, {status, headers: NO_STORE});
}

/** The JSON the browser gets back. */
export type CartCountryResult = {
  country: string;
  /** True when the cart now carries this country. */
  applied: boolean;
  /** Set when Shopify refused: nothing changed and no cookie was set. */
  error?: string;
  /** The cart as it reads now (new market prices, rewritten promises),
   *  when there is one. */
  summary?: CartSummary;
};

/**
 * POST /api/shopify/cart-country: the destination picked in the cart. The
 * form body carries `country` (ISO 3166-1 alpha-2). For a country sold
 * direct (an approved EU country, and the US while US sales are open) it:
 *
 * 1. puts the country on the session cart as `buyerIdentity.countryCode`, so
 *    Shopify prices the cart in that country's market and checkout opens
 *    there;
 * 2. rewrites every line's `Preorder` promise and hidden region attribute
 *    for the country's region (`rederiveLines`), so the cart never shows or
 *    carries the other region's ship date;
 * 3. remembers the pick in the `od_ship_country` cookie, so every page
 *    quotes it from then on.
 *
 * A country not sold direct only sets the cookie: the cart page then shows
 * the retailer enquiry state and offers no checkout, and the cart keeps its
 * last country. No cart yet is not an error: the next cart starts from the
 * picked country. Lines the region cannot take (an EU-only item for the
 * US) keep their promise; the cart page and checkout refuse them.
 */
export async function handleCartCountry(
  request: Request,
  env: CartCountryEnv,
  dependencies: CartCountryDependencies,
): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', {status: 405, headers: {Allow: 'POST', ...NO_STORE}});
  }
  if (!checkoutOpen(env)) return reply({error: 'closed'}, 404);
  if (request.headers.get('Origin') !== new URL(request.url).origin) {
    return reply({error: 'forbidden'}, 403);
  }
  const contentType = (request.headers.get('Content-Type') ?? '').toLowerCase();
  if (!contentType.startsWith('application/x-www-form-urlencoded')) {
    return reply({error: 'invalid body'}, 400);
  }
  const contentLength = Number(request.headers.get('Content-Length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > 1024) {
    return reply({error: 'invalid body'}, 413);
  }
  let country: string;
  try {
    country = String((await request.formData()).get('country') ?? '').trim().toUpperCase();
  } catch {
    return reply({error: 'invalid body'}, 400);
  }
  // A visitor from a blocked country cannot pick another destination.
  if (blockedIpCountry(request)) return reply({error: 'blocked'}, 403);
  const usRate = dependencies.usRate !== undefined ? dependencies.usRate : usSalesRate(env);
  const quote = shippingQuote(/^[A-Z]{2}$/.test(country) ? country : null, dependencies.registrations, usRate);
  if (!quote) return reply({error: 'unknown country'}, 400);
  const cookie = shipCountryCookie(quote.country, new URL(request.url).protocol === 'https:');
  const remember = (body: CartCountryResult) => {
    const response = reply(body as unknown as Record<string, unknown>, 200);
    if (cookie) response.headers.append('Set-Cookie', cookie);
    return response;
  };
  // A blocked or shops-only country never goes on the cart; the cart page
  // refuses checkout for it.
  if (quote.kind !== 'direct') return remember({country: quote.country, applied: false});

  const cartId = dependencies.getCartId();
  if (!cartId) return remember({country: quote.country, applied: false});
  // The country the cart has now, to put back if the switch half-applies.
  let previous: string | null = null;
  try {
    previous = (await dependencies.getCart?.(cartId))?.country ?? null;
  } catch {
    previous = null;
  }
  let changed = false;
  try {
    await dependencies.setCountry(cartId, quote.country);
    changed = true;
    const summary = await repriceCart(cartId, regionForDestination(quote), env, dependencies);
    return remember({country: quote.country, applied: true, ...(summary ? {summary} : {})});
  } catch (error) {
    dependencies.logError?.(
      `cart country ${quote.country} not set: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
    // Never leave the cart in the new market with the old promises.
    if (changed && previous && previous !== quote.country) {
      await dependencies.setCountry(cartId, previous).catch((restoreError: unknown) => {
        dependencies.logError?.(
          `cart country ${previous} not restored: ${restoreError instanceof Error ? restoreError.message : 'unknown error'}`,
        );
      });
    }
    return reply({country: quote.country, applied: false, error: 'cart'}, 502);
  }
}

/** Read the cart back in its new market and rewrite the promises that
 *  belong to the other region. Null when the cart is gone. */
async function repriceCart(
  cartId: string,
  region: Region,
  env: CartCountryEnv,
  dependencies: CartCountryDependencies,
): Promise<CartSummary | null> {
  if (!dependencies.getCart) return null;
  let cart = await dependencies.getCart(cartId);
  if (!cart) return null;
  if (dependencies.fetchCatalog && dependencies.updateCartLines && cart.lines.length) {
    const catalog = await dependencies.fetchCatalog(region);
    const {refresh} = rederiveLines(cart, catalog, region === 'US', env.PUBLIC_COMING_SOON !== '0');
    if (refresh.length) cart = await dependencies.updateCartLines(cartId, refresh);
  }
  return cartSummary(cart);
}
