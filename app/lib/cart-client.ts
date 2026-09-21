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
