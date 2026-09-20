import {addCartLines, createCart, fetchShopifyCatalog, getCart} from '~/lib/shopify-storefront';
import {handleShopifyCartAction, handleShopifyCartLoader} from '~/lib/shopify-cart-action';
import type {Route} from './+types/api.shopify.cart';

const CART_KEY = 'shopifyCartId';

export async function action({request, context}: Route.ActionArgs) {
  return handleShopifyCartAction(request, context.env, {
    fetchCatalog: () => fetchShopifyCatalog(context.env),
    createCart: (lines) => createCart(context.env, lines),
    getCartId: () => context.session.get(CART_KEY) as string | undefined,
    setCartId: (id) => context.session.set(CART_KEY, id),
    unsetCartId: () => context.session.unset(CART_KEY),
    getCart: (id) => getCart(context.env, id),
    addCartLines: (id, lines) => addCartLines(context.env, id, lines),
    logError: (message) => console.error('[shopify-cart] checkout operation failed', message),
  });
}

export function loader({context}: Route.LoaderArgs) {
  return handleShopifyCartLoader(context.env, {
    getCartId: () => context.session.get(CART_KEY) as string | undefined,
    unsetCartId: () => context.session.unset(CART_KEY),
    getCart: (id) => getCart(context.env, id),
    logError: () => console.error('[shopify-cart] cart lookup failed'),
  });
}
