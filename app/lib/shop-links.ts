/**
 * Links into Shopify commerce: the buy hand-off and the customer account.
 *
 * Bundler-free (relative imports) so the node:test suites can load it.
 */

import {cartAddUrl, type CartLine, type Catalog} from './catalog.ts';

/** The local server action that creates the Shopify cart. */
export const SHOPIFY_CART_PATH = '/api/shopify/cart';

export type CommerceHandoff = {
  addUrl: string;
  /** The cart page, once this session has a Shopify cart to revisit. */
  cartUrl: string | null;
};

export function commerceHandoff(
  catalog: Catalog,
  hasShopifyCart = false,
): CommerceHandoff {
  if (catalog.add_url !== SHOPIFY_CART_PATH) {
    throw new Error('shopify catalog has an unexpected add endpoint');
  }
  return {
    addUrl: catalog.add_url,
    cartUrl: hasShopifyCart ? '/cart' : null,
  };
}

/**
 * The Shopify customer account URL: SHOPIFY_CUSTOMER_ACCOUNT_URL when set
 * (store-supplied configuration, used as-is, no subpath invented on top of
 * it); otherwise derived from SHOPIFY_CUSTOMER_ACCOUNT_SHOP_ID (the same
 * numeric shop id the Customer Account API OIDC client already uses, see
 * accounts/shopify-idp.ts) as `https://shopify.com/<shop id>/account` - the
 * exact URL Shopify's own "Customer accounts" settings page shows once new
 * customer accounts are on (README "Create the Shopify client"). null when
 * neither is configured or the shop id is not purely numeric.
 */
export function customerAccountUrl(
  env: Pick<Env, 'SHOPIFY_CUSTOMER_ACCOUNT_URL' | 'SHOPIFY_CUSTOMER_ACCOUNT_SHOP_ID'>,
): string | null {
  const configured = env.SHOPIFY_CUSTOMER_ACCOUNT_URL?.trim();
  if (configured) {
    let url: URL;
    try {
      url = new URL(configured);
    } catch {
      throw new Error('shopify: SHOPIFY_CUSTOMER_ACCOUNT_URL is invalid');
    }
    if (url.protocol !== 'https:' || url.username || url.password) {
      throw new Error('shopify: SHOPIFY_CUSTOMER_ACCOUNT_URL must be HTTPS');
    }
    return url.toString();
  }
  const shopId = env.SHOPIFY_CUSTOMER_ACCOUNT_SHOP_ID?.trim();
  return shopId && /^\d+$/.test(shopId) ? `https://shopify.com/${shopId}/account` : null;
}

/**
 * The buy hand-off for one or more SKUs: the cart action plus its fields as a
 * query string. `AddToCartButton` submits it as a POST.
 */
export function buyUrl(
  handoff: CommerceHandoff,
  lines: CartLine[],
  opts?: {next?: string; mode?: 'add' | 'set'},
): string {
  return cartAddUrl(handoff.addUrl, lines, opts);
}
