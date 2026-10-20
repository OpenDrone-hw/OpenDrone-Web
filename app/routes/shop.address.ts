import type {Route} from './+types/shop.address';
import {requireAppCommerce} from '~/lib/commerce/app-api';
import {addressAnswer} from '~/lib/commerce/address-provider';

/** GET /shop/address?q=<text>&country=BE: up to five address suggestions from the configured provider (none: an empty list).
 *  X-Address-Provider always names the provider, how it answered and how many came back. */
export async function loader({context, request}: Route.LoaderArgs) {
  requireAppCommerce(context.env);
  const {suggestions, headers} = await addressAnswer(context.env, new URL(request.url));
  return Response.json({suggestions}, {headers});
}
