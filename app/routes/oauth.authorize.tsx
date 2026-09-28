import type {Route} from './+types/oauth.authorize';
import {authorize} from '~/lib/accounts/oauth';

/** GET /oauth/authorize: codes for chatfpv.com (app/lib/accounts/oauth.ts). 404 while ACCOUNTS_ENABLED is off. */
export function loader({request, context}: Route.LoaderArgs) {
  return authorize(request, context.env);
}
