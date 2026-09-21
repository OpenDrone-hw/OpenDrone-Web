import type {Catalog, CatalogProduct, CatalogVariant} from './catalog.ts';

const DEFAULT_API_VERSION = '2026-07';
const CART_PATH = '/api/shopify/cart';
const PREORDER_ATTRIBUTES = [
  {key: 'OpenDrone order type', value: 'Pre-order'},
  {key: 'OpenDrone shipping', value: 'Billed separately when the complete order is ready'},
];

const STOREFRONT_PRODUCT_TYPES = [
  'frame',
  'pcb',
  'flight controller',
  'esc',
  'receiver',
  'elrs receiver',
  'motor',
] as const;

function isStorefrontProductType(productType: string): boolean {
  const normalized = productType.trim().toLowerCase();
  return STOREFRONT_PRODUCT_TYPES.some((type) => normalized === type);
}

const CART_FIELDS = `#graphql
  fragment OpenDroneCartFields on Cart {
    id
    checkoutUrl
    totalQuantity
    cost {
      subtotalAmount { amount currencyCode }
      totalAmount { amount currencyCode }
    }
    lines(first: 100) {
      pageInfo { hasNextPage }
      nodes {
        id
        quantity
        cost { totalAmount { amount currencyCode } }
        merchandise {
          ... on ProductVariant {
            id
            title
            sku
            image { url altText }
            selectedOptions { name value }
            product { handle title productType }
          }
        }
      }
    }
  }
`;

const CATALOG_QUERY = `#graphql
  query OpenDroneCatalog($first: Int!, $variantsFirst: Int!) {
    products(first: $first, sortKey: TITLE) {
      pageInfo { hasNextPage }
      nodes {
        handle
        title
        description
        productType
        featuredImage { url }
        images(first: 10) { nodes { url } }
        variants(first: $variantsFirst) {
          pageInfo { hasNextPage }
          nodes {
            id
            title
            sku
            availableForSale
            image { url }
            price { amount currencyCode }
            compareAtPrice { amount currencyCode }
            selectedOptions { name value }
          }
        }
      }
    }
  }
`;

export const PRODUCT_RECOMMENDATIONS_QUERY = `#graphql
  query OpenDroneComplementaryProducts($handle: String!) {
    productRecommendations(productHandle: $handle, intent: COMPLEMENTARY) {
      handle
      productType
      availableForSale
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

export type ShopifyMoney = {amount: string; currencyCode: string};
export type ShopifyCartLine = {
  id: string;
  lineIds: string[];
  merchandiseId: string;
  quantity: number;
  title: string;
  variantTitle: string;
  handle: string;
  productType: string;
  sku: string | null;
  image: {url: string; altText: string | null} | null;
  selectedOptions: Array<{name: string; value: string}>;
  total: ShopifyMoney;
};

export type ShopifyCart = {
  id: string;
  checkoutUrl: string;
  totalQuantity: number;
  subtotal: ShopifyMoney;
  total: ShopifyMoney;
  lines: ShopifyCartLine[];
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

type ShopifyCatalogData = {
  products: {
    pageInfo: {hasNextPage: boolean};
    nodes: Array<{
      handle: string;
      title: string;
      description: string;
      productType: string;
      featuredImage: {url: string} | null;
      images: {nodes: Array<{url: string}>};
      variants: {
        pageInfo: {hasNextPage: boolean};
        nodes: Array<{
          id: string;
          title: string;
          sku: string | null;
          availableForSale: boolean;
          image: {url: string} | null;
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
): Catalog {
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
  const products: CatalogProduct[] = data.products.nodes
  .filter((product) => isStorefrontProductType(product.productType))
  .map((product) => {
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
      if (variant.price.currencyCode !== 'EUR') {
        throw new Error(`shopify: ${sku} is not priced in EUR`);
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
      description: product.description || null,
      url: `/products/${product.handle}`,
      images: product.images.nodes.map(({url}) => url),
      rating: null,
      variants,
    };
  });
  const shop = `https://${storeDomain.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;
  return {
    schema: 1,
    generated_at: new Date().toISOString(),
    max_age: 300,
    currency: catalogCurrency || 'EUR',
    prices_include_vat: true,
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
): Promise<Catalog> {
  const data = await storefrontRequest<ShopifyCatalogData>(
    env,
    CATALOG_QUERY,
    {first: 100, variantsFirst: 100},
    fetcher,
  );
  return mapShopifyCatalog(
    data,
    required(env, 'SHOPIFY_STORE_DOMAIN'),
    required(env, 'SHOPIFY_PREVIEW_POLICY_JSON'),
    required(env, 'SHOPIFY_PRICES_INCLUDE_VAT'),
  );
}

/**
 * Shopify Search & Discovery owns product-level merchandising links. The
 * build graph applies variant/quantity compatibility after this result, so
 * a recommendation can change rank but cannot cross build sizes.
 */
export async function fetchShopifyComplementaryHandles(
  env: StorefrontEnv,
  productHandle: string,
  fetcher: typeof fetch = fetch,
): Promise<string[]> {
  if (!/^[a-z0-9][a-z0-9-]{0,254}$/.test(productHandle)) return [];
  const data = await storefrontRequest<{
    productRecommendations: Array<{
      handle: string;
      productType: string;
      availableForSale: boolean;
    }> | null;
  }>(env, PRODUCT_RECOMMENDATIONS_QUERY, {handle: productHandle}, fetcher);
  return (data.productRecommendations ?? [])
    .filter(
      (product) =>
        product.availableForSale && isStorefrontProductType(product.productType),
    )
    .map(({handle}) => handle);
}

type CartWire = {
  id: string;
  checkoutUrl: string;
  totalQuantity: number;
  cost: {subtotalAmount: ShopifyMoney; totalAmount: ShopifyMoney};
  lines: {
    pageInfo: {hasNextPage: boolean};
    nodes: Array<{
      id: string;
      quantity: number;
      cost: {totalAmount: ShopifyMoney};
      merchandise: {
        id: string;
        title: string;
        sku: string | null;
        image: {url: string; altText: string | null} | null;
        selectedOptions: Array<{name: string; value: string}>;
        product: {handle: string; title: string; productType: string};
      };
    }>;
  };
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
    lines: mergeCartLines(cart.lines.nodes.map((line) => ({
      id: line.id,
      lineIds: [line.id],
      merchandiseId: line.merchandise.id,
      quantity: line.quantity,
      title: line.merchandise.product.title,
      variantTitle: line.merchandise.title,
      handle: line.merchandise.product.handle,
      productType: line.merchandise.product.productType,
      sku: line.merchandise.sku,
      image: line.merchandise.image,
      selectedOptions: line.merchandise.selectedOptions,
      total: line.cost.totalAmount,
    }))),
  };
}

export function mergeCartLines(lines: ShopifyCartLine[]): ShopifyCartLine[] {
  const merged = new Map<string, ShopifyCartLine>();
  for (const line of lines) {
    const existing = merged.get(line.merchandiseId);
    if (!existing) {
      merged.set(line.merchandiseId, {...line, lineIds: [...line.lineIds]});
      continue;
    }
    if (existing.total.currencyCode !== line.total.currencyCode) {
      throw new Error('shopify: duplicate cart lines use mixed currencies');
    }
    existing.lineIds.push(...line.lineIds);
    existing.quantity += line.quantity;
    existing.total = {
      amount: (Number(existing.total.amount) + Number(line.total.amount)).toFixed(2),
      currencyCode: existing.total.currencyCode,
    };
  }
  return [...merged.values()];
}

export async function createCart(
  env: StorefrontEnv,
  lines: Array<{merchandiseId: string; quantity: number}>,
  fetcher: typeof fetch = fetch,
): Promise<ShopifyCart> {
  if (!lines.length) throw new Error('shopify: cart has no valid lines');
  const data = await storefrontRequest<{
    cartCreate: {
      cart: CartWire | null;
      userErrors: Array<{field?: string[]; message: string}>;
      warnings: Array<{message: string}>;
    };
  }>(env, CART_CREATE_MUTATION, {
    input: {lines, attributes: PREORDER_ATTRIBUTES},
  }, fetcher);
  if (
    data.cartCreate.userErrors.length ||
    data.cartCreate.warnings.length ||
    !data.cartCreate.cart?.checkoutUrl
  ) {
    throw new Error('shopify: cartCreate failed');
  }
  return validatedCart(env, data.cartCreate.cart);
}

export async function createCheckout(
  env: StorefrontEnv,
  lines: Array<{merchandiseId: string; quantity: number}>,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  return (await createCart(env, lines, fetcher)).checkoutUrl;
}

export async function getCart(env: StorefrontEnv, id: string, fetcher: typeof fetch = fetch) {
  const data = await storefrontRequest<{cart: CartWire | null}>(env, CART_QUERY, {id}, fetcher);
  return data.cart ? validatedCart(env, data.cart, id) : null;
}

export async function addCartLines(
  env: StorefrontEnv,
  cartId: string,
  lines: Array<{merchandiseId: string; quantity: number}>,
  fetcher: typeof fetch = fetch,
) {
  const data = await storefrontRequest<{
    cartLinesAdd: {cart: CartWire | null; userErrors: unknown[]; warnings: unknown[]};
  }>(env, CART_LINES_ADD_MUTATION, {cartId, lines}, fetcher);
  if (data.cartLinesAdd.userErrors.length || data.cartLinesAdd.warnings.length || !data.cartLinesAdd.cart) {
    throw new Error('shopify: cartLinesAdd failed');
  }
  return validatedCart(env, data.cartLinesAdd.cart, cartId);
}

export async function updateCartLines(
  env: StorefrontEnv,
  cartId: string,
  lines: Array<{id: string; quantity: number}>,
  fetcher: typeof fetch = fetch,
) {
  const data = await storefrontRequest<{
    cartLinesUpdate: {cart: CartWire | null; userErrors: unknown[]; warnings: unknown[]};
  }>(env, CART_LINES_UPDATE_MUTATION, {cartId, lines}, fetcher);
  if (data.cartLinesUpdate.userErrors.length || data.cartLinesUpdate.warnings.length || !data.cartLinesUpdate.cart) {
    throw new Error('shopify: cartLinesUpdate failed');
  }
  return validatedCart(env, data.cartLinesUpdate.cart, cartId);
}

export async function removeCartLines(
  env: StorefrontEnv,
  cartId: string,
  lineIds: string[],
  fetcher: typeof fetch = fetch,
) {
  const data = await storefrontRequest<{
    cartLinesRemove: {cart: CartWire | null; userErrors: unknown[]; warnings: unknown[]};
  }>(env, CART_LINES_REMOVE_MUTATION, {cartId, lineIds}, fetcher);
  if (data.cartLinesRemove.userErrors.length || data.cartLinesRemove.warnings.length || !data.cartLinesRemove.cart) {
    throw new Error('shopify: cartLinesRemove failed');
  }
  return validatedCart(env, data.cartLinesRemove.cart, cartId);
}
