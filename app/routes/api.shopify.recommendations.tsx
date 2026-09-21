import {fetchShopifyComplementaryHandles} from '~/lib/shopify-storefront';
import type {Route} from './+types/api.shopify.recommendations';

export async function loader({request, context}: Route.LoaderArgs) {
  const handle = new URL(request.url).searchParams.get('handle')?.trim() ?? '';
  if (!/^[a-z0-9][a-z0-9-]{0,254}$/.test(handle)) {
    return Response.json({handles: []}, {status: 400});
  }
  const handles = await fetchShopifyComplementaryHandles(context.env, handle).catch(
    () => [],
  );
  return Response.json(
    {handles},
    {headers: {'Cache-Control': 'public, max-age=60, s-maxage=300'}},
  );
}
