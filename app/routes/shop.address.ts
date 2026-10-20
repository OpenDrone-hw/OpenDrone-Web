import type {Route} from './+types/shop.address';
import {requireAppCommerce} from '~/lib/commerce/app-api';
import {addressProvider, cleanQuery} from '~/lib/commerce/address-provider';

/** GET /shop/address?q=<text>&country=BE: up to five street suggestions from the configured provider (none: an empty list). */
export async function loader({context, request}: Route.LoaderArgs) {
  requireAppCommerce(context.env);
  const url = new URL(request.url);
  const q = cleanQuery(url.searchParams.get('q'));
  const country = (url.searchParams.get('country') ?? '').toUpperCase();
  const provider = addressProvider(context.env);
  const suggestions = q && /^[A-Z]{2}$/.test(country) ? await provider.suggest(q, country) : [];
  return Response.json({suggestions}, {headers: {'Cache-Control': 'private, max-age=300', 'X-Robots-Tag': 'noindex'}});
}
