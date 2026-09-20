import {bySku, type Catalog} from './catalog.ts';
import {isPurchasableStatus, resolveStatus} from './product-content.ts';
import {requestedLines} from './shopify-cart-input.ts';
import type {ShopifyCart} from './shopify-storefront.ts';

type CartEnv = Pick<
  Env,
  'SHOPIFY_ADAPTER_PREVIEW' | 'SHOPIFY_CHECKOUT_WRITE_ENABLED' | 'PUBLIC_COMING_SOON'
>;
export type ShopifyCartDependencies = {
  fetchCatalog: () => Promise<Catalog>;
  createCart: (lines: Array<{merchandiseId: string; quantity: number}>) => Promise<ShopifyCart>;
  getCartId?: () => string | undefined;
  setCartId?: (id: string) => void;
  unsetCartId?: () => void;
  getCart?: (id: string) => Promise<ShopifyCart | null>;
  addCartLines?: (id: string, lines: Array<{merchandiseId: string; quantity: number}>) => Promise<ShopifyCart>;
  logError?: (message: string) => void;
};

export async function handleShopifyCartAction(request: Request, env: CartEnv, dependencies: ShopifyCartDependencies): Promise<Response> {
  if (request.method !== 'POST') throw new Response('Method Not Allowed', {status: 405, headers: {Allow: 'POST'}});
  if (env.SHOPIFY_ADAPTER_PREVIEW !== '1') throw new Response('Shopify checkout is not enabled.', {status: 404});
  if (env.SHOPIFY_CHECKOUT_WRITE_ENABLED !== '1') {
    throw new Response('Shopify checkout writes are not enabled.', {
      status: 404,
      headers: {'Cache-Control': 'no-store'},
    });
  }
  // Same fail-closed rule as the UI helper: only an explicit 0 opens.
  const globalComingSoon = env.PUBLIC_COMING_SOON !== '0';
  if (globalComingSoon) {
    throw new Response('Checkout is closed.', {
      status: 404,
      headers: {'Cache-Control': 'no-store'},
    });
  }
  if (request.headers.get('Origin') !== new URL(request.url).origin) {
    throw new Response('Forbidden', {status: 403, headers: {'Cache-Control': 'no-store'}});
  }
  const contentType = request.headers.get('Content-Type') ?? '';
  if (!contentType.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
    throw new Response('Invalid form body.', {
      status: 400,
      headers: {'Cache-Control': 'no-store'},
    });
  }
  const contentLength = Number(request.headers.get('Content-Length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > 8192) {
    throw new Response('Invalid form body.', {
      status: 413,
      headers: {'Cache-Control': 'no-store'},
    });
  }
  let form: FormData;
  try { form = await request.formData(); } catch {
    throw new Response('Invalid form body.', {status: 400, headers: {'Cache-Control': 'no-store'}});
  }
  if (form.has('mode')) throw new Response('Cart mode is not supported.', {status: 400});
  const requested = requestedLines(form);
  try {
    const catalog = await dependencies.fetchCatalog();
    const lines = requested.map(({sku, quantity}) => {
      const match = bySku(catalog, sku);
      if (!match?.variant.merchandise_id || match.variant.availability === 'sold_out') {
        throw new Response('Product is unavailable.', {status: 409, headers: {'Cache-Control': 'no-store'}});
      }
      // The request-time catalog proves the SKU and stock state. The
      // storefront lifecycle remains an independent server-side release gate:
      // a roadmap concept must never become orderable merely because a Shopify
      // variant exists. Product content can explicitly open preorder/live.
      const status = resolveStatus(match.product.handle, globalComingSoon);
      if (!isPurchasableStatus(status)) {
        throw new Response('Product is unavailable.', {
          status: 409,
          headers: {'Cache-Control': 'no-store'},
        });
      }
      return {merchandiseId: match.variant.merchandise_id, quantity};
    });
    const existingId = dependencies.getCartId?.();
    let cart: ShopifyCart;
    if (existingId) {
      if (!dependencies.getCart || !dependencies.addCartLines) throw new Error('shopify: cart session dependencies missing');
      const existing = await dependencies.getCart(existingId);
      if (!existing) {
        dependencies.unsetCartId?.();
        throw new Response('Cart expired. Start a new cart.', {status: 409, headers: {'Cache-Control': 'no-store'}});
      }
      const quantities = new Map<string, number>();
      for (const line of existing.lines) {
        quantities.set(
          line.merchandiseId,
          (quantities.get(line.merchandiseId) ?? 0) + line.quantity,
        );
      }
      for (const line of lines) {
        if ((quantities.get(line.merchandiseId) ?? 0) + line.quantity > 50) {
          throw new Response('Cart quantity exceeds the limit.', {status: 400});
        }
      }
      cart = await dependencies.addCartLines(existingId, lines);
    } else {
      cart = await dependencies.createCart(lines);
      dependencies.setCartId?.(cart.id);
    }
    return new Response(null, {status: 303, headers: {Location: cart.checkoutUrl, 'Cache-Control': 'no-store'}});
  } catch (error) {
    if (error instanceof Response) throw error;
    dependencies.logError?.(error instanceof Error ? error.message : 'unknown error');
    throw new Response('Checkout temporarily unavailable.', {status: 503, headers: {'Retry-After': '60', 'Cache-Control': 'no-store'}});
  }
}

export async function handleShopifyCartLoader(env: CartEnv, dependencies: Pick<ShopifyCartDependencies, 'getCartId' | 'unsetCartId' | 'getCart' | 'logError'>): Promise<Response> {
  // This deployment is a closed catalog. Never turn an old session cookie
  // into a checkout redirect, even if the cart was created during testing.
  // Reopening commerce requires a separately reviewed cart surface.
  void env;
  void dependencies;
  throw new Response('Checkout is closed.', {
    status: 410,
    headers: {'Cache-Control': 'no-store'},
  });
}
