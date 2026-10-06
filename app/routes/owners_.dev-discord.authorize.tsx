import type {Route} from './+types/owners_.dev-discord.authorize';
import {notFound} from '~/lib/accounts/config';

/**
 * The fake Discord authorize screen for local development. 404 in every
 * deployed build: the dev module is imported only behind
 * `import.meta.env.DEV`, which a production build folds to `false`.
 */
export async function loader({request}: Route.LoaderArgs) {
  if (import.meta.env.DEV) {
    const {devAuthorizePage} = await import('~/lib/pilot-map-dev');
    return devAuthorizePage(new URL(request.url));
  }
  return notFound();
}

export async function action({request, context}: Route.ActionArgs) {
  if (import.meta.env.DEV) {
    const {devAuthorizeSubmit} = await import('~/lib/pilot-map-dev');
    return devAuthorizeSubmit(request, context.env);
  }
  return notFound();
}
