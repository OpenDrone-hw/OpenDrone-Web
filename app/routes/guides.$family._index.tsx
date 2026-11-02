import {redirect} from 'react-router';
import type {Route} from './+types/guides.$family._index';
import {findFamily, guidePath} from '~/lib/guides';

/**
 * /guides/<family> has no page of its own: a reader who trims the URL lands on
 * the family's first step rather than a 404.
 */
export async function loader({params}: Route.LoaderArgs) {
  const family = findFamily(params.family ?? '');
  if (!family) throw new Response('Not Found', {status: 404});
  return redirect(guidePath(family.id, family.pages[0].slug), 301);
}
