import {bySku, catalogHasPreorders, preorderView, variantByMerchandise, type Catalog, type CatalogVariant} from './catalog.ts';
import {appCommerceEnabled} from './commerce/app-api.ts';
import {campaignDate, promiseBatchMonth, stockPromise, internationalRegion, isInternationalRegion, mixedShipPromise, regionOf, shipGroupKey, shipLabelFromPromise, shipOrderDay, type Region} from './preorder-campaign.ts';
import {isPurchasableStatus, resolveStatus} from './product-content.ts';
import {requestedLines} from './shopify-cart-input.ts';
import {destinationForRequest, geoCountryForRequest, isInternationalQuote, isIsoCountry, isUsQuote, shipCountryForRequest, shippingQuote, type ShippingQuote} from './shipping-rates.ts';
import {type RegistrationsFile} from './registrations.ts';
import {usSalesRate} from './us-sales.ts';
import {cartWholesaleCode, wholesaleCartPath, wholesaleCodes, wholesaleMainCode} from './wholesale-codes.ts';
import {cartAttributesFromForm, ORDER_ATTRIBUTE} from './growth/attribution.ts';
import {internationalShippingFrom} from './international-shipping.ts';
import {GEO_AVAILABILITY_COPY, hasBatchOne} from './geo-availability.ts';
import {
  BATCH_ATTRIBUTE,
  PREORDER_ATTRIBUTE,
  DELIVERY_BY_ATTRIBUTE,
  DELIVERY_BY_OWN_ATTRIBUTE,
  DUTIES_ATTRIBUTE,
  DUTIES_VALUE,
  PREORDER_OWN_ATTRIBUTE,
  SHIP_PROMISE_ATTRIBUTE,
  SHIP_REGION_ATTRIBUTE,
  SHIPPING_ATTRIBUTE,
  storefrontRequest,
  type CartLineInput,
  type CartLineUpdate,
  type ShopifyCart,
  type ShopifyCartLine,
} from './shopify-storefront.ts';

export {PREORDER_ATTRIBUTE};


type CartEnv = Pick<
  Env,
  'SHOPIFY_CHECKOUT_WRITE_ENABLED' | 'PUBLIC_COMING_SOON' | 'PUBLIC_US_SALES'
> & Partial<Pick<Env, 'SHOPIFY_STORE_DOMAIN' | 'SHOPIFY_ADMIN_API_TOKEN' | 'SHOPIFY_ADMIN_API_VERSION'>>;
export type ShopifyCartDependencies = {
  /** An explicit destination fixture for isolated tests; runtime uses committed approvals. */
  registrations?: RegistrationsFile;
  /** The open US rate for isolated tests; runtime reads `usSalesRate(env)`. */
  usRate?: number | null;
  /** `cartBuyerIdentityUpdate` with the country code, for a cart whose
   *  market no longer matches the destination (US sales open only). */
  setCountry?: (cartId: string, countryCode: string) => Promise<void>;
  /** The catalog for the destination's region (`US` while it is the open US
   *  destination, `INT` for another permitted non-EU destination): its ship promises and market prices. */
  fetchCatalog: (region?: Region, country?: string, exportStock?: boolean) => Promise<Catalog>;
  /** Remember (or forget, null) the retailer's applied main code in the
   *  session (`DEALER_SESSION_KEY`): the pages then show the wholesale offers. */
  setDealer?: (code: string | null) => void;
  /** A new cart; `countryCode` is the visitor's country when the shop
   *  ships there, so checkout opens in that country's market. */
  createCart: (lines: CartLineInput[], countryCode?: string) => Promise<ShopifyCart>;
  getCartId?: () => string | undefined;
  setCartId?: (id: string) => void;
  unsetCartId?: () => void;
  getCart?: (id: string) => Promise<ShopifyCart | null>;
  addCartLines?: (id: string, lines: CartLineInput[]) => Promise<ShopifyCart>;
  updateCartLines?: (id: string, lines: CartLineUpdate[]) => Promise<ShopifyCart>;
  removeCartLines?: (id: string, lineIds: string[]) => Promise<ShopifyCart>;
  /** `cartAttributesUpdate`: the first-touch attribution an add carries. */
  setAttributes?: (cartId: string, attributes: Array<{key: string; value: string}>) => Promise<void>;
  /** `cartDiscountCodesUpdate`: a retailer's personal code and its price groups. */
  setDiscountCodes?: (cartId: string, codes: string[]) => Promise<Array<{code: string; applicable: boolean}> | void>;
  logError?: (message: string) => void;
};

/** Most units of one SKU a cart may hold. */
const MAX_QUANTITY = 50;
const NO_STORE = {'Cache-Control': 'no-store'};

function fail(message: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(message, {status, headers: {...NO_STORE, ...headers}});
}

/** The country field a browser forwards with a cart form: the destination
 *  its page showed, including a `?country` override the POST cannot see.
 *  Only a valid ISO country code counts. */
export function forwardedCountry(form: FormData): string | null {
  const value = String(form.get(COUNTRY_FIELD) ?? '').trim().toUpperCase();
  return isIsoCountry(value) ? value : null;
}

/** The cart form field that carries the page's destination country. */
export const COUNTRY_FIELD = 'country';

/** Add `country` (the destination the page shows) to cart form fields, so
 *  the server builds the cart for that country and its market, `?country`
 *  override included. Unchanged without a country or when one is present. */
export function withCountry(
  fields: Array<[string, string]>,
  country: string | null | undefined,
): Array<[string, string]> {
  if (!country || fields.some(([name]) => name === 'country')) return fields;
  return [...fields, ['country', country]];
}

/** What the add-to-cart dialog and the header count need; no checkout URL. */
export type CartSummary = {
  totalQuantity: number;
  /** Subtotal of every line, VAT included; absent on an empty summary. */
  subtotal?: {amount: string; currencyCode: string};
  /** International destination only: the shipping charge Shopify checkout
   *  starts from for this cart, computed from Shopify's own rates
   *  (`international-shipping.ts`). Absent when it could not be computed. */
  shippingFrom?: {country: string; amount: string; currencyCode: string};
  lines: Array<{
    sku: string | null;
    handle: string;
    title: string;
    variantTitle: string;
    quantity: number;
    image: {url: string; altText: string | null} | null;
    shipPromise: string | null;
    deliveryBy?: string | null;
    /** "Batch 1 · EU only": the line's `Availability` property. */
    availability?: string | null;
    /** The short ship label for the line (`shipLabel` 'short'). */
    shipLabel: string | null;
    /** Line total, VAT included. */
    total?: {amount: string; currencyCode: string};
    /** The line's ship group (`CartLineInfo.group`), set when the summary
     *  was built with the campaign-aware catalog. Checkout groups the same
     *  way, so the drawer and checkout agree on a mixed order. */
    shipGroup?: string;
  }>;
};

/** The summary the drawer and the header read. With the catalog, every
 *  line carries the ship group checkout uses (see `hasMixedShipGroups`). */
export function cartSummary(cart: ShopifyCart, catalog: Catalog | null = null): CartSummary {
  const info = catalog ? cartLineInfo(cart, catalog) : null;
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
      deliveryBy: line.deliveryBy ?? null,
      availability: line.availability ?? null,
      shipLabel: shipLabelFromPromise(line.shipPromise, 'short'),
      total: {amount: line.total.amount, currencyCode: line.total.currencyCode},
      ...(info?.[line.id] ? {shipGroup: info[line.id].group} : {}),
    })),
  };
}

/** The summary with the international charge Shopify checkout starts from,
 *  for an international destination whose rate this cart can be priced at. */
async function withShippingFrom(
  summary: CartSummary,
  cart: ShopifyCart,
  destination: ShippingQuote | null,
  env: CartEnv,
): Promise<CartSummary> {
  if (!destination || !isInternationalQuote(destination)) return summary;
  const from = await internationalShippingFrom(env, destination.country, cart);
  return from ? {...summary, shippingFrom: {country: destination.country, ...from}} : summary;
}

/** The latest of the recorded English calendar deadlines, parsed in UTC. */
export function latestDeliveryBy(lines: readonly {deliveryBy?: string | null}[]): string | null {
  let latest: {date: string; time: number} | null = null;
  for (const line of lines) {
    const date = line.deliveryBy;
    if (!date || !/^\d{1,2} [A-Za-z]+ \d{4}$/.test(date)) continue;
    const time = Date.parse(`${date} 00:00:00 GMT`);
    if (Number.isFinite(time) && (!latest || time > latest.time)) latest = {date,time};
  }
  return latest?.date ?? null;
}

/** What a buyer reads when an add would take one item past 50 units. */
export function lineLimitMessage(inCart: number): string {
  const room = Math.max(0, MAX_QUANTITY - inCart);
  return room === 0
    ? `One order holds at most ${MAX_QUANTITY} units of each item, and your cart already has ${inCart}. Check out this order first, then place a second one.`
    : `One order holds at most ${MAX_QUANTITY} units of each item. Your cart already has ${inCart}, so you can add ${room} more.`;
}

/**
 * The buyer country a new cart starts with: the destination the buyer
 * picked (`od_ship_country` cookie), else the visitor's country
 * (Cloudflare's `CF-IPCountry`; `resolveCountry`), so Shopify checkout
 * opens in that market with its shipping rate and tax treatment. Undefined
 * when the country is unknown, blocked or sold only through shops: the cart
 * then starts in the shop's primary market and checkout still decides from
 * the shipping address.
 */
export function cartCountry(
  request: Request,
  registrations?: RegistrationsFile,
  usRate: number | null = null,
): string | undefined {
  return cartCountryFor(shipCountryForRequest(request), registrations, usRate);
}

/** `cartCountry` for a destination already resolved. */
export function cartCountryFor(
  country: string | null,
  registrations?: RegistrationsFile,
  usRate: number | null = null,
): string | undefined {
  const quote = shippingQuote(country, registrations, usRate);
  return quote?.kind === 'direct' ? quote.country : undefined;
}

/** What a buyer reads when an in-stock item is added for a US destination. */
export const US_EU_ONLY_MESSAGE =
  'This item ships from our stock in Belgium to EU addresses only, so it cannot be delivered to the United States. Preorder items ship to the US.';

/** What a buyer reads when the destination is not sold direct. */
export function destinationMessage(kind: ShippingQuote['kind'], _usOpen: boolean): string {
  if (kind === 'blocked') return 'This product is not available in your country.';
  if (kind === 'closed') return 'Orders are not open for your country yet.';
  return 'Consumer checkout is not available for this destination.';
}

export const CART_BUYER_IDENTITY_MUTATION = `#graphql
  mutation OpenDroneCartBuyerIdentity($cartId: ID!, $buyerIdentity: CartBuyerIdentityInput!) {
    cartBuyerIdentityUpdate(cartId: $cartId, buyerIdentity: $buyerIdentity) {
      cart { id }
      userErrors { field message }
    }
  }
`;

type CartCountrySteps = {
  create: (lines: CartLineInput[]) => Promise<ShopifyCart>;
  /** Set `buyerIdentity.countryCode` on the cart; throws on a user error. */
  setCountry: (cartId: string, countryCode: string) => Promise<void>;
  getCart: (cartId: string) => Promise<ShopifyCart | null>;
  logError?: (message: string) => void;
};

/**
 * Create a cart, then set its buyer country so checkout opens in that
 * country's market, and read it back with that market's prices. A country
 * Shopify refuses leaves the cart in the primary market (logged, not an
 * error): the buyer can still check out, and checkout re-prices from the
 * shipping address.
 */
export async function createCartInCountry(
  lines: CartLineInput[],
  countryCode: string | undefined,
  steps: CartCountrySteps,
): Promise<ShopifyCart> {
  const cart = await steps.create(lines);
  if (!countryCode) return cart;
  try {
    await steps.setCountry(cart.id, countryCode);
  } catch (error) {
    steps.logError?.(
      `cart country ${countryCode} not set: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
    return cart;
  }
  return (await steps.getCart(cart.id)) ?? cart;
}

/** `cartBuyerIdentityUpdate` with only the country code. */
export async function setCartCountry(
  env: Parameters<typeof storefrontRequest>[0],
  cartId: string,
  countryCode: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const data = await storefrontRequest<{
    cartBuyerIdentityUpdate: {cart: {id: string} | null; userErrors: Array<{message?: string}>};
  }>(env, CART_BUYER_IDENTITY_MUTATION, {cartId, buyerIdentity: {countryCode}}, fetcher);
  const payload = data.cartBuyerIdentityUpdate;
  if (!payload?.cart || payload.userErrors.length) {
    throw new Error('shopify: cartBuyerIdentityUpdate failed');
  }
}

function redirect(location: string): Response {
  return new Response(null, {status: 303, headers: {Location: location, ...NO_STORE}});
}

/** Whether both commerce gates are open. On the app (COMMERCE_SOURCE=app) the Shopify write flag is not a gate: the app
 *  checkout takes the orders, so the shop is open whenever the coming-soon flag is off, and the Shopify write flag can go off at
 *  the switch without closing the shop. */
export function checkoutOpen(env: CartEnv & Partial<Pick<Env, 'COMMERCE_SOURCE' | 'APP_API_URL'>>): boolean {
  if (appCommerceEnabled(env)) return env.PUBLIC_COMING_SOON === '0';
  return env.SHOPIFY_CHECKOUT_WRITE_ENABLED === '1' && env.PUBLIC_COMING_SOON === '0';
}

/** Whether pages render the open shop (buy buttons, availability bar, /cart). It is `checkoutOpen`, plus on the dev server
 *  only (`npm run dev:like-live`) `LOCAL_SHOP_PREVIEW=1` with the coming-soon flag off: the pages read as on opendrone.be
 *  while SHOPIFY_CHECKOUT_WRITE_ENABLED stays off, so the cart action still refuses every write. A build folds the DEV
 *  flag to false and drops the preview. */
export function shopShownOpen(env: CartEnv & Partial<Pick<Env, 'COMMERCE_SOURCE' | 'APP_API_URL' | 'LOCAL_SHOP_PREVIEW'>>): boolean {
  if (checkoutOpen(env)) return true;
  const dev = typeof import.meta.env !== 'undefined' && Boolean(import.meta.env.DEV);
  return dev && env.LOCAL_SHOP_PREVIEW === '1' && env.PUBLIC_COMING_SOON === '0';
}

/**
 * The attributes a line of this variant carries: a preorder states its ship
 * promise, so checkout and the order confirmation show the delivery time the
 * product page showed. A preorder without a promise is not sold.
 */
export function lineAttributes(variant: CatalogVariant, destination: Region | boolean = 'EU', euStockKnown = true): CartLineInput['attributes'] {
  if (variant.availability !== 'preorder') return undefined;
  const promise = variant.ship_promise?.trim();
  if (!promise) throw fail('Product is unavailable.', 409);
  // A non-EU line records its allocation region (hidden at checkout),
  // so the hold pass can flag an order shipped to another region.
  const region = typeof destination === 'boolean' ? destination ? 'US' : 'EU' : destination;
  const deliveryDay = variant.campaign?.deliveryByDay;
  // The batch the promise belongs to (hidden at checkout), so the hold pass
  // can flag a line paid at a batch boundary and allocated the next batch.
  const batch = variant.campaign ? `${variant.campaign.shipsWith ?? variant.sku}:${variant.campaign.batch}` : null;
  // An EU line from batch 1 stock in Belgium ships now: checkout and the
  // confirmation read the site's EU line, no preorder promise or delivery
  // date. The promise stays hidden for the cart and the hold pass. Only for
  // a known country (`euStockKnown`, `geoCountryForRequest`) while the batch
  // still carries a ship month: the site shows a visitor with none the batch
  // promise, so checkout does too. Stock on hand (`inStock`) is no preorder
  // for anyone: its line never carries a `Preorder` property.
  if (region === 'EU' && (euStockKnown || variant.campaign?.inStock) && euStock(variant)) {
    return [
      {key: SHIPPING_ATTRIBUTE, value: GEO_AVAILABILITY_COPY.en.eu},
      {key: SHIP_PROMISE_ATTRIBUTE, value: promise},
      ...(batch ? [{key: BATCH_ATTRIBUTE, value: batch}] : []),
    ];
  }
  return [
    {key: PREORDER_ATTRIBUTE, value: promise},
    ...(deliveryDay ? [{key: DELIVERY_BY_ATTRIBUTE, value: campaignDate(deliveryDay)}] : []),
    ...(region !== 'EU' ? [{key: SHIP_REGION_ATTRIBUTE, value: region}] : []),
    // UK, CH, NO (March batch): the buyer pays import VAT and duties on delivery (shown at checkout and on the order).
    ...(region === 'NEAR' ? [{key: DUTIES_ATTRIBUTE, value: DUTIES_VALUE}] : []),
    ...(batch ? [{key: BATCH_ATTRIBUTE, value: batch}] : []),
  ];
}

/** True for a variant whose next EU unit is paid batch 1 stock in Belgium. */
export function euStock(variant: Pick<CatalogVariant, 'campaign'>): boolean {
  return hasBatchOne(variant.campaign);
}

/** The ship promise a line's attributes carry: `Preorder`, or the hidden
 *  promise of an EU stock line. */
function promiseOf(attributes: NonNullable<CartLineInput['attributes']>): string | null {
  return attributes.find((a) => a.key === PREORDER_ATTRIBUTE)?.value
    ?? attributes.find((a) => a.key === SHIP_PROMISE_ATTRIBUTE)?.value
    ?? null;
}

/** A US destination buys a preorder with a campaign state: the catalog for
 *  a US buyer (`applyCampaign`, region US) gives every product that state,
 *  in-stock items included (`usStock`). What stays refused is Belgian stock
 *  a campaign could not place, and anything sold out. */
export function usSellable(variant: CatalogVariant): boolean {
  return variant.availability === 'preorder' && Boolean(variant.campaign);
}

/**
 * True when this line can only ship to an EU address: an in-stock item while
 * batch 1 stock is still sold as "Buy now" next to pre-orders. Once batch 2
 * has landed and nothing is pre-order (`catalogHasPreorders` false, the
 * ordinary shop), stock ships to every country Incutec ships to
 * (founder 2026-11-11).
 */
export function euOnlyStock(variant: CatalogVariant, catalog: Pick<Catalog, 'products'>): boolean {
  return !usSellable(variant) && catalogHasPreorders(catalog);
}

/** How many times an add is retried when Shopify dropped lines from it. */
const ADD_RETRIES = 2;

/** The part of `wanted` the cart does not hold: `before` is what the cart held
 *  of each variant ahead of the add. */
function shortfall(cart: ShopifyCart, wanted: CartLineInput[], before: Map<string, number>): CartLineInput[] {
  const have = new Map<string, number>();
  for (const line of cart.lines) have.set(line.merchandiseId, (have.get(line.merchandiseId) ?? 0) + line.quantity);
  const target = new Map(before);
  for (const line of wanted) target.set(line.merchandiseId, (target.get(line.merchandiseId) ?? 0) + line.quantity);
  const missing: CartLineInput[] = [];
  for (const [merchandiseId, quantity] of target) {
    const short = quantity - (have.get(merchandiseId) ?? 0);
    if (short <= 0) continue;
    const request = wanted.find((line) => line.merchandiseId === merchandiseId);
    if (request) missing.push({...request, quantity: Math.min(short, request.quantity)});
  }
  return missing;
}

/**
 * `cartLinesAdd` that proves the lines landed. Shopify does not serialise
 * mutations on one cart: parallel adds overwrite each other and a lost line
 * still answers success. Re-read the cart and add what is missing; a line
 * that still does not land fails the request, never a silent 200.
 */
async function addLinesVerified(
  cartId: string,
  lines: CartLineInput[],
  before: Map<string, number>,
  dependencies: ShopifyCartDependencies,
): Promise<ShopifyCart> {
  if (!dependencies.addCartLines || !dependencies.getCart) throw new Error('shopify: cart session dependencies missing');
  let cart = await dependencies.addCartLines(cartId, lines);
  for (let attempt = 0; ; attempt++) {
    if (!shortfall(cart, lines, before).length) return cart;
    const fresh = await dependencies.getCart(cartId);
    if (!fresh) throw new Error('shopify: cart unavailable after add');
    cart = fresh;
    const missing = shortfall(cart, lines, before);
    if (!missing.length) return cart;
    if (attempt >= ADD_RETRIES) throw new Error('shopify: cartLinesAdd lost lines');
    cart = await dependencies.addCartLines(cartId, missing);
  }
}

/** The catalog variant behind a cart line, if the shop still sells it. */
export function sellableVariant(
  catalog: Catalog,
  merchandiseId: string,
  globalComingSoon: boolean,
): CatalogVariant | null {
  const found = variantByMerchandise(catalog, merchandiseId);
  if (!found || found.variant.availability === 'sold_out') return null;
  // The request-time catalog proves the SKU and stock state. The storefront
  // lifecycle remains an independent server-side release gate: a roadmap
  // concept never becomes orderable merely because a Shopify variant exists.
  const status = resolveStatus(found.product.handle, globalComingSoon);
  return isPurchasableStatus(status) ? found.variant : null;
}

/** The catalog variant behind a merchandise id, whatever it sells as. */
function catalogVariant(catalog: Catalog, merchandiseId: string): CatalogVariant | null {
  return variantByMerchandise(catalog, merchandiseId)?.variant ?? null;
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
    ? `Only 1 unit is left in the paid batch${promise}. Order 1 at most; later units ship with the next batch.`
    : `Only ${left} units are left in the paid batch${promise}. Order ${left} or fewer; later units ship with the next batch.`;
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

/**
 * The mixed-order promise per cart line, keyed by line id. The whole order
 * ships once, on the latest date, so every line whose own campaign date is
 * earlier than the latest line's carries that line's ship-by and delivered-by
 * dates instead of its own. Empty when the cart's lines ship together, and
 * for a line without a campaign date (a plain in-stock line, or a preorder
 * the campaign does not date) since it cannot be ordered against the rest.
 */
function datedCartLines(cart: ShopifyCart, catalog: Catalog) {
  const dated: Array<{id: string; day: string; campaign: NonNullable<CatalogVariant['campaign']>}> = [];
  for (const line of cart.lines) {
    const variant = catalogVariant(catalog, line.merchandiseId);
    const day = shipOrderDay(variant?.campaign);
    if (variant?.campaign && day && variant.ship_promise) dated.push({id: line.id, day, campaign: variant.campaign});
  }
  return dated;
}

export function mixedPromises(cart: ShopifyCart, catalog: Catalog): Map<string, string> {
  const out = new Map<string, string>();
  if (!hasMixedShipDates(cart, cartLineInfo(cart, catalog))) return out;
  const dated = datedCartLines(cart, catalog);
  if (dated.length < 2) return out;
  const latest = dated.reduce((a, b) => (b.day > a.day ? b : a));
  const promise = mixedShipPromise(latest.campaign);
  if (!promise) return out;
  for (const {id, day} of dated) if (day < latest.day) out.set(id, promise);
  return out;
}

/** A line's attributes carrying the mixed-order promise: `Preorder` states
 *  it, and a hidden attribute keeps the line's own promise. */
function withOrderPromise(
  attributes: NonNullable<CartLineInput['attributes']>,
  orderPromise: string,
  orderDeliveryBy: string | null,
): NonNullable<CartLineInput['attributes']> {
  const own = promiseOf(attributes) ?? '';
  const ownDeliveryBy = attributes.find((a) => a.key === DELIVERY_BY_ATTRIBUTE)?.value;
  // An EU stock line in a parcel that waits for a later batch is a preorder
  // again: it states the order's promise, not "in stock".
  const stock = !attributes.some((a) => a.key === PREORDER_ATTRIBUTE);
  return [
    ...(stock ? [{key: PREORDER_ATTRIBUTE, value: orderPromise}] : []),
    ...attributes.filter(a => (!orderDeliveryBy || a.key !== DELIVERY_BY_ATTRIBUTE) && a.key !== SHIPPING_ATTRIBUTE).map((a) => (a.key === PREORDER_ATTRIBUTE ? {...a, value: orderPromise} : a)),
    ...(orderDeliveryBy ? [{key: DELIVERY_BY_ATTRIBUTE, value: orderDeliveryBy}] : []),
    ...(ownDeliveryBy ? [{key: DELIVERY_BY_OWN_ATTRIBUTE, value: ownDeliveryBy}] : []),
    {key: PREORDER_OWN_ATTRIBUTE, value: own},
  ];
}

/**
 * Every cart line against the catalog of the destination's region: the lines
 * whose `Preorder` promise (or hidden region attribute) no longer matches
 * that region (`refresh`), the units per variant, and whether the cart holds
 * a line the shop no longer sells or, for the US, a line that ships to the
 * EU only. Lines in either state are never rewritten. Throws a 409
 * `Response` for a preorder without a promise.
 *
 * `sync` is the separate, silent change: a line's `Preorder` attribute
 * moves to the mixed-order wording (see `mixedPromises`), or back to its own
 * promise once the cart no longer needs it. It never asks the buyer to look
 * again, since the cart page already showed the one-parcel notice.
 */
export function rederiveLines(
  cart: ShopifyCart,
  catalog: Catalog,
  destination: Region | boolean,
  globalComingSoon: boolean,
  euStockKnown = true,
): {
  refresh: CartLineUpdate[];
  sync: CartLineUpdate[];
  totals: Map<string, {variant: CatalogVariant; quantity: number}>;
  unavailable: boolean;
  euOnly: boolean;
} {
  const refresh: CartLineUpdate[] = [];
  const region = typeof destination === 'boolean' ? destination ? 'US' : 'EU' : destination;
  const sync: CartLineUpdate[] = [];
  const totals = new Map<string, {variant: CatalogVariant; quantity: number}>();
  let unavailable = false;
  let euOnly = false;
  const mixed = mixedPromises(cart, catalog);
  const dated = mixed.size ? datedCartLines(cart, catalog) : [];
  const latest = dated.length ? dated.reduce((a,b)=>b.day > a.day ? b : a) : null;
  const orderDeliveryBy = latest?.campaign.deliveryByDay ? campaignDate(latest.campaign.deliveryByDay) : null;
  for (const line of cart.lines) {
    const variant = sellableVariant(catalog, line.merchandiseId, globalComingSoon);
    if (!variant) {
      unavailable = true;
      continue;
    }
    if (region !== 'EU' && euOnlyStock(variant, catalog)) {
      euOnly = true;
      continue;
    }
    const total = totals.get(line.merchandiseId);
    totals.set(line.merchandiseId, {variant, quantity: (total?.quantity ?? 0) + line.quantity});
    const attributes = lineAttributes(variant, region, euStockKnown) ?? [];
    const promise = promiseOf(attributes);
    const attributeRegion = attributes.find((a) => a.key === SHIP_REGION_ATTRIBUTE)?.value ?? null;
    const deliveryBy = attributes.find((a) => a.key === DELIVERY_BY_ATTRIBUTE)?.value ?? null;
    const batch = attributes.find((a) => a.key === BATCH_ATTRIBUTE)?.value ?? null;
    // An EU stock line drops its `Delivery by` but keeps its promise: moving
    // a line to that form is silent (`sync`), not a changed ship date.
    const euStockForm = attributes.some((a) => a.key === SHIPPING_ATTRIBUTE);
    if (promise !== line.shipPromise || attributeRegion !== (line.shipRegion ?? null) || (!euStockForm && deliveryBy !== (line.deliveryBy ?? null))) {
      refresh.push({id: line.id, quantity: line.quantity, attributes});
      continue;
    }
    const wanted = mixed.get(line.id) ?? null;
    // A line added while checkout still showed a batch name carries the old
    // `Availability` property: drop it silently. So is a hidden `_batch`
    // that names another batch under the same promise (a line without one
    // keeps none: the hold pass then reads its promise text).
    const wantedDeliveryBy = wanted && orderDeliveryBy !== deliveryBy ? orderDeliveryBy : null;
    if (euStockForm !== Boolean(line.euStock) || wanted !== (line.orderPromise ?? null) || wantedDeliveryBy !== (line.orderDeliveryBy ?? null) || line.availability != null || (line.batch != null && batch !== line.batch)) {
      sync.push({
        id: line.id,
        quantity: line.quantity,
        attributes: wanted ? withOrderPromise(attributes, wanted, orderDeliveryBy) : attributes,
      });
    }
  }
  return {refresh, sync, totals, unavailable, euOnly};
}

/** The allocation region of a consumer destination. */
export function regionForDestination(destination: ShippingQuote | null): Region {
  return isUsQuote(destination) ? 'US' : isInternationalQuote(destination) ? internationalRegion(destination?.country) : 'EU';
}

/** Where the checkout intent sends the buyer back to the cart, and why. */
export const CART_CHECK = {
  /** The typed wholesale code is not a wholesale code. */
  code: 'code',
  /** Shopify did not take the wholesale code (unknown, inactive, or no line it covers). */
  codeNotApplied: 'code-not-applied',
  /** Shopify could not be reached to apply the wholesale code. */
  codeFailed: 'code-failed',
  /** A paid-batch line asks for more units than the batch has left. */
  paidBatch: 'paid-batch',
  /** A preorder line's ship date changed since it was added. */
  shipDate: 'ship-date',
  /** The cart's prices changed (another market or a new price step). */
  price: 'price',
  /** Both the prices and a ship date changed. */
  priceAndDate: 'price-and-date',
  /** Lines ship on different dates and the buyer has not seen the cart's
   *  notice (one parcel, the whole order waits for the last item). */
  mixedDates: 'mixed-dates',
  /** A board bought as "Buy now" shares the cart with a March item: the
   *  cart takes pre-orders only, so this is a cart built outside the site;
   *  checkout is refused until the in-stock board is removed. */
  batchChoice: 'batch-choice',
  /** A US destination with a line that ships to the EU only. */
  usEuOnly: 'us-eu-only',
  /** The cart was priced for another market than the destination; it was
   *  moved to the destination's market and its prices changed. */
  market: 'market',
} as const;

/** The add field naming the offer of a board: `preorder` or `buy_now` (the default). */
export const OFFER_FIELD = 'offer';
/** Why an add of an in-stock board is refused. */
export const BUY_NOW_NOT_IN_CART = 'In-stock boards are bought now from their product page and do not go in the cart.';
/**
 * True when a board bought as "Buy now" (retail, batch 1 stock) shares the
 * cart with a line of the March batch. The cart takes pre-orders only, so
 * only a cart built outside the site gets here; checkout refuses it, because
 * such an order would ship whole in March and nobody pays retail for that.
 */
export function batchChoiceConflict(
  cart: Pick<ShopifyCart, 'lines'>,
  info: Record<string, Pick<CartLineInfo, 'group'>>,
): boolean {
  if (!cart.lines.some((line) => line.offer === 'buy_now')) return false;
  return cart.lines.some((line) => !(info[line.id]?.group ?? `date:${line.shipPromise ?? ''}`).startsWith('date:'));
}

/**
 * The express purchase of in-stock boards (the "Buy now" lane): a Shopify
 * cart of its own, made for this one checkout and never stored as the
 * session cart, so nothing else can join that order and the session cart
 * holds pre-orders only.
 */
export const EXPRESS_INTENT = 'buy-now';
/** The query parameter an express purchase that cannot go ahead returns with. */
export const EXPRESS_PARAM = 'buy';
/** Why an express purchase was refused: no EU destination, or not enough stock left. */
export const EXPRESS_REFUSED = {region: 'eu-only', stock: 'sold-out'} as const;
export type ExpressRefusal = (typeof EXPRESS_REFUSED)[keyof typeof EXPRESS_REFUSED];

/**
 * A cart from before the two lanes may hold a Buy now (in-stock) board. The
 * cart is the pre-order lane, so each such line moves to the Pre-order
 * variant of the same board, same quantity, instead of asking the buyer to
 * remove it by hand. Lines whose board has no pre-order variant in this
 * catalog are left alone.
 */
export function buyNowToPreorder(cart: Pick<ShopifyCart, 'lines'>, catalog: Catalog): CartLineUpdate[] {
  const moves: CartLineUpdate[] = [];
  // An ordinary shop (nothing is pre-order): in-stock lines stay as they are.
  if (!catalogHasPreorders(catalog)) return moves;
  for (const line of cart.lines) {
    if (line.offer !== 'buy_now') continue;
    const variant = bySku(catalog, line.sku)?.variant;
    if (!variant) continue;
    const target = variant.offer === 'buy_now' ? variant.preorder_offer?.merchandise_id : variant.merchandise_id;
    if (target && target !== line.merchandiseId) moves.push({id: line.id, quantity: line.quantity, merchandiseId: target});
  }
  return moves;
}

/** True when this catalog sells in-stock boards to its buyer (the EU while batch 1 lasts). */
export function sellsBuyNow(catalog: Catalog): boolean {
  return catalog.products.some((product) => product.variants.some((variant) => variant.offer === 'buy_now'));
}

/**
 * Lines Shopify did not price in the destination's currency after the cart
 * moved there: an item not sold in that market. The cart names them at the
 * top instead of showing two currencies.
 */
export function cartCurrencyMisses(cart: Pick<ShopifyCart, 'lines'>, currency: string): ShopifyCartLine[] {
  return cart.lines.filter((line) => line.total.currencyCode !== currency);
}

/**
 * A board bought now is a board whose primary offer is Buy now (EU, batch 1
 * units left, Shopify not denying it). Bought with a March item it would ship
 * in March, and nobody pays retail for that: the cart never takes it.
 */
export function isBuyNowOnly(variant: Pick<CatalogVariant, 'offer'>): boolean {
  return variant.offer === 'buy_now';
}

/**
 * The lines of an express purchase, or why it cannot go ahead. Only Buy now
 * boards, only to the EU, and never more units than batch 1 still holds:
 * the offer fails cleanly instead of overselling when the stock ran out
 * between page load and purchase.
 */
export function expressLines(
  catalog: Catalog,
  requested: ReadonlyArray<{sku: string; quantity: number}>,
  region: Region,
  globalComingSoon: boolean,
  euStockKnown = true,
  /** A verified wholesale export (`exportWholesaleCodes`): outside the EU allowed. */
  dealer = false,
): {lines: CartLineInput[]} | {refused: ExpressRefusal} {
  if (region !== 'EU' && !(dealer && isInternationalRegion(region))) return {refused: EXPRESS_REFUSED.region};
  const lines: CartLineInput[] = [];
  for (const {sku, quantity} of requested) {
    const match = bySku(catalog, sku)?.variant;
    const variant = match?.merchandise_id ? sellableVariant(catalog, match.merchandise_id, globalComingSoon) : null;
    if (!variant?.merchandise_id || !isBuyNowOnly(variant)) return {refused: EXPRESS_REFUSED.stock};
    const left = paidBatchLeft(variant);
    if (left === null || quantity > left) return {refused: EXPRESS_REFUSED.stock};
    const attributes = lineAttributes(variant, dealer ? region : 'EU', euStockKnown);
    lines.push(attributes ? {merchandiseId: variant.merchandise_id, quantity, attributes} : {merchandiseId: variant.merchandise_id, quantity});
  }
  return lines.length ? {lines} : {refused: EXPRESS_REFUSED.stock};
}

/**
 * The wholesale codes of a retailer buying stock for outside the EU, or null
 * for anyone else: the session cart must carry a wholesale main code that
 * Shopify applies. The US is left out (its stock goes through the US partner).
 */
export async function exportWholesaleCodes(
  region: Region,
  cartId: string | undefined,
  dependencies: Pick<ShopifyCartDependencies, 'getCart' | 'setDiscountCodes'>,
): Promise<string[] | null> {
  if (!isInternationalRegion(region) || !cartId || !dependencies.getCart || !dependencies.setDiscountCodes) return null;
  const cart = await dependencies.getCart(cartId);
  const code = cartWholesaleCode(cart?.discountCodes);
  return code?.applicable ? wholesaleCodes(code.code.toUpperCase()) : null;
}

/** The page an express purchase returns to: a same-site path, else home. */
export function expressReturn(form: FormData, refused: ExpressRefusal): string {
  const raw = String(form.get('return') ?? '/');
  const path = raw.startsWith('/') && !raw.startsWith('//') && !raw.includes('\\') ? raw : '/';
  const url = new URL(path, 'https://opendrone.invalid');
  url.searchParams.set(EXPRESS_PARAM, refused);
  return `${url.pathname}${url.search}`;
}

/** The form field the cart page sends with checkout once it has shown the
 *  mixed-dates notice. Checkout from anywhere else goes to /cart first. */
export const DATES_SEEN_FIELD = 'datesSeen';

/** A line's ship group: the campaign-aware group when known, else its
 *  promise text. */
export function lineShipGroup(line: {shipPromise: string | null; shipGroup?: string | null}): string {
  return line.shipGroup ?? `date:${line.shipPromise ?? ''}`;
}

/**
 * True when the lines do not all ship together. The one rule for a mixed
 * order: checkout, the cart page and the added-to-cart drawer all use it.
 * Two lines waiting for different funding targets are mixed even when their
 * promise text reads the same.
 */
export function hasMixedShipGroups(lines: ReadonlyArray<{shipPromise: string | null; shipGroup?: string | null}>): boolean {
  return new Set(lines.map(lineShipGroup)).size > 1;
}

/** True when the cart's lines do not all ship together. */
export function hasMixedShipDates(cart: ShopifyCart, info: Record<string, CartLineInfo>): boolean {
  return hasMixedShipGroups(cart.lines.map((l) => ({shipPromise: l.shipPromise, shipGroup: info[l.id]?.group})));
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
  const usRate = dependencies.usRate !== undefined ? dependencies.usRate : usSalesRate(env);
  // The country the page showed: the one the browser forwards (it resolves
  // `?country`, the picked destination and the IP), else the request's own.
  const destination = shippingQuote(
    destinationForRequest(request, forwardedCountry(form)),
    dependencies.registrations,
    usRate,
  );
  const us = isUsQuote(destination);
  const region = regionForDestination(destination);
  // EU stock wording only where the site shows it: the same country source
  // as the root loader's `geo` (no `Accept-Language` guess).
  const euStockKnown = geoCountryForRequest(request) != null;

  try {
    const existingId = dependencies.getCartId?.();

    if (intent === 'discount') {
      // A retailer's personal code (README "Trade"): the main code goes in
      // with its price-group companions; an empty field clears the codes.
      if (!existingId || !dependencies.setDiscountCodes) throw fail('Cart is empty.', 409);
      const typed = String(form.get('code') ?? '');
      const main = wholesaleMainCode(typed);
      if (typed.trim() && !main) return redirect(wholesaleCartPath(CART_CHECK.code));
      // A failed apply returns to the cart with a notice, never the 503 page.
      let applied: Array<{code: string; applicable: boolean}> | void;
      try {
        applied = await dependencies.setDiscountCodes(existingId, main ? wholesaleCodes(main) : []);
      } catch (error) {
        dependencies.logError?.(`wholesale code not applied: ${error instanceof Error ? error.message : 'unknown error'}`);
        return redirect(wholesaleCartPath(CART_CHECK.codeFailed));
      }
      if (main && applied && !applied.some((c) => c.code.toUpperCase() === main && c.applicable)) {
        return redirect(wholesaleCartPath(CART_CHECK.codeNotApplied));
      }
      // Applied or cleared: the field shows with the applied code, or not at all.
      dependencies.setDealer?.(main);
      return redirect(main ? '/cart' : wholesaleCartPath());
    }

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
          const catalog = await dependencies.fetchCatalog(region, destination?.country);
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

    if (intent === EXPRESS_INTENT) {
      // Buy now: straight to a checkout that holds these in-stock lines only.
      if (!destination || destination.kind !== 'direct') {
        return redirect(expressReturn(form, EXPRESS_REFUSED.region));
      }
      // Consumers: EU addresses only. A retailer outside the EU (and the US)
      // whose session cart carries an applied wholesale code buys from the
      // same stock, shipped by courier (founder 2026-11-11).
      const dealerCodes = region === 'EU' ? null : await exportWholesaleCodes(region, existingId, dependencies);
      if (region !== 'EU' && !dealerCodes) return redirect(expressReturn(form, EXPRESS_REFUSED.region));
      const requested = requestedLines(form);
      const catalog = await dependencies.fetchCatalog(region, destination.country, Boolean(dealerCodes));
      const plan = expressLines(catalog, requested, region, globalComingSoon, euStockKnown, Boolean(dealerCodes));
      if ('refused' in plan) return redirect(expressReturn(form, plan.refused));
      const express = await dependencies.createCart(plan.lines, cartCountryFor(destination.country, dependencies.registrations, usRate));
      // The retailer's price: the same codes on the express cart.
      if (dealerCodes) await dependencies.setDiscountCodes!(express.id, dealerCodes);
      // Shopify's own deny gate: a line it could not fill comes back short.
      if (shortfall(express, plan.lines, new Map()).length) return redirect(expressReturn(form, EXPRESS_REFUSED.stock));
      await recordAttribution(form, express, dependencies);
      return redirect(express.checkoutUrl);
    }

    if (intent === 'checkout') {
      if (!destination || destination.kind !== 'direct') {
        throw fail(
          'Choose an available delivery country before checkout.',
          403,
        );
      }
      if (!existingId || !dependencies.getCart) throw fail('Cart is empty.', 409);
      const [cart, catalog] = await Promise.all([
        dependencies.getCart(existingId),
        dependencies.fetchCatalog(region, destination.country),
      ]);
      if (!cart || !cart.lines.length) {
        dependencies.unsetCartId?.();
        return redirect('/cart');
      }
      // Every line's promise and region attribute are derived again for the
      // destination region, whatever the cart was built for.
      const {refresh, sync, totals, unavailable, euOnly} = rederiveLines(cart, catalog, region, globalComingSoon, euStockKnown);
      if (unavailable) throw fail('One or more cart items are no longer available.', 409);
      if (region !== 'EU' && euOnly) return redirect(`/cart?check=${CART_CHECK.usEuOnly}`);
      // A cart whose buyer country is not the destination (built for
      // another country, or the buyer changed country since) moves to the
      // destination first. A move involving a non-EU country shows its
      // prices and ship dates in the cart before payment, even when both
      // countries use the same currency.
      if (dependencies.setCountry) {
        const usd = cart.subtotal.currencyCode === 'USD';
        const cartUs = cart.country ? cart.country === 'US' : usd;
        // A cart with no buyer country gets the destination too, so Shopify
        // checkout opens with the ship-to country the buyer picked.
        const countryDiffers = cart.country !== destination.country;
        const marketDiffers = (usRate != null && (usd !== us || cartUs !== us)) ||
          (countryDiffers && (region !== 'EU' || regionOf(cart.country) !== 'EU'));
        if (marketDiffers || countryDiffers) {
          await dependencies.setCountry(existingId, destination.country);
          if (marketDiffers) {
            if (refresh.length) {
              if (!dependencies.updateCartLines) throw new Error('shopify: update dependency missing');
              await dependencies.updateCartLines(existingId, refresh);
            }
            return redirect(`/cart?check=${CART_CHECK.market}`);
          }
        }
      }
      // More units than the paid batch has left: the extra units would carry
      // a ship date they cannot meet. Back to the cart, which says how many.
      // A cart with a line outside paid stock ships whole in March and takes
      // no paid-batch units (founder 2026-11-01), so the cap applies only to
      // a cart whose every line ships with paid stock. The add and cart
      // limits stay: the buyer may split the cart into a paid-stock order.
      const takesPaid = [...totals.values()].every(({variant}) => Boolean(variant.campaign?.paidStock));
      for (const {variant, quantity} of takesPaid ? totals.values() : []) {
        const left = paidBatchLeft(variant);
        if (left !== null && quantity > left) return redirect(`/cart?check=${CART_CHECK.paidBatch}`);
      }
      if (refresh.length) {
        if (!dependencies.updateCartLines) throw new Error('shopify: update dependency missing');
        await dependencies.updateCartLines(existingId, refresh);
        // The ship date moved since the line was added: show it before payment.
        return redirect(`/cart?check=${CART_CHECK.shipDate}`);
      }
      // A board bought at the retail price ships now. With a March item in
      // the cart the order would ship whole in March, so nobody checks out
      // that way: the cart asks for one of its two actions first, whatever
      // page the checkout came from.
      if (batchChoiceConflict(cart, cartLineInfo(cart, catalog))) {
        return redirect(`/cart?check=${CART_CHECK.batchChoice}`);
      }
      // Lines ship on different dates: the whole order waits for the last
      // one. Show the cart's notice and the option to order separately
      // before payment, unless the checkout came from that cart page.
      if (form.get(DATES_SEEN_FIELD) !== '1' && hasMixedShipDates(cart, cartLineInfo(cart, catalog))) {
        return redirect(`/cart?check=${CART_CHECK.mixedDates}`);
      }
      // The order ships once, on its latest date: a line with an earlier
      // date of its own says so on the order, and goes back to its own date
      // when the cart is no longer mixed. Written only here, after the buyer
      // has seen the one-parcel notice, so the cart page keeps showing each
      // line's own date.
      if (sync.length) {
        if (!dependencies.updateCartLines) throw new Error('shopify: update dependency missing');
        await dependencies.updateCartLines(existingId, sync);
      }
      return redirect(cart.checkoutUrl);
    }

    if (intent !== 'add') throw fail('Invalid cart action.', 400);
    // Add and checkout use the same destination gate. An unknown country
    // adds in the default market; checkout requires an available destination.
    if (destination && destination.kind !== 'direct') {
      throw fail(destinationMessage(destination.kind, true), 403);
    }
    const requested = requestedLines(form);
    // The cart holds pre-orders only: a board in stock is bought now through
    // its own express checkout (EXPRESS_INTENT), never added here.
    const offer = form.get(OFFER_FIELD);
    if (offer !== null && offer !== 'preorder') throw fail('Invalid cart offer.', 400);
    const catalog = await dependencies.fetchCatalog(region, destination?.country);
    const lines: CartLineInput[] = requested.map(({sku, quantity}) => {
      const match = bySku(catalog, sku);
      const primary = match?.variant.merchandise_id
        ? sellableVariant(catalog, match.variant.merchandise_id, globalComingSoon)
        : null;
      if (!primary?.merchandise_id) throw fail('Product is unavailable.', 409);
      // A board with both offers goes in as its pre-order; every other
      // product has one offer and takes it either way.
      const variant = preorderView(primary) ?? primary;
      if (!variant.merchandise_id) throw fail('Product is unavailable.', 409);
      // Only while pre-orders exist is the cart the pre-order lane.
      if (isBuyNowOnly(variant) && catalogHasPreorders(catalog)) throw fail(BUY_NOW_NOT_IN_CART, 409);
      if (region !== 'EU' && euOnlyStock(variant, catalog)) throw fail(region === 'US' ? US_EU_ONLY_MESSAGE : 'This item ships from stock in Belgium to EU addresses only. International orders use the preorder batch.', 409);
      const attributes = lineAttributes(variant, region, euStockKnown);
      return attributes
        ? {merchandiseId: variant.merchandise_id, quantity, attributes}
        : {merchandiseId: variant.merchandise_id, quantity};
    });

    if (existingId) {
      if (!dependencies.getCart || !dependencies.addCartLines) throw new Error('shopify: cart session dependencies missing');
      let existing = await dependencies.getCart(existingId);
      if (existing) {
        // A product link can change the destination before another item is
        // added. Reprice the session cart and refresh its earlier promises,
        // so the drawer shows the selected country's totals and batch.
        if (destination?.kind === 'direct' && dependencies.setCountry &&
          existing.country !== destination.country && (existing.country != null || isInternationalRegion(region))) {
          await dependencies.setCountry(existingId, destination.country);
          const {refresh} = rederiveLines(existing, catalog, region, globalComingSoon, euStockKnown);
          if (refresh.length) {
            if (!dependencies.updateCartLines) throw new Error('shopify: update dependency missing');
            await dependencies.updateCartLines(existingId, refresh);
          }
          existing = await dependencies.getCart(existingId);
          if (!existing) throw new Error('shopify: cart unavailable after destination change');
        }
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
        const updated = await addLinesVerified(existingId, lines, quantities, dependencies);
        await recordAttribution(form, updated, dependencies);
        return wantsSummary
          ? Response.json(await withShippingFrom(cartSummary(updated, catalog), updated, destination, env), {headers: NO_STORE})
          : redirect('/cart');
      }
      // The session pointed at a cart Shopify no longer has: start a new one.
      dependencies.unsetCartId?.();
    }
    checkPaidBatches(catalog, lines, new Map());
    const cart = await dependencies.createCart(lines, cartCountryFor(destination?.country ?? null, dependencies.registrations, usRate));
    dependencies.setCartId?.(cart.id);
    await recordAttribution(form, cart, dependencies);
    return wantsSummary
      ? Response.json(await withShippingFrom(cartSummary(cart, catalog), cart, destination, env), {headers: NO_STORE})
      : redirect('/cart');
  } catch (error) {
    if (error instanceof Response) throw error;
    dependencies.logError?.(error instanceof Error ? error.message : 'unknown error');
    throw fail('Checkout temporarily unavailable.', 503, {'Retry-After': '60'});
  }
}

/**
 * Write the first-touch attribution an add carries (`attr_*` fields, see
 * app/lib/growth/attribution.ts) as cart attributes, so the order names
 * its source. Best effort: a failure is logged and the add still
 * succeeds.
 */
async function recordAttribution(form: FormData, cart: ShopifyCart, dependencies: ShopifyCartDependencies): Promise<void> {
  const attributes = cartAttributesFromForm(form);
  if (!attributes.length || !dependencies.setAttributes) return;
  // First touch wins across sessions too: the update replaces the cart's attributes, so a cart that already
  // carries a touch (a returning buyer's later session, now always captured, direct included) keeps it.
  const touched = new Set<string>(Object.values(ORDER_ATTRIBUTE));
  if (cart.attributes?.some(({key}) => touched.has(key))) return;
  try {
    await dependencies.setAttributes(cart.id, attributes);
  } catch (error) {
    dependencies.logError?.(`attribution not recorded: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

/**
 * The session cart for the /cart page, or null. Closed behind the same two
 * gates as the action (`shopShownOpen`: a read, so the dev preview may show
 * it), so an old session cookie never shows or reopens a cart while the
 * store is closed.
 */
export async function loadSessionCart(
  env: CartEnv,
  dependencies: Pick<ShopifyCartDependencies, 'getCartId' | 'unsetCartId' | 'getCart' | 'logError'>,
): Promise<ShopifyCart | null> {
  if (!shopShownOpen(env)) throw fail('Checkout is closed.', 410);
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

/** What a cart replan changed: the price (another market or a new price),
 *  a line's ship date, both, or nothing. */
export type CartReplanChange = 'price' | 'date' | 'both' | null;

/** The cart notice for a replan or a checkout bounce, as a `CART_CHECK` value. */
export function replanCheck(change: CartReplanChange): string | null {
  return change === 'both' ? CART_CHECK.priceAndDate : change === 'price' ? CART_CHECK.price : change === 'date' ? CART_CHECK.shipDate : null;
}

function cartPrices(cart: ShopifyCart): string {
  return JSON.stringify([cart.subtotal, ...cart.lines.map((l) => [l.id, l.total])]);
}

/**
 * Put the session cart on the destination the header and the pages quote
 * (`od_ship_country`, else the visitor's country) and plan every line again
 * for that region, so the cart page, its checkout form and the header are
 * one state: the buyer country Shopify prices the cart in, and each line's
 * `Preorder`, `Delivery by`, hidden region and `_batch` attributes
 * (`rederiveLines`). Run by the cart page loader, so a cart built for
 * another destination, or priced before a price step, is shown as checkout
 * will charge it. A destination not sold direct leaves the cart alone.
 */
export async function replanCart(
  cart: ShopifyCart,
  destination: ShippingQuote | null,
  env: CartEnv,
  dependencies: {
    fetchCatalog: (region: Region, country?: string) => Promise<Catalog>;
    setCountry?: (cartId: string, countryCode: string) => Promise<void>;
    getCart?: (cartId: string) => Promise<ShopifyCart | null>;
    updateCartLines?: (cartId: string, lines: CartLineUpdate[]) => Promise<ShopifyCart>;
    /** False when the request names no country `geoCountryForRequest` knows:
     *  lines keep the batch promise, as the page shows. Default true. */
    euStockKnown?: boolean;
  },
): Promise<{cart: ShopifyCart; catalog: Catalog; change: CartReplanChange}> {
  const region = regionForDestination(destination);
  if (!destination || destination.kind !== 'direct' || !cart.lines.length) {
    return {cart, catalog: await dependencies.fetchCatalog(region, destination?.country), change: null};
  }
  const before = cartPrices(cart);
  let current = cart;
  const moves = cart.country !== destination.country;
  if (moves && dependencies.setCountry && dependencies.getCart) {
    await dependencies.setCountry(cart.id, destination.country);
    current = (await dependencies.getCart(cart.id)) ?? current;
  }
  const catalog = await dependencies.fetchCatalog(region, destination.country);
  const {refresh} = rederiveLines(current, catalog, region, env.PUBLIC_COMING_SOON !== '0', dependencies.euStockKnown ?? true);
  if (refresh.length && dependencies.updateCartLines) {
    current = await dependencies.updateCartLines(cart.id, refresh);
  }
  const price = cartPrices(current) !== before;
  const date = refresh.length > 0 && Boolean(dependencies.updateCartLines);
  return {cart: current, catalog, change: price && date ? 'both' : price ? 'price' : date ? 'date' : null};
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
  if (!shopShownOpen(env)) throw fail('Checkout is closed.', 410);
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
  /** The short ship label for the line; null when it has no promise. */
  shipLabel: string | null;
  /** The line ships to the EU only: it cannot go to a US destination. */
  euOnly: boolean;
  /** `now`: the line ships from stock in a few working days. `preorder`: it
   *  ships with a batch still to be produced; `month` then names it ("March
   *  2027"). Null when the line's ship state is unknown. */
  ships: 'now' | 'preorder' | null;
  month: string | null;
  /** The line's price is under the board's retail price: an early bird price. */
  early: boolean;
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
      shipLabel: shipLabelFromPromise(line.shipPromise, 'short'),
      euOnly: variant && catalog ? euOnlyStock(variant, catalog) : false,
      ships: !group.startsWith('date:')
        ? 'preorder'
        : stockPromise(line.shipPromise) || (variant?.availability === 'in_stock' && !line.shipPromise)
          ? 'now'
          : line.shipPromise ? 'preorder' : null,
      month: stockPromise(line.shipPromise) ? null : promiseBatchMonth(line.shipPromise),
      early: variant?.compare_price != null && variant.compare_price > variant.price,
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
