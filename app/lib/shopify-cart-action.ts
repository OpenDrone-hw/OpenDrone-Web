import {bySku, type Catalog} from './catalog.ts';
import {isPurchasableStatus, resolveStatus} from './product-content.ts';
import {requestedLines} from './shopify-cart-input.ts';
import type {ShopifyCart} from './shopify-storefront.ts';

type CartSession = Pick<ShopifyCart, 'id' | 'checkoutUrl'> & {
  lines: Array<{id?: string; lineIds?: string[]; merchandiseId: string; quantity: number}>;
};

type CartEnv = Pick<
  Env,
  | 'SHOPIFY_ADAPTER_PREVIEW'
  | 'SHOPIFY_CHECKOUT_WRITE_ENABLED'
  | 'SHOPIFY_SHIPPING_LATER_CONFIRMED'
  | 'PUBLIC_COMING_SOON'
>;
export type ShopifyCartDependencies = {
  fetchCatalog: () => Promise<Catalog>;
  createCart: (lines: Array<{merchandiseId: string; quantity: number}>) => Promise<CartSession>;
  getCartId?: () => string | undefined;
  setCartId?: (id: string) => void;
  unsetCartId?: () => void;
  getCart?: (id: string) => Promise<CartSession | null>;
  addCartLines?: (id: string, lines: Array<{merchandiseId: string; quantity: number}>) => Promise<CartSession>;
  updateCartLines?: (id: string, lines: Array<{id: string; quantity: number}>) => Promise<CartSession>;
  removeCartLines?: (id: string, lineIds: string[]) => Promise<CartSession>;
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
  if (env.SHOPIFY_SHIPPING_LATER_CONFIRMED !== '1') {
    throw new Response('Shipping-later checkout is not confirmed.', {
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
  const intent = String(form.get('intent') ?? 'add');
  if (form.has('mode')) throw new Response('Cart mode is not supported.', {status: 400});
  try {
    const existingId = dependencies.getCartId?.();
    if (intent === 'checkout') {
      if (!existingId || !dependencies.getCart) throw new Response('Cart is empty.', {status: 409});
      const [cart, catalog] = await Promise.all([
        dependencies.getCart(existingId),
        dependencies.fetchCatalog(),
      ]);
      if (!cart) {
        dependencies.unsetCartId?.();
        throw new Response('Cart expired. Add your items again.', {status: 409});
      }
      const openIds = new Set(
        catalog.products.flatMap((product) => {
          const status = resolveStatus(product.handle, globalComingSoon);
          return isPurchasableStatus(status)
            ? product.variants
                .filter((variant) => variant.availability !== 'sold_out')
                .map((variant) => variant.merchandise_id)
                .filter((id): id is string => Boolean(id))
            : [];
        }),
      );
      if (cart.lines.some((line) => !openIds.has(line.merchandiseId))) {
        throw new Response('One or more cart items are no longer available.', {status: 409});
      }
      return new Response(null, {status: 303, headers: {Location: cart.checkoutUrl, 'Cache-Control': 'no-store'}});
    }
    if (intent === 'update' || intent === 'remove') {
      if (!existingId) throw new Response('Cart is empty.', {status: 409});
      const lineIds = form.getAll('lineId').map(String);
      if (!lineIds.length || lineIds.some((lineId) => !/^gid:\/\/shopify\/CartLine\/[A-Za-z0-9?=_-]+$/.test(lineId))) {
        throw new Response('Invalid cart line.', {status: 400});
      }
      let cart: CartSession;
      if (intent === 'remove') {
        if (!dependencies.removeCartLines) throw new Error('shopify: remove dependency missing');
        cart = await dependencies.removeCartLines(existingId, lineIds);
      } else {
        const quantity = Number(form.get('quantity'));
        if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100000) {
          throw new Response('Invalid quantity.', {status: 400});
        }
        if (!dependencies.updateCartLines) throw new Error('shopify: update dependency missing');
        cart = await dependencies.updateCartLines(existingId, [{id: lineIds[0], quantity}]);
        if (lineIds.length > 1) {
          if (!dependencies.removeCartLines) throw new Error('shopify: remove dependency missing');
          cart = await dependencies.removeCartLines(existingId, lineIds.slice(1));
        }
      }
      return new Response(null, {status: 303, headers: {Location: '/cart', 'Cache-Control': 'no-store'}});
    }
    if (intent !== 'add') throw new Response('Invalid cart action.', {status: 400});
    const requested = requestedLines(form);
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
    let cart: CartSession;
    if (existingId) {
      if (!dependencies.getCart || !dependencies.addCartLines) throw new Error('shopify: cart session dependencies missing');
      const existing = await dependencies.getCart(existingId);
      if (!existing) {
        dependencies.unsetCartId?.();
        cart = await dependencies.createCart(lines);
        dependencies.setCartId?.(cart.id);
        return Response.json(cart, {headers: {'Cache-Control': 'no-store'}});
      }
      const additions: typeof lines = [];
      cart = existing;
      for (const line of lines) {
        const current = cart.lines.find((candidate) => candidate.merchandiseId === line.merchandiseId);
        const currentIds = current?.lineIds ?? (current?.id ? [current.id] : []);
        if (current && currentIds.length) {
          if (!dependencies.updateCartLines) throw new Error('shopify: update dependency missing');
          cart = await dependencies.updateCartLines(existingId, [{id: currentIds[0], quantity: current.quantity + line.quantity}]);
          if (currentIds.length > 1) {
            if (!dependencies.removeCartLines) throw new Error('shopify: remove dependency missing');
            cart = await dependencies.removeCartLines(existingId, currentIds.slice(1));
          }
        } else {
          additions.push(line);
        }
      }
      if (additions.length) cart = await dependencies.addCartLines(existingId, additions);
    } else {
      cart = await dependencies.createCart(lines);
      dependencies.setCartId?.(cart.id);
    }
    return Response.json(cart, {headers: {'Cache-Control': 'no-store'}});
  } catch (error) {
    if (error instanceof Response) throw error;
    dependencies.logError?.(error instanceof Error ? error.message : 'unknown error');
    throw new Response('Checkout temporarily unavailable.', {status: 503, headers: {'Retry-After': '60', 'Cache-Control': 'no-store'}});
  }
}

export async function handleShopifyCartLoader(env: CartEnv, dependencies: Pick<ShopifyCartDependencies, 'getCartId' | 'unsetCartId' | 'getCart' | 'logError'>): Promise<Response> {
  if (
    env.SHOPIFY_ADAPTER_PREVIEW !== '1' ||
    env.SHOPIFY_CHECKOUT_WRITE_ENABLED !== '1' ||
    env.SHOPIFY_SHIPPING_LATER_CONFIRMED !== '1' ||
    env.PUBLIC_COMING_SOON !== '0'
  ) {
    throw new Response('Checkout is closed.', {status: 404, headers: {'Cache-Control': 'no-store'}});
  }
  const id = dependencies.getCartId?.();
  if (!id) return Response.json(null, {headers: {'Cache-Control': 'no-store'}});
  try {
    if (!dependencies.getCart) throw new Error('shopify: cart dependency missing');
    const cart = await dependencies.getCart(id);
    if (!cart) {
      dependencies.unsetCartId?.();
      return Response.json(null, {headers: {'Cache-Control': 'no-store'}});
    }
    return Response.json(cart, {headers: {'Cache-Control': 'no-store'}});
  } catch (error) {
    dependencies.logError?.(error instanceof Error ? error.message : 'unknown error');
    throw new Response('Cart temporarily unavailable.', {status: 503, headers: {'Cache-Control': 'no-store'}});
  }
}
