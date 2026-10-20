import {redirect} from 'react-router';
import type {Route} from './+types/policies.$handle';
import {legacyRedirect} from '~/lib/legacy-urls';

/**
 * Shopify-hosted policy pages are not compliant with our legal stack
 * (WER Book VI, 2023 CPC action). The storefront owns all legal copy under
 * dedicated routes. Keep this path alive - Shopify and older sitemaps may
 * still link to `/policies/*` - but redirect to the Incutec-owned pages
 * (table: `app/lib/legacy-urls.ts`).
 */
export async function loader({request}: Route.LoaderArgs) {
  const url = new URL(request.url);
  const hit = legacyRedirect(url.pathname, url.search);
  throw redirect(hit?.to ?? '/legal', hit?.status ?? 308);
}

export default function Policy() {
  return null;
}
