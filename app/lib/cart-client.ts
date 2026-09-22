/**
 * Browser half of add to cart: POST the same form fields the no-JavaScript
 * form sends, ask for the cart summary back instead of the /cart page, and
 * announce the result so the add-to-cart dialog and the header count update
 * without a navigation.
 */
import type {CartSummary} from '~/lib/shopify-cart-action';

export const CART_ADDED_EVENT = 'opendrone:cart-added';
export const CART_UPDATED_EVENT = 'opendrone:cart-updated';

export type CartAddedDetail = {
  summary: CartSummary;
  /** The SKUs this add put in the cart, first one leads the dialog. */
  skus: string[];
  /** Handle of the product the add came from, for recommendations. */
  handle: string | null;
};

export class CartAddError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

/** Post any cart form (add, update, remove) in the background; resolves to
 *  the new cart summary and updates the header count. */
export async function postCart(
  action: string,
  fields: Array<[string, string]>,
): Promise<CartSummary> {
  const body = new URLSearchParams(fields);
  body.set('response', 'summary');
  const response = await fetch(action, {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body,
    credentials: 'same-origin',
  });
  if (!response.ok) {
    throw new CartAddError((await response.text()) || 'Could not add to cart.', response.status);
  }
  const summary = (await response.json()) as CartSummary;
  window.dispatchEvent(
    new CustomEvent(CART_UPDATED_EVENT, {detail: {totalQuantity: summary.totalQuantity}}),
  );
  return summary;
}

/** Add lines in the background; resolves to the new cart summary. */
export const postCartAdd = postCart;

/** The SKUs a set of cart form fields adds (`sku` pairs or `lines`). */
export function skusFromFields(fields: Array<[string, string]>): string[] {
  return fields.flatMap(([name, value]) =>
    name === 'sku'
      ? [value]
      : name === 'lines'
        ? value.split(',').map((part) => part.split(':')[0]).filter(Boolean)
        : [],
  );
}

export function announceCartAdded(detail: CartAddedDetail): void {
  window.dispatchEvent(new CustomEvent(CART_ADDED_EVENT, {detail}));
}

/** The destination a buyer picked in the cart's shipping row, kept in this
 *  browser only so the drawer and the cart agree. Display only: checkout
 *  charges the rate for the address the buyer enters there. */
const SHIP_COUNTRY_KEY = 'opendrone:ship-country';
export const SHIP_COUNTRY_EVENT = 'opendrone:ship-country';

export function storedShipCountry(): string | null {
  try {
    const value = window.localStorage.getItem(SHIP_COUNTRY_KEY);
    return value && /^[A-Z]{2}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function storeShipCountry(country: string): void {
  try {
    window.localStorage.setItem(SHIP_COUNTRY_KEY, country);
  } catch {
    // Private mode or blocked storage: the choice lasts for this page only.
  }
  window.dispatchEvent(new CustomEvent(SHIP_COUNTRY_EVENT, {detail: country}));
}

/** Lines taken out of the cart for a second order: name, quantity and SKU,
 *  so the buyer can add the same quantities back after checkout. Kept in
 *  this browser until they are added back or dismissed. */
export type SplitItem = {
  id: string;
  name: string;
  href: string;
  sku: string | null;
  quantity: number;
};

const SPLIT_KEY = 'opendrone:split-order';
/** A reminder older than this is dropped. */
const SPLIT_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

export function storedSplitItems(): SplitItem[] {
  try {
    const raw = window.localStorage.getItem(SPLIT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as {at?: number; items?: SplitItem[]};
    if (!Array.isArray(parsed.items) || !parsed.at || Date.now() - parsed.at > SPLIT_MAX_AGE_MS) {
      window.localStorage.removeItem(SPLIT_KEY);
      return [];
    }
    return parsed.items.filter(
      (item) =>
        item &&
        typeof item.name === 'string' &&
        typeof item.href === 'string' &&
        item.href.startsWith('/products/') &&
        Number.isSafeInteger(item.quantity) &&
        item.quantity > 0,
    );
  } catch {
    return [];
  }
}

export function storeSplitItems(items: SplitItem[]): void {
  try {
    if (items.length) window.localStorage.setItem(SPLIT_KEY, JSON.stringify({at: Date.now(), items}));
    else window.localStorage.removeItem(SPLIT_KEY);
  } catch {
    // Storage unavailable: the reminder lasts until the page reloads.
  }
}
