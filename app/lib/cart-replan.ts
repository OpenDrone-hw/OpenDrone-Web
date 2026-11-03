/**
 * The cart page's server leg after a Ship to switch, without the second
 * Shopify catalog read.
 *
 * A switch posts to /api/shopify/cart-country, which moves the cart to the
 * country and re-plans its lines on a fresh catalog. React Router then reads
 * the cart loader again, and its `replanCart` used to read that catalog from
 * Shopify a second time (the default and destination markets) before the
 * page could show the new country.
 *
 * The POST now leaves a marker, `od_cart_replanned=<COUNTRY>.<cart tag>`
 * (HttpOnly, 15 s), and its fresh catalog read is kept in the per-isolate memo
 * (catalog-client `fresh` writes through). A cart loader that sees the marker
 * for the country it is planning and for this cart, on a cart that already
 * carries that country, re-plans on the catalog read for that switch moments ago
 * (`recent`, memo no older than REPLAN_REUSE_MS, else a fresh read).
 * `replanCart` itself is unchanged: the lines are still re-derived, a stale
 * promise is still rewritten, and checkout still re-derives every line on a
 * fresh catalog before payment. Paid-batch counts were already a minute-long
 * memo (`paidUnitRuns`) on either path, so stock counts are as accurate as
 * before. Payment methods are read alongside the re-plan instead of after it.
 *
 * Bundler-free (relative imports) so the node:test suites can load it.
 */
import type {Catalog} from './catalog.ts';
import {REPLAN_REUSE_MS} from './catalog-memo.ts';
import type {Region} from './preorder-campaign.ts';
import type {ShippingQuote} from './shipping-rates.ts';
import {replanCart, type CartReplanChange} from './shopify-cart-action.ts';
import type {CartLineUpdate, ShopifyCart} from './shopify-storefront.ts';

export {REPLAN_REUSE_MS};
export const CART_REPLANNED_COOKIE = 'od_cart_replanned';

/** A short, stable tag of a cart id (FNV-1a, 8 hex): binds the marker to
 *  the cart it was set for without putting the id in a cookie. */
export function cartTag(cartId: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < cartId.length; i += 1) {
    hash ^= cartId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** The switch marker: the country the cart was re-planned for and its cart. */
export type SwitchMarker = {country: string; cart: string};

/** The Set-Cookie the country POST adds after re-planning cart `cartId` for `country`. */
export function cartReplannedCookie(country: string, cartId: string, secure = true): string {
  return `${CART_REPLANNED_COOKIE}=${country.trim().toUpperCase()}.${cartTag(cartId)}; Path=/; Max-Age=${REPLAN_REUSE_MS / 1000}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/** The marker a switch just left, from a Cookie header, or null. */
export function cartReplannedFor(cookieHeader: string | null | undefined): SwitchMarker | null {
  for (const part of (cookieHeader ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== CART_REPLANNED_COOKIE) continue;
    const match = /^([A-Z]{2})\.([0-9a-f]{8})$/.exec(part.slice(eq + 1).trim());
    return match ? {country: match[1], cart: match[2]} : null;
  }
  return null;
}

/** True when the loader may re-plan on the switch's catalog: the marker was
 *  set for this cart and names the destination being planned, and the cart
 *  already carries that country. */
export function reuseSwitchCatalog(
  marker: SwitchMarker | null,
  destination: ShippingQuote | null,
  cart: Pick<ShopifyCart, 'country' | 'id'>,
): boolean {
  return Boolean(
    marker &&
      marker.cart === cartTag(cart.id) &&
      destination?.kind === 'direct' &&
      destination.country === marker.country &&
      cart.country === marker.country,
  );
}

export type CartPlanDependencies = {
  /** Shopify, every time. */
  fresh: (region: Region, country?: string) => Promise<Catalog>;
  /** The memo of a read no older than REPLAN_REUSE_MS, else Shopify. */
  recent: (region: Region, country?: string) => Promise<Catalog>;
  setCountry?: (cartId: string, countryCode: string) => Promise<void>;
  getCart?: (cartId: string) => Promise<ShopifyCart | null>;
  updateCartLines?: (cartId: string, lines: CartLineUpdate[]) => Promise<ShopifyCart>;
  fetchPaymentMethods: () => Promise<string[]>;
  euStockKnown?: boolean;
  logError?: (message: string, error: unknown) => void;
};

export type CartPlan = {
  cart: ShopifyCart;
  catalog: Catalog | null;
  change: CartReplanChange;
  payments: string[];
  /** True when the switch's catalog was reused (no second Shopify read). */
  reused: boolean;
};

/** Re-plan the cart for `destination` and read the payment methods, together. */
export async function planCartPage(
  cart: ShopifyCart,
  destination: ShippingQuote | null,
  env: Parameters<typeof replanCart>[2],
  marker: SwitchMarker | null,
  dependencies: CartPlanDependencies,
): Promise<CartPlan> {
  const reused = reuseSwitchCatalog(marker, destination, cart);
  const replan = replanCart(cart, destination, env, {
    fetchCatalog: reused ? dependencies.recent : dependencies.fresh,
    setCountry: dependencies.setCountry,
    getCart: dependencies.getCart,
    updateCartLines: dependencies.updateCartLines,
    euStockKnown: dependencies.euStockKnown,
  }).catch((error: unknown) => {
    dependencies.logError?.('cart replan failed', error);
    return {cart, catalog: null, change: null};
  });
  const payments = dependencies.fetchPaymentMethods().catch((error: unknown) => {
    dependencies.logError?.('payment settings read failed', error);
    return [] as string[];
  });
  const [plan, methods] = await Promise.all([replan, payments]);
  return {...plan, payments: methods, reused};
}
