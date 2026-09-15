/**
 * Links into the Odoo shop: the buy hand-off and the customer portal.
 *
 * Odoo owns cart, checkout, orders, invoices, addresses and accounts
 * (contract sections 3 and 4). Everything the storefront needs to point
 * at one of those lives here, so the base URL is read in one place.
 *
 * Bundler-free (relative imports) so the node:test suites can load it.
 */

import {cartAddUrl, type CartLine} from './catalog.ts';

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
 * The buy hand-off for one or more SKUs: the form action plus its fields as
 * a query string. `AddToCartButton` submits it as a POST; the shop adds the
 * lines to the visitor's own Odoo cart and redirects them to it.
 */
export function buyUrl(
  shopUrl: string | null | undefined,
  lines: CartLine[],
  opts?: {next?: string; mode?: 'add' | 'set'},
): string {
  return cartAddUrl(`${shopBase(shopUrl)}/incutec/add`, lines, opts);
}
