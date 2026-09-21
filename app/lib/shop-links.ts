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
 * The Shopify customer account URL. It is configuration supplied by the
 * store; this app does not derive login, order, profile, address or invoice
 * paths.
 */
export function customerAccountUrl(
  env: Pick<Env, 'SHOPIFY_CUSTOMER_ACCOUNT_URL'>,
): string | null {
  const configured = env.SHOPIFY_CUSTOMER_ACCOUNT_URL?.trim();
  if (!configured) return null;
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
