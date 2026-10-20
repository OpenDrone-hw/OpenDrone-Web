import {redirect} from 'react-router';
import {legacyRedirect} from '~/lib/legacy-urls';

/**
 * Shopify CMS pages: the few that had a counterpart here (contact, shipping, the policies) 301 to it
 * (`app/lib/legacy-urls.ts`); nothing else linked to a page, so any other /pages/* is a plain 404.
 */
export function loader({request}: {request: Request}) {
  const url = new URL(request.url);
  const hit = legacyRedirect(url.pathname, url.search);
  if (hit) throw redirect(hit.to, hit.status);
  throw new Response(null, {status: 404});
}
