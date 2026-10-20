import type {Route} from './+types/shop.address';
import {requireAppCommerce} from '~/lib/commerce/app-api';
import {addressProvider, cleanQuery, lastProviderStatus} from '~/lib/commerce/address-provider';

/** GET /shop/address?q=<text>&country=BE: up to five street suggestions from the configured provider (none: an empty list). */
export async function loader({context, request}: Route.LoaderArgs) {
  requireAppCommerce(context.env);
  const url = new URL(request.url);
  const q = cleanQuery(url.searchParams.get('q'));
  const country = (url.searchParams.get('country') ?? '').toUpperCase();
  const provider = addressProvider(context.env);
  const suggestions = q && /^[A-Z]{2}$/.test(country) ? await provider.suggest(q, country) : [];
  // A refused or failed lookup is also an empty list for the buyer (they type the address); the header tells it apart.
  const status = suggestions.length ? '' : lastProviderStatus();
  const headers: Record<string, string> = {'Cache-Control': suggestions.length ? 'private, max-age=300' : 'no-store', 'X-Robots-Tag': 'noindex'};
  if (status) headers['X-Address-Provider'] = `${provider.id} ${status}`;
  return Response.json({suggestions}, {headers});
}
