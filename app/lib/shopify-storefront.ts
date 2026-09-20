import type {Catalog, CatalogProduct, CatalogVariant} from './catalog.ts';

const DEFAULT_API_VERSION = '2026-07';
const CART_PATH = '/api/shopify/cart';

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

export const CART_CREATE_MUTATION = `#graphql
  mutation OpenDroneCartCreate($input: CartInput!) {
    cartCreate(input: $input) {
      cart { id checkoutUrl lines(first: 100) { pageInfo { hasNextPage } nodes { merchandise { ... on ProductVariant { id } } quantity } } }
      userErrors { field message }
      warnings { message }
    }
  }
`;

export const CART_QUERY = `#graphql
  query OpenDroneCart($id: ID!) {
    cart(id: $id) {
      id
      checkoutUrl
      lines(first: 100) { pageInfo { hasNextPage } nodes { merchandise { ... on ProductVariant { id } } quantity } }
    }
  }
`;

export const CART_LINES_ADD_MUTATION = `#graphql
  mutation OpenDroneCartLinesAdd($cartId: ID!, $lines: [CartLineInput!]!) {
    cartLinesAdd(cartId: $cartId, lines: $lines) {
      cart { id checkoutUrl lines(first: 100) { pageInfo { hasNextPage } nodes { merchandise { ... on ProductVariant { id } } quantity } } }
      userErrors { field message }
      warnings { message }
    }
  }
`;

export type ShopifyCart = {
  id: string;
  checkoutUrl: string;
  lines: Array<{merchandiseId: string; quantity: number}>;
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

type CartWire = {
  id: string;
  checkoutUrl: string;
  lines: {
    pageInfo: {hasNextPage: boolean};
    nodes: Array<{merchandise: {id: string}; quantity: number}>;
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
    lines: cart.lines.nodes.map((line) => ({
      merchandiseId: line.merchandise.id,
      quantity: line.quantity,
    })),
  };
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
  }>(env, CART_CREATE_MUTATION, {input: {lines}}, fetcher);
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
