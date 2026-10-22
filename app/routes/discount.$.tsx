import {redirect} from 'react-router';
import type {Route} from './+types/discount.$';
import {appCommerceEnabled} from '~/lib/commerce/app-api';
import {readOptions, writeOptions} from '~/lib/commerce/app-cart-options';
import {discountLink} from '~/lib/commerce/discount-link';

/**
 * A shared discount link. In Shopify mode codes are entered in Shopify checkout, so the link only leads to the shop. In app
 * mode (COMMERCE_SOURCE=app) the code is put in the cart, where the app's quote applies it or says why not.
 */
export async function loader({request, context}: Route.LoaderArgs) {
  if (!appCommerceEnabled(context.env)) throw redirect('/products', 301);
  const {code, to} = discountLink(new URL(request.url));
  if (!code) throw redirect(to, 302);
  const options = await readOptions(request, context.env);
  throw redirect(to, {status: 302, headers: {'Set-Cookie': await writeOptions({...options, code}, context.env), 'Cache-Control': 'no-store'}});
}
