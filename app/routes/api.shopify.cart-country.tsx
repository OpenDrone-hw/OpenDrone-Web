import {getCart, updateCartLines} from '~/lib/shopify-storefront';
import {setCartCountry} from '~/lib/shopify-cart-action';
import {handleCartCountry} from '~/lib/shopify-cart-country';
import {CART_KEY} from './api.shopify.cart';
import type {Route} from './+types/api.shopify.cart-country';

/** Put the destination picked in the cart on the Shopify cart and rewrite
 *  its ship promises for that region (see the lib). */
export function action({request, context}: Route.ActionArgs) {
  return handleCartCountry(request, context.env, {
    getCartId: () => context.session.get(CART_KEY) as string | undefined,
    setCountry: (id, code) => setCartCountry(context.env, id, code),
    getCart: (id) => getCart(context.env, id),
    // The region just picked, not the one this request's cookie still names.
    fetchCatalog: (region, country) => context.catalog.forRegion(region, country),
    updateCartLines: (id, lines) => updateCartLines(context.env, id, lines),
    logError: (message) => console.error('[shopify-cart-country]', message),
  });
}
