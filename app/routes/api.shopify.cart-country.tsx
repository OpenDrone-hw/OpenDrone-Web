import {setCartCountry} from '~/lib/shopify-cart-action';
import {handleCartCountry} from '~/lib/shopify-cart-country';
import {CART_KEY} from './api.shopify.cart';
import type {Route} from './+types/api.shopify.cart-country';

/** Put the country picked in the cart on the Shopify cart (see the lib). */
export function action({request, context}: Route.ActionArgs) {
  return handleCartCountry(request, context.env, {
    getCartId: () => context.session.get(CART_KEY) as string | undefined,
    setCountry: (id, code) => setCartCountry(context.env, id, code),
    logError: (message) => console.error('[shopify-cart-country]', message),
  });
}
