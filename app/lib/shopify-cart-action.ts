import {bySku, type Catalog, type CatalogVariant} from './catalog.ts';
import {isPurchasableStatus, resolveStatus} from './product-content.ts';
import {requestedLines} from './shopify-cart-input.ts';
import {
  PREORDER_ATTRIBUTE,
  type CartLineInput,
  type CartLineUpdate,
  type ShopifyCart,
} from './shopify-storefront.ts';

export {PREORDER_ATTRIBUTE};

type CartEnv = Pick<
  Env,
  'SHOPIFY_CHECKOUT_WRITE_ENABLED' | 'PUBLIC_COMING_SOON'
>;
export type ShopifyCartDependencies = {
  fetchCatalog: () => Promise<Catalog>;
  createCart: (lines: CartLineInput[]) => Promise<ShopifyCart>;
  getCartId?: () => string | undefined;
  setCartId?: (id: string) => void;
  unsetCartId?: () => void;
  getCart?: (id: string) => Promise<ShopifyCart | null>;
  addCartLines?: (id: string, lines: CartLineInput[]) => Promise<ShopifyCart>;
  updateCartLines?: (id: string, lines: CartLineUpdate[]) => Promise<ShopifyCart>;
  removeCartLines?: (id: string, lineIds: string[]) => Promise<ShopifyCart>;
  logError?: (message: string) => void;
};

/** Most units of one SKU a cart may hold. */
const MAX_QUANTITY = 50;
const NO_STORE = {'Cache-Control': 'no-store'};

function fail(message: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(message, {status, headers: {...NO_STORE, ...headers}});
}

/** What the add-to-cart dialog and the header count need; no checkout URL. */
export type CartSummary = {
  totalQuantity: number;
  lines: Array<{
    sku: string | null;
    handle: string;
    title: string;
    variantTitle: string;
    quantity: number;
    image: {url: string; altText: string | null} | null;
    shipPromise: string | null;
  }>;
};

export function cartSummary(cart: ShopifyCart): CartSummary {
  return {
    totalQuantity: cart.totalQuantity,
    lines: cart.lines.map((line) => ({
      sku: line.sku,
      handle: line.handle,
      title: line.title,
      variantTitle: line.variantTitle,
      quantity: line.quantity,
      image: line.image,
      shipPromise: line.shipPromise,
    })),
  };
}

function redirect(location: string): Response {
  return new Response(null, {status: 303, headers: {Location: location, ...NO_STORE}});
}

/** Whether both commerce gates are open. */
export function checkoutOpen(env: CartEnv): boolean {
  return env.SHOPIFY_CHECKOUT_WRITE_ENABLED === '1' && env.PUBLIC_COMING_SOON === '0';
}

/**
 * The attributes a line of this variant carries: a preorder states its ship
 * promise, so checkout and the order confirmation show the delivery time the
 * product page showed. A preorder without a promise is not sold.
 */
function lineAttributes(variant: CatalogVariant): CartLineInput['attributes'] {
  if (variant.availability !== 'preorder') return undefined;
  const promise = variant.ship_promise?.trim();
  if (!promise) throw fail('Product is unavailable.', 409);
  return [{key: PREORDER_ATTRIBUTE, value: promise}];
}

/** The catalog variant behind a cart line, if the shop still sells it. */
function sellableVariant(
  catalog: Catalog,
  merchandiseId: string,
  globalComingSoon: boolean,
): CatalogVariant | null {
  for (const product of catalog.products) {
    const variant = product.variants.find((v) => v.merchandise_id === merchandiseId);
    if (!variant) continue;
    if (variant.availability === 'sold_out') return null;
    // The request-time catalog proves the SKU and stock state. The storefront
    // lifecycle remains an independent server-side release gate: a roadmap
    // concept never becomes orderable merely because a Shopify variant exists.
    const status = resolveStatus(product.handle, globalComingSoon);
    return isPurchasableStatus(status) ? variant : null;
  }
  return null;
}

/**
 * POST /api/shopify/cart. Intents:
 * - `add` (default): add SKUs to the session cart, then show /cart.
 * - `update`: set one line's quantity. `remove`: drop lines.
 * - `checkout`: re-check every line against the current catalog, refresh a
 *   preorder line whose ship promise changed, then hand off to Shopify.
 */
export async function handleShopifyCartAction(request: Request, env: CartEnv, dependencies: ShopifyCartDependencies): Promise<Response> {
  if (request.method !== 'POST') throw new Response('Method Not Allowed', {status: 405, headers: {Allow: 'POST'}});
  if (env.SHOPIFY_CHECKOUT_WRITE_ENABLED !== '1') {
    throw fail('Shopify checkout writes are not enabled.', 404);
  }
  // Same fail-closed rule as the UI helper: only an explicit 0 opens.
  const globalComingSoon = env.PUBLIC_COMING_SOON !== '0';
  if (globalComingSoon) throw fail('Checkout is closed.', 404);
  if (request.headers.get('Origin') !== new URL(request.url).origin) {
    throw fail('Forbidden', 403);
  }
  const contentType = request.headers.get('Content-Type') ?? '';
  if (!contentType.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
    throw fail('Invalid form body.', 400);
  }
  const contentLength = Number(request.headers.get('Content-Length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > 8192) {
    throw fail('Invalid form body.', 413);
  }
  let form: FormData;
  try { form = await request.formData(); } catch {
    throw fail('Invalid form body.', 400);
  }
  if (form.has('mode')) throw fail('Cart mode is not supported.', 400);
  const intent = String(form.get('intent') ?? 'add');
  // The button's background submit asks for the cart back instead of the
  // /cart page; a plain form post (no JavaScript) still lands on /cart.
  const wantsSummary = form.get('response') === 'summary';

  try {
    const existingId = dependencies.getCartId?.();

    if (intent === 'update' || intent === 'remove') {
      if (!existingId) throw fail('Cart is empty.', 409);
      const lineIds = form.getAll('lineId').map(String);
      if (!lineIds.length || lineIds.some((id) => !/^gid:\/\/shopify\/CartLine\/[A-Za-z0-9?=&_-]+$/.test(id))) {
        throw fail('Invalid cart line.', 400);
      }
      if (intent === 'remove') {
        if (!dependencies.removeCartLines) throw new Error('shopify: remove dependency missing');
        await dependencies.removeCartLines(existingId, lineIds);
      } else {
        const quantity = Number(form.get('quantity'));
        if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY || lineIds.length !== 1) {
          throw fail('Invalid quantity.', 400);
        }
        if (!dependencies.updateCartLines) throw new Error('shopify: update dependency missing');
        await dependencies.updateCartLines(existingId, [{id: lineIds[0], quantity}]);
      }
      return redirect('/cart');
    }

    if (intent === 'checkout') {
      if (!existingId || !dependencies.getCart) throw fail('Cart is empty.', 409);
      const [cart, catalog] = await Promise.all([
        dependencies.getCart(existingId),
        dependencies.fetchCatalog(),
      ]);
      if (!cart || !cart.lines.length) {
        dependencies.unsetCartId?.();
        return redirect('/cart');
      }
      const refresh: CartLineUpdate[] = [];
      for (const line of cart.lines) {
        const variant = sellableVariant(catalog, line.merchandiseId, globalComingSoon);
        if (!variant) throw fail('One or more cart items are no longer available.', 409);
        const attributes = lineAttributes(variant) ?? [];
        const promise = attributes[0]?.value ?? null;
        if (promise !== line.shipPromise) {
          refresh.push({id: line.id, quantity: line.quantity, attributes});
        }
      }
      let target = cart;
      if (refresh.length) {
        if (!dependencies.updateCartLines) throw new Error('shopify: update dependency missing');
        target = await dependencies.updateCartLines(existingId, refresh);
      }
      return redirect(target.checkoutUrl);
    }

    if (intent !== 'add') throw fail('Invalid cart action.', 400);
    const requested = requestedLines(form);
    const catalog = await dependencies.fetchCatalog();
    const lines: CartLineInput[] = requested.map(({sku, quantity}) => {
      const match = bySku(catalog, sku);
      const variant = match?.variant.merchandise_id
        ? sellableVariant(catalog, match.variant.merchandise_id, globalComingSoon)
        : null;
      if (!variant?.merchandise_id) throw fail('Product is unavailable.', 409);
      const attributes = lineAttributes(variant);
      return attributes
        ? {merchandiseId: variant.merchandise_id, quantity, attributes}
        : {merchandiseId: variant.merchandise_id, quantity};
    });

    if (existingId) {
      if (!dependencies.getCart || !dependencies.addCartLines) throw new Error('shopify: cart session dependencies missing');
      const existing = await dependencies.getCart(existingId);
      if (existing) {
        const quantities = new Map<string, number>();
        for (const line of existing.lines) {
          quantities.set(line.merchandiseId, (quantities.get(line.merchandiseId) ?? 0) + line.quantity);
        }
        for (const line of lines) {
          if ((quantities.get(line.merchandiseId) ?? 0) + line.quantity > MAX_QUANTITY) {
            throw fail('Cart quantity exceeds the limit.', 400);
          }
        }
        const updated = await dependencies.addCartLines(existingId, lines);
        return wantsSummary
          ? Response.json(cartSummary(updated), {headers: NO_STORE})
          : redirect('/cart');
      }
      // The session pointed at a cart Shopify no longer has: start a new one.
      dependencies.unsetCartId?.();
    }
    const cart = await dependencies.createCart(lines);
    dependencies.setCartId?.(cart.id);
    return wantsSummary
      ? Response.json(cartSummary(cart), {headers: NO_STORE})
      : redirect('/cart');
  } catch (error) {
    if (error instanceof Response) throw error;
    dependencies.logError?.(error instanceof Error ? error.message : 'unknown error');
    throw fail('Checkout temporarily unavailable.', 503, {'Retry-After': '60'});
  }
}

/**
 * The session cart for the /cart page, or null. Closed behind the same two
 * gates as the action, so an old session cookie never shows or reopens a
 * cart while the store is closed.
 */
export async function loadSessionCart(
  env: CartEnv,
  dependencies: Pick<ShopifyCartDependencies, 'getCartId' | 'unsetCartId' | 'getCart' | 'logError'>,
): Promise<ShopifyCart | null> {
  if (!checkoutOpen(env)) throw fail('Checkout is closed.', 410);
  const id = dependencies.getCartId?.();
  if (!id || !dependencies.getCart) return null;
  try {
    const cart = await dependencies.getCart(id);
    if (!cart) dependencies.unsetCartId?.();
    return cart;
  } catch (error) {
    dependencies.logError?.(error instanceof Error ? error.message : 'unknown error');
    throw fail('Cart temporarily unavailable.', 503, {'Retry-After': '60'});
  }
}

/**
 * GET /api/shopify/cart: the old checkout link lands on the cart page;
 * `?summary=1` returns the session cart summary for the header count.
 */
export async function handleShopifyCartLoader(
  request: Request,
  env: CartEnv,
  dependencies: Pick<ShopifyCartDependencies, 'getCartId' | 'unsetCartId' | 'getCart' | 'logError'> = {},
): Promise<Response> {
  if (!checkoutOpen(env)) throw fail('Checkout is closed.', 410);
  if (new URL(request.url).searchParams.get('summary') !== '1') return redirect('/cart');
  const cart = await loadSessionCart(env, dependencies);
  return Response.json(cart ? cartSummary(cart) : {totalQuantity: 0, lines: []}, {headers: NO_STORE});
}
