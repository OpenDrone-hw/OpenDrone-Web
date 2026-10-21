/**
 * The buy buttons and the header count in app mode (COMMERCE_SOURCE=app): `/api/shopify/cart` adds to the app
 * cart (the signed cookie of `app-api.ts`, priced by the app at /shop/cart) and never talks to Shopify.
 * The same form fields as the Shopify action are read (`sku` and `qty`, or `lines` as `sku:qty,...`), the same
 * summary comes back for the drawer and the header.
 */
import type {Catalog} from '../catalog.ts';
import type {CartSummary} from '../shopify-cart-action.ts';
import {campaignDate, shipLabelFromPromise} from '../preorder-campaign.ts';
import {type CartLine, cleanLines, readCart, writeCart, type AppEnv} from './app-api.ts';
import {cartAttributesFromForm} from '../growth/attribution.ts';
import {readOptions, writeOptions, cleanAttributes} from './app-cart-options.ts';
import {APP_CART_PATH} from './app-catalog.ts';

const NO_STORE = {'Cache-Control': 'no-store'};

function fail(message: string, status: number): Response {
  return new Response(message, {status, headers: NO_STORE});
}

/** The cart lines (by app variant id) a form asks to add: SKUs resolved through the catalog, unknown or sold-out
 *  SKUs refused. */
export function linesFromForm(form: FormData, catalog: Catalog): CartLine[] {
  const asked: Array<[string, number]> = [];
  const multi = String(form.get('lines') ?? '');
  if (multi) {
    for (const part of multi.split(',').slice(0, 20)) {
      const [sku, qty] = part.split(':');
      asked.push([sku?.trim() ?? '', Number(qty ?? 1)]);
    }
  } else {
    asked.push([String(form.get('sku') ?? '').trim(), Number(form.get('qty') ?? 1)]);
  }
  const out: CartLine[] = [];
  for (const [sku, qty] of asked) {
    if (!sku || !Number.isInteger(qty) || qty < 1 || qty > 50) throw fail('Invalid cart line.', 400);
    const variant = catalog.products.flatMap((p) => p.variants).find((v) => v.sku === sku);
    if (!variant?.merchandise_id) throw fail('Unknown product.', 404);
    if (variant.availability === 'sold_out') throw fail('This product is sold out.', 409);
    out.push({variant: variant.merchandise_id, qty});
  }
  return out;
}

/** What the drawer and the header need, from the cart cookie and the catalog (no price logic: the app quotes at
 *  /shop/cart; the subtotal here is the sum of the catalog's own prices). */
export function appCartSummary(lines: CartLine[], catalog: Catalog): CartSummary {
  const rows = lines.flatMap((line) => {
    for (const product of catalog.products) {
      const variant = product.variants.find((v) => v.merchandise_id === line.variant);
      if (variant) return [{product, variant, qty: line.qty}];
    }
    return [];
  });
  const cents = rows.reduce((sum, r) => sum + Math.round(r.variant.price * 100) * r.qty, 0);
  const money = (minor: number) => ({amount: (minor / 100).toFixed(2), currencyCode: catalog.currency});
  return {
    totalQuantity: rows.reduce((n, r) => n + r.qty, 0),
    subtotal: money(cents),
    lines: rows.map(({product, variant, qty}) => ({
      sku: variant.sku,
      handle: product.handle,
      title: product.title,
      variantTitle: variant.title,
      quantity: qty,
      image: variant.image ? {url: variant.image, altText: variant.image_alt ?? null} : null,
      shipPromise: variant.ship_promise,
      deliveryBy: variant.campaign?.deliveryByDay ? campaignDate(variant.campaign.deliveryByDay) : null,
      availability: null,
      shipLabel: shipLabelFromPromise(variant.ship_promise, 'short'),
      total: money(Math.round(variant.price * 100) * qty),
    })),
  };
}

/** POST /api/shopify/cart in app mode: add lines, answer the summary (background add) or land on the app cart. */
export async function handleAppCartAction(request: Request, env: AppEnv, catalog: Catalog): Promise<Response> {
  if (request.method !== 'POST') throw new Response('Method Not Allowed', {status: 405, headers: {Allow: 'POST'}});
  if (request.headers.get('Origin') !== new URL(request.url).origin) throw fail('Forbidden', 403);
  if (!(request.headers.get('Content-Type') ?? '').toLowerCase().startsWith('application/x-www-form-urlencoded')) {
    throw fail('Invalid form body.', 400);
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw fail('Invalid form body.', 400);
  }
  const intent = String(form.get('intent') ?? 'add');
  // The drawer's Checkout button: the app's cart page prices the cart and takes the order.
  if (intent === 'checkout') return new Response(null, {status: 303, headers: {Location: APP_CART_PATH, ...NO_STORE}});
  if (intent !== 'add') throw fail('This cart change is not supported here.', 400);
  const lines = cleanLines([...(await readCart(request, env)), ...linesFromForm(form, catalog)]);
  const headers = new Headers(NO_STORE);
  headers.append('Set-Cookie', await writeCart(lines, env));
  // First touch wins: the attribution the cart client sends is kept with the app cart (the options cookie) and goes
  // to the app with the checkout. The reply is ok only after it is stored, so the client's "sent" latch is true.
  const touch = cleanAttributes(Object.fromEntries(cartAttributesFromForm(form).map(({key, value}) => [key, value])));
  if (Object.keys(touch).length) {
    const options = await readOptions(request, env);
    headers.append('Set-Cookie', await writeOptions({...options, attributes: {...touch, ...options.attributes}}, env));
  }
  if (form.get('response') === 'summary') {
    headers.set('Content-Type', 'application/json');
    return new Response(JSON.stringify(appCartSummary(lines, catalog)), {headers});
  }
  headers.set('Location', APP_CART_PATH);
  return new Response(null, {status: 303, headers});
}

/** GET /api/shopify/cart in app mode: the summary for the header count, else the app cart page. */
export async function handleAppCartLoader(request: Request, env: AppEnv, catalog: () => Promise<Catalog>): Promise<Response> {
  if (new URL(request.url).searchParams.get('summary') !== '1') {
    return new Response(null, {status: 303, headers: {Location: APP_CART_PATH, ...NO_STORE}});
  }
  const lines = await readCart(request, env);
  if (!lines.length) return Response.json({totalQuantity: 0, lines: []}, {headers: NO_STORE});
  return Response.json(appCartSummary(lines, await catalog()), {headers: NO_STORE});
}
