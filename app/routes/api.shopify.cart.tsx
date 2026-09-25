import {addCartLines, createCart, getCart, removeCartLines, updateCartLines} from '~/lib/shopify-storefront';
import {
  createCartInCountry,
  handleShopifyCartAction,
  handleShopifyCartLoader,
  setCartCountry,
} from '~/lib/shopify-cart-action';
import type {Route} from './+types/api.shopify.cart';

export const CART_KEY = 'shopifyCartId';

export async function action({request, context}: Route.ActionArgs) {
  return handleShopifyCartAction(request, context.env, {
    // The campaign-aware catalog: the same ship promise the page showed,
    // and campaign SKUs closed when paid counts cannot be verified.
    fetchCatalog: () => context.catalog.get(),
    // The visitor's country goes on the cart, so checkout opens in that
    // market (shipping rate, VAT treatment) instead of the primary one.
    createCart: (lines, countryCode) =>
      createCartInCountry(lines, countryCode, {
        create: (l) => createCart(context.env, l),
        setCountry: (id, code) => setCartCountry(context.env, id, code),
        getCart: (id) => getCart(context.env, id),
        logError: (message) => console.error('[shopify-cart]', message),
      }),
    getCartId: () => context.session.get(CART_KEY) as string | undefined,
    setCartId: (id) => context.session.set(CART_KEY, id),
    unsetCartId: () => context.session.unset(CART_KEY),
    getCart: (id) => getCart(context.env, id),
    addCartLines: (id, lines) => addCartLines(context.env, id, lines),
    updateCartLines: (id, lines) => updateCartLines(context.env, id, lines),
    removeCartLines: (id, lineIds) => removeCartLines(context.env, id, lineIds),
    logError: (message) => console.error('[shopify-cart] cart operation failed', message),
  });
}

export function loader({request, context}: Route.LoaderArgs) {
  return handleShopifyCartLoader(request, context.env, {
    getCartId: () => context.session.get(CART_KEY) as string | undefined,
    unsetCartId: () => context.session.unset(CART_KEY),
    getCart: (id) => getCart(context.env, id),
    logError: (message) => console.error('[shopify-cart] cart read failed', message),
  });
}
