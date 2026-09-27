import type {Route} from './+types/oauth.logout';
import {identityProvider} from '~/lib/accounts/idp';
import {oauthLogout} from '~/lib/accounts/oauth';

/** GET /oauth/logout?post_logout_redirect_uri=<allowlisted>: sign-out started on chatfpv.com. */
export function loader({request, context}: Route.LoaderArgs) {
  const {env} = context;
  return oauthLogout(request, env, identityProvider(env, request));
}
