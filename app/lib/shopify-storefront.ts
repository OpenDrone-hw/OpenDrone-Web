import type {Catalog, CatalogProduct, CatalogVariant} from './catalog.ts';
import {devOverride} from './support/dev-overrides.ts';

const DEFAULT_API_VERSION = '2026-07';
const CART_PATH = '/api/shopify/cart';

const CATALOG_FIELDS = `
    products(first: $first, sortKey: TITLE) {
      pageInfo { hasNextPage }
      nodes {
        handle
        title
        description
        productType
        vendor
        featuredImage { url altText }
        images(first: 20) { nodes { url altText } }
        # Shopify's standard review metafields. Judge.me writes them once a
        # product has published reviews; absent means no reviews yet, and the
        # PDP then renders no trace of the feature.
        rating: metafield(namespace: "reviews", key: "rating") { value }
        ratingCount: metafield(namespace: "reviews", key: "rating_count") { value }
        variants(first: $variantsFirst) {
          pageInfo { hasNextPage }
          nodes {
            id
            title
            sku
            availableForSale
            image { url altText }
            price { amount currencyCode }
            compareAtPrice { amount currencyCode }
            selectedOptions { name value }
          }
        }
      }
    }
`;

const CATALOG_QUERY = `#graphql
  query OpenDroneCatalog($first: Int!, $variantsFirst: Int!) {${CATALOG_FIELDS}  }
`;

/** The catalog in the US market: Shopify's US prices (USD). Read only for a
 *  buyer shipping to the US while US sales are open. */
export const CATALOG_QUERY_US = `#graphql
  query OpenDroneCatalogUs($first: Int!, $variantsFirst: Int!) @inContext(country: US) {${CATALOG_FIELDS}  }
`;

/** Country-context prices and currency come from Shopify, without local conversion. */
export const CATALOG_QUERY_COUNTRY = `#graphql
  query OpenDroneCatalogCountry($first: Int!, $variantsFirst: Int!, $country: CountryCode!) @inContext(country: $country) {${CATALOG_FIELDS}  }
`;

const CART_FIELDS = `#graphql
  fragment OpenDroneCartFields on Cart {
    id
    checkoutUrl
    totalQuantity
    buyerIdentity { countryCode }
    cost {
      subtotalAmount { amount currencyCode }
      totalAmount { amount currencyCode }
    }
    lines(first: 100) {
      pageInfo { hasNextPage }
      nodes {
        id
        quantity
        attributes { key value }
        cost { totalAmount { amount currencyCode } }
        merchandise {
          ... on ProductVariant {
            id
            title
            sku
            image { url altText }
            selectedOptions { name value }
            product { handle title }
          }
        }
      }
    }
  }
`;

export const CART_CREATE_MUTATION = `#graphql
  ${CART_FIELDS}
  mutation OpenDroneCartCreate($input: CartInput!) {
    cartCreate(input: $input) {
      cart { ...OpenDroneCartFields }
      userErrors { field message }
      warnings { message }
    }
  }
`;

export const CART_QUERY = `#graphql
  ${CART_FIELDS}
  query OpenDroneCart($id: ID!) {
    cart(id: $id) { ...OpenDroneCartFields }
  }
`;

export const CART_LINES_ADD_MUTATION = `#graphql
  ${CART_FIELDS}
  mutation OpenDroneCartLinesAdd($cartId: ID!, $lines: [CartLineInput!]!) {
    cartLinesAdd(cartId: $cartId, lines: $lines) {
      cart { ...OpenDroneCartFields }
      userErrors { field message }
      warnings { message }
    }
  }
`;

export const CART_LINES_UPDATE_MUTATION = `#graphql
  ${CART_FIELDS}
  mutation OpenDroneCartLinesUpdate($cartId: ID!, $lines: [CartLineUpdateInput!]!) {
    cartLinesUpdate(cartId: $cartId, lines: $lines) {
      cart { ...OpenDroneCartFields }
      userErrors { field message }
      warnings { message }
    }
  }
`;

export const CART_LINES_REMOVE_MUTATION = `#graphql
  ${CART_FIELDS}
  mutation OpenDroneCartLinesRemove($cartId: ID!, $lineIds: [ID!]!) {
    cartLinesRemove(cartId: $cartId, lineIds: $lineIds) {
      cart { ...OpenDroneCartFields }
      userErrors { field message }
      warnings { message }
    }
  }
`;

/** The line attribute that carries the ship promise onto the checkout line
 *  and the order confirmation. */
export const PREORDER_ATTRIBUTE = 'Preorder';
/** The separately agreed customer arrival deadline, visible at checkout. */
export const DELIVERY_BY_ATTRIBUTE = 'Delivery by';
/** The line's own deadline while its visible deadline follows a combined order. */
export const DELIVERY_BY_OWN_ATTRIBUTE = '_delivery_by_own';

/** The visible line attribute naming the batch and where it ships, in the
 *  words of the product page and the cart: "Batch 1 · EU only", "March 2027
 *  batch · EU and US". */
export const AVAILABILITY_ATTRIBUTE = 'Availability';

/** The hidden line attribute (a leading underscore hides it at checkout)
 *  naming the region a preorder line's promise was computed for. Non-EU
 *  lines carry `US` or `INT`; absent means EU. The hold pass tags an order
 *  that ships elsewhere `promise-mismatch`. */
export const SHIP_REGION_ATTRIBUTE = '_ship_region';

/** The hidden line attribute naming the batch a preorder line's promise was
 *  computed for, `SKU:N` (the lead SKU for an item that ships with one).
 *  The hold pass tags an order allocated another batch `promise-mismatch`. */
export const BATCH_ATTRIBUTE = '_batch';

/** The hidden line attribute holding a line's own ship promise while its
 *  `Preorder` attribute carries the mixed-order wording ("ships with the
 *  rest of this order by ..."). Absent on every other line. */
export const PREORDER_OWN_ATTRIBUTE = '_preorder_own';

export type ShopifyMoney = {amount: string; currencyCode: string};

export type ShopifyCartLine = {
  id: string;
  merchandiseId: string;
  quantity: number;
  title: string;
  variantTitle: string;
  handle: string;
  sku: string | null;
  image: {url: string; altText: string | null} | null;
  selectedOptions: Array<{name: string; value: string}>;
  /** The line's own ship promise: the hidden `_preorder_own` attribute when
   *  the line carries the mixed-order wording, else its `Preorder` attribute. */
  shipPromise: string | null;
  deliveryBy?: string | null;
  orderDeliveryBy?: string | null;
  /** The `Preorder` attribute as the order will show it, set only when it
   *  differs from `shipPromise` (the mixed-order wording). */
  orderPromise?: string | null;
  /** The region the promise was computed for, from `_ship_region`; null
   *  for an EU line. */
  shipRegion?: string | null;
  /** The `Availability` attribute: the batch and where it ships. */
  availability?: string | null;
  /** The hidden `_batch` attribute, `SKU:N`. */
  batch?: string | null;
  total: ShopifyMoney;
};

export type ShopifyCart = {
  id: string;
  checkoutUrl: string;
  totalQuantity: number;
  subtotal: ShopifyMoney;
  total: ShopifyMoney;
  /** The cart's `buyerIdentity.countryCode`: the market Shopify prices it
   *  in and checkout opens in. Absent or null when none was set. */
  country?: string | null;
  lines: ShopifyCartLine[];
};

/** A line to add: the variant, how many, and the attributes Shopify shows
 *  on the checkout line and the order (the preorder ship promise). */
export type CartLineInput = {
  merchandiseId: string;
  quantity: number;
  attributes?: Array<{key: string; value: string}>;
};

/** A line change: its quantity, and optionally replaced attributes. */
export type CartLineUpdate = {
  id: string;
  quantity: number;
  attributes?: Array<{key: string; value: string}>;
};

type StorefrontEnv = Pick<
  Env,
  | 'SHOPIFY_STORE_DOMAIN'
  | 'SHOPIFY_STOREFRONT_TOKEN'
  | 'SHOPIFY_STOREFRONT_API_VERSION'
  | 'SHOPIFY_CHECKOUT_DOMAIN'
  | 'SHOPIFY_PRICES_INCLUDE_VAT'
  | 'SHOPIFY_PREVIEW_POLICY_JSON'
>;

type GraphqlResult<T> = {data?: T; errors?: Array<{message?: string}>};

function required(env: StorefrontEnv, key: keyof StorefrontEnv): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`shopify: ${key} is not configured`);
  return value;
}

export function storefrontEndpoint(env: StorefrontEnv): string {
  // The support sandbox (`npm run support:sandbox`) answers on the dev
  // server only; a build folds the DEV flag to false and drops this.
  const sandbox =
    typeof import.meta.env !== 'undefined' && import.meta.env.DEV
      ? devOverride((env as {SUPPORT_DEV_STOREFRONT_URL?: string}).SUPPORT_DEV_STOREFRONT_URL)
      : null;
  if (sandbox) return sandbox;
  const host = required(env, 'SHOPIFY_STORE_DOMAIN')
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  if (!/^[a-z0-9][a-z0-9.-]*\.myshopify\.com$/i.test(host)) {
    throw new Error('shopify: SHOPIFY_STORE_DOMAIN must be a myshopify.com host');
  }
  const version =
    env.SHOPIFY_STOREFRONT_API_VERSION?.trim() || DEFAULT_API_VERSION;
  if (!/^\d{4}-(01|04|07|10)$/.test(version)) {
    throw new Error('shopify: invalid Storefront API version');
  }
  return `https://${host}/api/${version}/graphql.json`;
}

export async function storefrontRequest<T>(
  env: StorefrontEnv,
  query: string,
  variables: Record<string, unknown>,
  fetcher: typeof fetch = fetch,
): Promise<T> {
  const response = await fetcher(storefrontEndpoint(env), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Storefront-Access-Token': required(
        env,
        'SHOPIFY_STOREFRONT_TOKEN',
      ),
    },
    body: JSON.stringify({query, variables}),
    // Workers supports follow/manual only. Manual plus the response status
    // check below preserves the fail-closed redirect policy.
    redirect: 'manual',
  });
  if (!response.ok) {
    throw new Error(`shopify: Storefront API returned ${response.status}`);
  }
  const result = (await response.json()) as GraphqlResult<T>;
  if (result.errors?.length || !result.data) {
    throw new Error('shopify: Storefront API rejected the operation');
  }
  return result.data;
}

/**
 * The review aggregate from Shopify's standard `reviews.rating` and
 * `reviews.rating_count` metafields, which the review app maintains. The
 * rating metafield is a `rating` type: JSON carrying `value`, `scale_min`
 * and `scale_max`. Anything missing, unparseable or zero-count returns null,
 * so the storefront shows no rating rather than a wrong one.
 */
export function productRating(
  rating: string | undefined,
  ratingCount: string | undefined,
): {average: number; count: number} | null {
  if (!rating || !ratingCount) return null;
  const count = Number(ratingCount);
  if (!Number.isFinite(count) || count <= 0) return null;
  let average: number;
  try {
    const parsed = JSON.parse(rating) as {value?: string | number} | number;
    // A `rating` metafield is an object; a plain number parses to a number.
    average = typeof parsed === 'object' && parsed ? Number(parsed.value) : Number(parsed);
  } catch {
    average = Number(rating);
  }
  if (!Number.isFinite(average) || average <= 0) return null;
  return {average, count: Math.round(count)};
}

type ShopifyCatalogData = {
  products: {
    pageInfo: {hasNextPage: boolean};
    nodes: Array<{
      handle: string;
      title: string;
      description: string;
      productType: string;
      vendor: string | null;
      featuredImage: {url: string; altText: string | null} | null;
      images: {nodes: Array<{url: string; altText: string | null}>};
      rating: {value: string} | null;
      ratingCount: {value: string} | null;
      variants: {
        pageInfo: {hasNextPage: boolean};
        nodes: Array<{
          id: string;
          title: string;
          sku: string | null;
          availableForSale: boolean;
          image: {url: string; altText: string | null} | null;
          price: {amount: string; currencyCode: string};
          compareAtPrice: {amount: string; currencyCode: string} | null;
          selectedOptions: Array<{name: string; value: string}>;
        }>;
      };
    }>;
  };
};

function finiteMoney(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`shopify: invalid ${label}`);
  }
  return parsed;
}

export function mapShopifyCatalog(
  data: ShopifyCatalogData,
  storeDomain: string,
  policyJson: string,
  pricesIncludeVat: string,
  /** The default catalog must be EUR and the US catalog USD. Other country
   *  contexts use one consistent currency returned by Shopify. */
  market: string = 'default',
): Catalog {
  const expectedCurrency = market === 'US' ? 'USD' : market === 'default' ? 'EUR' : null;
  if (pricesIncludeVat !== '1') {
    throw new Error('shopify: VAT-inclusive pricing is not explicitly configured');
  }
  let policy: Record<string, {saleMode?: unknown; shipPromise?: unknown}>;
  try {
    policy = JSON.parse(policyJson) as typeof policy;
  } catch {
    throw new Error('shopify: SHOPIFY_PREVIEW_POLICY_JSON is invalid');
  }
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new Error('shopify: SHOPIFY_PREVIEW_POLICY_JSON is invalid');
  }
  if (data.products.pageInfo.hasNextPage) {
    throw new Error('shopify: product catalog exceeds the configured page');
  }
  const seen = new Set<string>();
  let catalogCurrency: string | null = null;
  const products: CatalogProduct[] = data.products.nodes.map((product) => {
    if (product.variants.pageInfo.hasNextPage) {
      throw new Error(`shopify: ${product.handle} has more than 100 variants`);
    }
    const variants: CatalogVariant[] = product.variants.nodes.map((variant) => {
      const sku = variant.sku?.trim();
      if (!sku || seen.has(sku)) {
        throw new Error(`shopify: missing or duplicate SKU on ${product.handle}`);
      }
      seen.add(sku);
      const configured = policy[sku];
      if (
        !configured ||
        !['in_stock', 'preorder', 'sold_out'].includes(String(configured.saleMode)) ||
        !(typeof configured.shipPromise === 'string' || configured.shipPromise === null)
      ) {
        throw new Error(`shopify: missing catalog policy for ${sku}`);
      }
      if (configured.saleMode === 'sold_out' && configured.shipPromise !== null) {
        throw new Error(`shopify: closed SKU ${sku} must not carry a ship promise`);
      }
      const options = Object.fromEntries(
        variant.selectedOptions.map(({name, value}) => [name, value]),
      );
      const price = finiteMoney(variant.price.amount, `${sku} price`);
      if ((expectedCurrency && variant.price.currencyCode !== expectedCurrency) || !/^[A-Z]{3}$/.test(variant.price.currencyCode)) {
        throw new Error(`shopify: ${sku} is not priced in ${expectedCurrency}`);
      }
      catalogCurrency ??= variant.price.currencyCode;
      if (variant.price.currencyCode !== catalogCurrency) {
        throw new Error('shopify: mixed catalog currencies');
      }
      if (
        variant.compareAtPrice &&
        variant.compareAtPrice.currencyCode !== variant.price.currencyCode
      ) {
        throw new Error(`shopify: ${sku} compare price currency differs`);
      }
      const comparePrice = variant.compareAtPrice
        ? finiteMoney(variant.compareAtPrice.amount, `${sku} compare price`)
        : null;
      return {
        sku,
        title: variant.title,
        model: options.Model ?? null,
        options,
        price,
        compare_price: comparePrice,
        currency: variant.price.currencyCode,
        // Shopify availability is only a deny gate. It can be true for an
        // overselling preorder and therefore never proves physical stock.
        availability: variant.availableForSale
          ? (configured.saleMode as CatalogVariant['availability'])
          : 'sold_out',
        ship_promise: configured.shipPromise,
        image: variant.image?.url ?? product.featuredImage?.url ?? null,
        // Alt text names the tier ("OpenRX Gemini, front"); the gallery
        // uses it to show the selected tier's photos.
        image_alt: (variant.image ?? product.featuredImage)?.altText ?? null,
        url: `/products/${product.handle}`,
        cart_add_url: `${CART_PATH}?sku=${encodeURIComponent(sku)}&qty=1`,
        cart_add_method: 'POST',
        merchandise_id: variant.id,
      } as CatalogVariant;
    });
    return {
      handle: product.handle,
      title: product.title,
      family: product.productType || null,
      vendor: product.vendor?.trim() || null,
      description: product.description || null,
      url: `/products/${product.handle}`,
      images: product.images.nodes.map(({url}) => url),
      image_alts: product.images.nodes.map(({altText}) => altText ?? null),
      rating: productRating(product.rating?.value, product.ratingCount?.value),
      variants,
    };
  });
  const shop = `https://${storeDomain.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;
  return {
    schema: 1,
    generated_at: new Date().toISOString(),
    max_age: 300,
    currency: catalogCurrency || expectedCurrency || 'EUR',
    // The US catalog's USD list price is the price paid: no EU VAT, no
    // sales tax, duties included.
    prices_include_vat: market === 'default',
    shop_url: shop,
    cart_url: shop,
    add_url: CART_PATH,
    add_method: 'POST',
    products,
  };
}

export async function fetchShopifyCatalog(
  env: StorefrontEnv,
  fetcher: typeof fetch = fetch,
  market: string = 'default',
): Promise<Catalog> {
  if (market !== 'default' && !/^[A-Z]{2}$/.test(market)) throw new Error('shopify: invalid market country');
  const data = await storefrontRequest<ShopifyCatalogData>(
    env,
    market === 'US' ? CATALOG_QUERY_US : market === 'default' ? CATALOG_QUERY : CATALOG_QUERY_COUNTRY,
    {first: 100, variantsFirst: 100, ...(market !== 'default' && market !== 'US' ? {country: market} : {})},
    fetcher,
  );
  return mapShopifyCatalog(
    data,
    required(env, 'SHOPIFY_STORE_DOMAIN'),
    required(env, 'SHOPIFY_PREVIEW_POLICY_JSON'),
    required(env, 'SHOPIFY_PRICES_INCLUDE_VAT'),
    market,
  );
}

type CartWire = {
  id: string;
  checkoutUrl: string;
  totalQuantity: number;
  buyerIdentity?: {countryCode?: string | null} | null;
  cost: {subtotalAmount: ShopifyMoney; totalAmount: ShopifyMoney};
  lines: {
    pageInfo: {hasNextPage: boolean};
    nodes: Array<{
      id: string;
      quantity: number;
      attributes: Array<{key: string; value: string}>;
      cost: {totalAmount: ShopifyMoney};
      merchandise: {
        id: string;
        title: string;
        sku: string | null;
        image: {url: string; altText: string | null} | null;
        selectedOptions: Array<{name: string; value: string}>;
        product: {handle: string; title: string};
      };
    }>;
  };
};

type CartPayload = {
  cart: CartWire | null;
  userErrors: Array<{field?: string[]; message: string}>;
  warnings: Array<{message: string}>;
};

function validatedCart(
  env: StorefrontEnv,
  cart: CartWire,
  expectedId?: string,
): ShopifyCart {
  if (cart.lines.pageInfo.hasNextPage) {
    throw new Error('shopify: cart exceeds the supported line page');
  }
  if (!cart.id || (expectedId && cart.id !== expectedId)) {
    throw new Error('shopify: cart response uses an unexpected identity');
  }
  if (
    cart.lines.nodes.some(
      (line) =>
        !line.id ||
        !line.merchandise.id ||
        !Number.isSafeInteger(line.quantity) ||
        line.quantity < 1,
    )
  ) {
    throw new Error('shopify: cart response has invalid lines');
  }
  const checkout = new URL(cart.checkoutUrl);
  const allowed = new Set(
    [required(env, 'SHOPIFY_STORE_DOMAIN'), env.SHOPIFY_CHECKOUT_DOMAIN]
      .filter((value): value is string => Boolean(value))
      .map((value) => new URL(`https://${value.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`).origin),
  );
  if (
    checkout.protocol !== 'https:' ||
    checkout.username ||
    checkout.password ||
    !allowed.has(checkout.origin)
  ) {
    throw new Error('shopify: checkout URL uses an unexpected origin');
  }
  return {
    id: cart.id,
    checkoutUrl: checkout.toString(),
    totalQuantity: cart.totalQuantity,
    subtotal: cart.cost.subtotalAmount,
    total: cart.cost.totalAmount,
    ...(cart.buyerIdentity?.countryCode ? {country: cart.buyerIdentity.countryCode.toUpperCase()} : {}),
    lines: cart.lines.nodes.map((line) => {
      // Non-EU lines record their region; absence remains the EU default.
      const shipRegion = line.attributes.find(({key}) => key === SHIP_REGION_ATTRIBUTE)?.value;
      const preorder = line.attributes.find(({key}) => key === PREORDER_ATTRIBUTE)?.value ?? null;
      const own = line.attributes.find(({key}) => key === PREORDER_OWN_ATTRIBUTE)?.value;
      const availability = line.attributes.find(({key}) => key === AVAILABILITY_ATTRIBUTE)?.value;
      const deliveryBy = line.attributes.find(({key}) => key === DELIVERY_BY_ATTRIBUTE)?.value;
      const ownDeliveryBy = line.attributes.find(({key}) => key === DELIVERY_BY_OWN_ATTRIBUTE)?.value;
      const batch = line.attributes.find(({key}) => key === BATCH_ATTRIBUTE)?.value;
      return {
        id: line.id,
        merchandiseId: line.merchandise.id,
        quantity: line.quantity,
        title: line.merchandise.product.title,
        variantTitle: line.merchandise.title,
        handle: line.merchandise.product.handle,
        sku: line.merchandise.sku,
        image: line.merchandise.image,
        selectedOptions: line.merchandise.selectedOptions,
        shipPromise: own && preorder ? own : preorder,
        ...(deliveryBy ? {deliveryBy: ownDeliveryBy || deliveryBy} : {}),
        ...(ownDeliveryBy && deliveryBy && ownDeliveryBy !== deliveryBy ? {orderDeliveryBy: deliveryBy} : {}),
        ...(own && preorder && own !== preorder ? {orderPromise: preorder} : {}),
        ...(shipRegion ? {shipRegion} : {}),
        ...(availability ? {availability} : {}),
        ...(batch ? {batch} : {}),
        total: line.cost.totalAmount,
      };
    }),
  };
}

function payloadCart(
  env: StorefrontEnv,
  payload: CartPayload,
  operation: string,
  expectedId?: string,
): ShopifyCart {
  if (payload.userErrors.length || payload.warnings.length || !payload.cart) {
    throw new Error(`shopify: ${operation} failed`);
  }
  return validatedCart(env, payload.cart, expectedId);
}

export async function createCart(
  env: StorefrontEnv,
  lines: CartLineInput[],
  fetcher: typeof fetch = fetch,
): Promise<ShopifyCart> {
  if (!lines.length) throw new Error('shopify: cart has no valid lines');
  const data = await storefrontRequest<{cartCreate: CartPayload}>(
    env, CART_CREATE_MUTATION, {input: {lines}}, fetcher,
  );
  return payloadCart(env, data.cartCreate, 'cartCreate');
}

export async function getCart(env: StorefrontEnv, id: string, fetcher: typeof fetch = fetch) {
  const data = await storefrontRequest<{cart: CartWire | null}>(env, CART_QUERY, {id}, fetcher);
  return data.cart ? validatedCart(env, data.cart, id) : null;
}

export async function addCartLines(
  env: StorefrontEnv,
  cartId: string,
  lines: CartLineInput[],
  fetcher: typeof fetch = fetch,
) {
  const data = await storefrontRequest<{cartLinesAdd: CartPayload}>(
    env, CART_LINES_ADD_MUTATION, {cartId, lines}, fetcher,
  );
  return payloadCart(env, data.cartLinesAdd, 'cartLinesAdd', cartId);
}

export async function updateCartLines(
  env: StorefrontEnv,
  cartId: string,
  lines: CartLineUpdate[],
  fetcher: typeof fetch = fetch,
) {
  const data = await storefrontRequest<{cartLinesUpdate: CartPayload}>(
    env, CART_LINES_UPDATE_MUTATION, {cartId, lines}, fetcher,
  );
  return payloadCart(env, data.cartLinesUpdate, 'cartLinesUpdate', cartId);
}

export async function removeCartLines(
  env: StorefrontEnv,
  cartId: string,
  lineIds: string[],
  fetcher: typeof fetch = fetch,
) {
  const data = await storefrontRequest<{cartLinesRemove: CartPayload}>(
    env, CART_LINES_REMOVE_MUTATION, {cartId, lineIds}, fetcher,
  );
  return payloadCart(env, data.cartLinesRemove, 'cartLinesRemove', cartId);
}

const PAYMENT_SETTINGS_QUERY = `#graphql
  query PaymentSettings {
    shop {
      paymentSettings {
        acceptedCardBrands
        supportedDigitalWallets
      }
    }
  }
`;

/** The card brands and wallets the shop's checkout accepts, as Shopify
 *  reports them ("VISA", "APPLE_PAY"). Empty when none are reported. */
export async function fetchPaymentMethods(
  env: StorefrontEnv,
  fetcher: typeof fetch = fetch,
): Promise<string[]> {
  const data = await storefrontRequest<{
    shop: {paymentSettings: {acceptedCardBrands: string[]; supportedDigitalWallets: string[]}};
  }>(env, PAYMENT_SETTINGS_QUERY, {}, fetcher);
  const settings = data.shop.paymentSettings;
  return [...settings.acceptedCardBrands, ...settings.supportedDigitalWallets];
}
