import {redirect} from 'react-router';
import {legacyRedirect} from '~/lib/legacy-urls';

/**
 * Collections were a Shopify concept (rules and table: `app/lib/legacy-urls.ts`). /collections and an old category
 * collection 301 to the listing, filtered to the family when there is one; /collections/<c>/products/<handle> 301s to
 * the product.
 */
export function loader({request}: {request: Request}) {
  const url = new URL(request.url);
  throw redirect(legacyRedirect(url.pathname, url.search)?.to ?? '/products', 301);
}
