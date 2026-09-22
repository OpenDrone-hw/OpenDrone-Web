import {shippingQuote} from './shipping-rates.ts';

type CartCountryEnv = Pick<Env, 'SHOPIFY_CHECKOUT_WRITE_ENABLED' | 'PUBLIC_COMING_SOON'>;

export type CartCountryDependencies = {
  getCartId: () => string | undefined;
  /** `cartBuyerIdentityUpdate` with the country code; throws on a user error. */
  setCountry: (cartId: string, countryCode: string) => Promise<void>;
  logError?: (message: string) => void;
};

const NO_STORE = {'Cache-Control': 'no-store'};

function reply(body: Record<string, unknown>, status: number): Response {
  return Response.json(body, {status, headers: NO_STORE});
}

/**
 * POST /api/shopify/cart-country: the country picked in the cart goes on the
 * session cart as `buyerIdentity.countryCode`, so checkout opens in that
 * country's market with its shipping rate, instead of the market of the
 * visitor's IP address. The form body carries `country` (ISO 3166-1 alpha-2).
 *
 * The line prices do not change: every market prices tax-inclusive, so a
 * buyer outside the EU pays the listed price and Shopify charges no Belgian
 * VAT on it. No cart yet is not an error: the next cart starts from the
 * visitor's country, and checkout still decides from the shipping address.
 */
export async function handleCartCountry(
  request: Request,
  env: CartCountryEnv,
  dependencies: CartCountryDependencies,
): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', {status: 405, headers: {Allow: 'POST', ...NO_STORE}});
  }
  if (env.SHOPIFY_CHECKOUT_WRITE_ENABLED !== '1' || env.PUBLIC_COMING_SOON !== '0') {
    return reply({error: 'closed'}, 404);
  }
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
  const quote = shippingQuote(/^[A-Z]{2}$/.test(country) ? country : null);
  if (!quote) return reply({error: 'unknown country'}, 400);
  // A blocked country never goes on the cart; the cart page already refuses
  // checkout for it.
  if (quote.blocked) return reply({country: quote.country, applied: false}, 200);

  const cartId = dependencies.getCartId();
  if (!cartId) return reply({country: quote.country, applied: false}, 200);
  try {
    await dependencies.setCountry(cartId, quote.country);
  } catch (error) {
    dependencies.logError?.(
      `cart country ${quote.country} not set: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
    return reply({country: quote.country, applied: false}, 502);
  }
  return reply({country: quote.country, applied: true}, 200);
}
