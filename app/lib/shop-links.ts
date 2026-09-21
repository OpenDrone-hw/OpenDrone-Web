/**
 * Links into the Odoo shop: the buy hand-off and the customer portal.
 *
 * Odoo owns cart, checkout, orders, invoices, addresses and accounts
 * (contract sections 3 and 4). Everything the storefront needs to point
 * at one of those lives here, so the base URL is read in one place.
 *
 * Bundler-free (relative imports) so the node:test suites can load it.
 */

import {cartAddUrl, type CartLine, type Catalog} from './catalog.ts';

export const DEFAULT_SHOP_URL = 'https://shop.incutec.com';

/** Portal paths, relative to the shop base. See contract section 4. */
export const PORTAL_PATHS = {
  login: '/web/login',
  signup: '/web/signup',
  resetPassword: '/web/reset_password',
  logout: '/web/session/logout',
  account: '/my',
  orders: '/my/orders',
  invoices: '/my/invoices',
  addresses: '/my/addresses',
  profile: '/my/account',
  cart: '/shop/cart',
  shop: '/shop',
} as const;

export type PortalTarget = keyof typeof PORTAL_PATHS;

export type CommerceHandoff = {
  mode: 'odoo' | 'shopify-preview';
  addUrl: string;
  /** Local cart review page, or the external commerce cart. */
  cartUrl: string | null;
};

export function commerceHandoff(
  catalog: Catalog,
  shopifyPreview: boolean,
  _hasShopifyCart = false,
): CommerceHandoff {
  if (shopifyPreview && catalog.add_url !== '/api/shopify/cart') {
    throw new Error('shopify preview catalog has an unexpected add endpoint');
  }
  return {
    mode: shopifyPreview ? 'shopify-preview' : 'odoo',
    addUrl: shopifyPreview
      ? catalog.add_url
      : new URL(catalog.add_url, catalog.shop_url).toString(),
    cartUrl: shopifyPreview
      ? '/cart'
      : new URL(catalog.cart_url, catalog.shop_url).toString(),
  };
}

export function shopBase(shopUrl?: string | null): string {
  return (shopUrl || DEFAULT_SHOP_URL).replace(/\/+$/, '');
}

/** An absolute URL into the Odoo portal, e.g. `portalUrl(shop, 'orders')`. */
export function portalUrl(
  shopUrl: string | null | undefined,
  target: PortalTarget,
): string {
  return `${shopBase(shopUrl)}${PORTAL_PATHS[target]}`;
}

/**
 * Customer-account destination for the active commerce backend. Shopify's
 * account URL is configuration supplied by the store; this app does not
 * derive login, order, profile, address or invoice paths.
 */
export function customerAccountUrl(
  env: Pick<Env, 'SHOPIFY_CUSTOMER_ACCOUNT_URL'>,
  shopUrl: string | null | undefined,
  shopifyPreview: boolean,
): string | null {
  if (!shopifyPreview) return portalUrl(shopUrl, 'account');
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
 * The buy hand-off for one or more SKUs: the selected backend's form action
 * plus its fields as a query string. `AddToCartButton` submits it as a POST.
 */
export function buyUrl(
  handoff: CommerceHandoff,
  lines: CartLine[],
  opts?: {next?: string; mode?: 'add' | 'set'},
): string {
  return cartAddUrl(handoff.addUrl, lines, opts);
}
