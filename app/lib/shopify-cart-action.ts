import {bySku, type Catalog, type CatalogVariant} from './catalog.ts';
import {shipGroupKey} from './preorder-campaign.ts';
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
  /** Subtotal of every line, VAT included; absent on an empty summary. */
  subtotal?: {amount: string; currencyCode: string};
  lines: Array<{
    sku: string | null;
    handle: string;
    title: string;
    variantTitle: string;
    quantity: number;
    image: {url: string; altText: string | null} | null;
    shipPromise: string | null;
    /** Line total, VAT included. */
    total?: {amount: string; currencyCode: string};
  }>;
};

export function cartSummary(cart: ShopifyCart): CartSummary {
  return {
    totalQuantity: cart.totalQuantity,
    subtotal: {amount: cart.subtotal.amount, currencyCode: cart.subtotal.currencyCode},
    lines: cart.lines.map((line) => ({
      sku: line.sku,
      handle: line.handle,
      title: line.title,
      variantTitle: line.variantTitle,
      quantity: line.quantity,
      image: line.image,
      shipPromise: line.shipPromise,
      total: {amount: line.total.amount, currencyCode: line.total.currencyCode},
    })),
  };
}

/** What a buyer reads when an add would take one item past 50 units. */
export function lineLimitMessage(inCart: number): string {
  const room = Math.max(0, MAX_QUANTITY - inCart);
  return room === 0
    ? `One order holds at most ${MAX_QUANTITY} units of each item, and your cart already has ${inCart}. Check out this order first, then place a second one.`
    : `One order holds at most ${MAX_QUANTITY} units of each item. Your cart already has ${inCart}, so you can add ${room} more.`;
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

/** The catalog variant behind a merchandise id, whatever it sells as. */
function catalogVariant(catalog: Catalog, merchandiseId: string): CatalogVariant | null {
  for (const product of catalog.products) {
    const variant = product.variants.find((v) => v.merchandise_id === merchandiseId);
    if (variant) return variant;
  }
  return null;
}

/**
 * Units a cart may hold of a variant sold from a paid batch: the units left
 * in that batch. Null when the variant is not sold from paid stock.
 */
export function paidBatchLeft(variant: Pick<CatalogVariant, 'campaign'> | null | undefined): number | null {
  const campaign = variant?.campaign;
  if (!campaign?.paidStock) return null;
  return Math.max(0, campaign.paidLeft ?? campaign.batchUnits - campaign.batchOrdered);
}

/** What a buyer reads when a line asks for more than the paid batch holds. */
export function paidBatchMessage(left: number, shipPromise: string | null, inCart = 0): string {
  const promise = shipPromise?.trim() ? ` (${shipPromise.trim()})` : '';
  const base = left === 1
    ? `Only 1 unit is left in the paid batch${promise}. Order 1 at most; later units belong to the next batch, which is a funding target.`
    : `Only ${left} units are left in the paid batch${promise}. Order ${left} or fewer; later units belong to the next batch, which is a funding target.`;
  return inCart > 0 ? `${base} Your cart already has ${inCart}.` : base;
}

/** Refuse an add that takes a paid-batch variant past the units left,
 *  counting what the cart already holds and every line of this add. */
function checkPaidBatches(
  catalog: Catalog,
  lines: CartLineInput[],
  inCart: Map<string, number>,
): void {
  const wanted = new Map(inCart);
  for (const line of lines) {
    wanted.set(line.merchandiseId, (wanted.get(line.merchandiseId) ?? 0) + line.quantity);
  }
  for (const line of lines) {
    const variant = catalogVariant(catalog, line.merchandiseId);
    if (variant) {
      checkPaidBatch(variant, wanted.get(line.merchandiseId) ?? 0, inCart.get(line.merchandiseId) ?? 0);
    }
  }
}

/** Refuse a quantity of a paid-batch variant beyond the units left. */
function checkPaidBatch(variant: CatalogVariant, wanted: number, inCart = 0): void {
  const left = paidBatchLeft(variant);
  if (left !== null && wanted > left) {
    throw fail(paidBatchMessage(left, variant.ship_promise, inCart), 409);
  }
}

/**
 * The product page link for a cart line with its options selected, so a
 * click from the cart opens the size or model that is in the cart:
 * `/products/openfc-lite?Model=30%C3%9730`.
 */
export function variantLink(
  handle: string,
  selectedOptions: Array<{name: string; value: string}> = [],
): string {
  const options = selectedOptions.filter(
    ({name, value}) => !(name === 'Title' && value === 'Default Title'),
  );
  const query = new URLSearchParams(options.map(({name, value}) => [name, value])).toString();
  return `/products/${encodeURIComponent(handle)}${query ? `?${query}` : ''}`;
}

/** Where the checkout intent sends the buyer back to the cart, and why. */
export const CART_CHECK = {
  /** A paid-batch line asks for more units than the batch has left. */
  paidBatch: 'paid-batch',
  /** A preorder line's ship date changed since it was added. */
  shipDate: 'ship-date',
  /** Lines ship on different dates and the buyer has not seen the cart's
   *  notice (one parcel, the whole order waits for the last item). */
  mixedDates: 'mixed-dates',
} as const;

/** The form field the cart page sends with checkout once it has shown the
 *  mixed-dates notice. Checkout from anywhere else goes to /cart first. */
export const DATES_SEEN_FIELD = 'datesSeen';

/** True when the cart's lines do not all ship together. */
export function hasMixedShipDates(cart: ShopifyCart, info: Record<string, CartLineInfo>): boolean {
  return new Set(cart.lines.map((l) => info[l.id]?.group ?? `date:${l.shipPromise ?? ''}`)).size > 1;
}

/**
 * POST /api/shopify/cart. Intents:
 * - `add` (default): add SKUs to the session cart, then show /cart.
 * - `update`: set one line's quantity. `remove`: drop lines. A line that is
 *   no longer in the cart (a double click, a second tab) is a no-op for
 *   `remove` and a 409 for `update`, never an upstream failure.
 * - `checkout`: re-check every line against the current catalog. A line
 *   over its paid batch, or a preorder line whose ship promise changed (the
 *   line is refreshed first), goes back to /cart with a notice so the buyer
 *   sees the date before paying; otherwise hand off to Shopify.
 *
 * A variant sold from a paid batch (FC/ESC first run) can never be in the
 * cart in a larger quantity than the units left in that batch.
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
      const quantity = Number(form.get('quantity'));
      if (intent === 'update' && (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY || lineIds.length !== 1)) {
        throw fail('Invalid quantity.', 400);
      }
      if (!dependencies.getCart) throw new Error('shopify: cart session dependencies missing');
      const current = await dependencies.getCart(existingId);
      if (!current) {
        dependencies.unsetCartId?.();
        if (intent === 'remove') {
          return wantsSummary
            ? Response.json({totalQuantity: 0, lines: []} satisfies CartSummary, {headers: NO_STORE})
            : redirect('/cart');
        }
        throw fail('Cart is empty.', 409);
      }
      const present = new Set(current.lines.map((l) => l.id));
      let updated: ShopifyCart;
      if (intent === 'remove') {
        const ids = lineIds.filter((id) => present.has(id));
        // Already gone: nothing to do, show the cart as it is.
        if (!ids.length) {
          return wantsSummary
            ? Response.json(cartSummary(current), {headers: NO_STORE})
            : redirect('/cart');
        }
        if (!dependencies.removeCartLines) throw new Error('shopify: remove dependency missing');
        updated = await dependencies.removeCartLines(existingId, ids);
      } else {
        const target = current.lines.find((l) => l.id === lineIds[0]);
        if (!target) {
          if (!wantsSummary) return redirect('/cart');
          throw fail('This item is no longer in your cart.', 409);
        }
        if (quantity > target.quantity) {
          const catalog = await dependencies.fetchCatalog();
          const variant = catalogVariant(catalog, target.merchandiseId);
          if (variant) {
            const others = current.lines
              .filter((l) => l.merchandiseId === target.merchandiseId && l.id !== target.id)
              .reduce((n, l) => n + l.quantity, 0);
            checkPaidBatch(variant, quantity + others);
          }
        }
        if (!dependencies.updateCartLines) throw new Error('shopify: update dependency missing');
        updated = await dependencies.updateCartLines(existingId, [{id: target.id, quantity}]);
      }
      return wantsSummary
        ? Response.json(cartSummary(updated), {headers: NO_STORE})
        : redirect('/cart');
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
      const totals = new Map<string, {variant: CatalogVariant; quantity: number}>();
      for (const line of cart.lines) {
        const variant = sellableVariant(catalog, line.merchandiseId, globalComingSoon);
        if (!variant) throw fail('One or more cart items are no longer available.', 409);
        const total = totals.get(line.merchandiseId);
        totals.set(line.merchandiseId, {variant, quantity: (total?.quantity ?? 0) + line.quantity});
        const attributes = lineAttributes(variant) ?? [];
        const promise = attributes[0]?.value ?? null;
        if (promise !== line.shipPromise) {
          refresh.push({id: line.id, quantity: line.quantity, attributes});
        }
      }
      // More units than the paid batch has left: the extra units would carry
      // a ship date they cannot meet. Back to the cart, which says how many.
      for (const {variant, quantity} of totals.values()) {
        const left = paidBatchLeft(variant);
        if (left !== null && quantity > left) return redirect(`/cart?check=${CART_CHECK.paidBatch}`);
      }
      if (refresh.length) {
        if (!dependencies.updateCartLines) throw new Error('shopify: update dependency missing');
        await dependencies.updateCartLines(existingId, refresh);
        // The ship date moved since the line was added: show it before payment.
        return redirect(`/cart?check=${CART_CHECK.shipDate}`);
      }
      // Lines ship on different dates: the whole order waits for the last
      // one. Show the cart's notice and the option to order separately
      // before payment, unless the checkout came from that cart page.
      if (form.get(DATES_SEEN_FIELD) !== '1' && hasMixedShipDates(cart, cartLineInfo(cart, catalog))) {
        return redirect(`/cart?check=${CART_CHECK.mixedDates}`);
      }
      return redirect(cart.checkoutUrl);
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
          const inCart = quantities.get(line.merchandiseId) ?? 0;
          if (inCart + line.quantity > MAX_QUANTITY) {
            throw fail(lineLimitMessage(inCart), 400);
          }
        }
        checkPaidBatches(catalog, lines, quantities);
        const updated = await dependencies.addCartLines(existingId, lines);
        return wantsSummary
          ? Response.json(cartSummary(updated), {headers: NO_STORE})
          : redirect('/cart');
      }
      // The session pointed at a cart Shopify no longer has: start a new one.
      dependencies.unsetCartId?.();
    }
    checkPaidBatches(catalog, lines, new Map());
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

/** What the cart page knows about one line beyond Shopify's cart. */
export type CartLineInfo = {
  /** Lines with the same key ship together (see `shipGroupKey`). */
  group: string;
  /** Most units this line may hold: the paid-batch units left minus the
   *  same variant's other lines. Null when not sold from a paid batch. */
  maxQuantity: number | null;
  /** The funding target this line waits for, when it waits for one. */
  target: {units: number; ordered: number} | null;
};

/**
 * Per cart line: its ship group, its paid-batch limit and the target it
 * waits for, from the campaign-aware catalog. Without a catalog (it could
 * not be read) every line groups by its ship promise text and has no limit.
 */
export function cartLineInfo(
  cart: ShopifyCart,
  catalog: Catalog | null,
): Record<string, CartLineInfo> {
  const out: Record<string, CartLineInfo> = {};
  for (const line of cart.lines) {
    const variant = catalog ? catalogVariant(catalog, line.merchandiseId) : null;
    const campaign = variant?.campaign ?? null;
    // The line's own promise decides its date; the campaign says whether it
    // is a funding batch. A line added from paid stock keeps its date group
    // until checkout refreshes it.
    const group =
      campaign && line.shipPromise === campaign.shipPromise
        ? shipGroupKey(line.sku, line.shipPromise, campaign)
        : shipGroupKey(line.sku, line.shipPromise, null);
    const left = paidBatchLeft(variant);
    const others = cart.lines
      .filter((l) => l.merchandiseId === line.merchandiseId && l.id !== line.id)
      .reduce((n, l) => n + l.quantity, 0);
    out[line.id] = {
      group,
      maxQuantity: left === null ? null : Math.max(0, left - others),
      target:
        group.startsWith('target:') && campaign?.target != null
          ? {units: campaign.target, ordered: campaign.targetOrdered}
          : null,
    };
  }
  return out;
}

/**
 * How to split a cart whose lines ship on different dates: the lines to keep
 * for this order and the lines to order separately. Fixed-date lines (in
 * stock, paid stock) stay; everything waiting for a funding target goes.
 * Null when every line ships together, or when every line waits for a
 * funding target: none of them has a date to ship sooner on, so a second
 * order would only add a second shipping charge.
 */
export function splitPlan(
  cart: ShopifyCart,
  info: Record<string, CartLineInfo>,
): {keep: string[]; later: string[]} | null {
  const groups = new Map<string, string[]>();
  for (const line of cart.lines) {
    const key = info[line.id]?.group ?? `date:${line.shipPromise ?? ''}`;
    groups.set(key, [...(groups.get(key) ?? []), line.id]);
  }
  if (groups.size < 2) return null;
  const keepKeys = [...groups.keys()].filter((k) => k.startsWith('date:'));
  if (!keepKeys.length) return null;
  const keep = cart.lines.filter((l) => keepKeys.includes(info[l.id]?.group ?? `date:${l.shipPromise ?? ''}`)).map((l) => l.id);
  const later = cart.lines.map((l) => l.id).filter((id) => !keep.includes(id));
  return later.length && keep.length ? {keep, later} : null;
}
