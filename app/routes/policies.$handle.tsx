import {redirect} from 'react-router';
import type {Route} from './+types/policies.$handle';

/**
 * Shopify-hosted policy pages are not compliant with our legal stack
 * (WER Book VI, 2023 CPC action). The storefront owns all legal copy under
 * dedicated routes. Keep this path alive - Shopify and older sitemaps may
 * still link to `/policies/*` - but redirect to the Incutec-owned pages.
 */
const REDIRECT_MAP: Record<string, string> = {
  'privacy-policy': '/privacy',
  'terms-of-service': '/algemene-voorwaarden',
  'terms-of-sale': '/algemene-voorwaarden',
  'refund-policy': '/herroepingsrecht',
  'shipping-policy': '/shipping',
  'subscription-policy': '/algemene-voorwaarden',
};

export async function loader({params}: Route.LoaderArgs) {
  const target = params.handle ? REDIRECT_MAP[params.handle] : undefined;
  if (target) throw redirect(target, 308);
  throw redirect('/legal', 308);
}

export default function Policy() {
  return null;
}
