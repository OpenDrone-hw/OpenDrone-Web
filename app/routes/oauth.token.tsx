import type {Route} from './+types/oauth.token';
import {notFound} from '~/lib/accounts/config';
import {token} from '~/lib/accounts/oauth';

/**
 * POST /oauth/token: service binding only (404 on the public host), except
 * while the test IdP rule is active on a staging host (app/lib/accounts/oauth.ts).
 */
export function action({request, context}: Route.ActionArgs) {
  return token(request, context.env);
}

export function loader() {
  return notFound();
}
