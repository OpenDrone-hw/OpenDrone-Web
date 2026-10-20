import {redirect} from 'react-router';
import type {Route} from './+types/account.preferences';
import {requireAppAccounts} from '~/lib/commerce/app-account';
import {preferencesRoute} from '~/lib/commerce/app-account-manage';

/** POST /account/preferences (app mode): the marketing choice. */
export async function action({request, context}: Route.ActionArgs) {
  requireAppAccounts(context.env);
  return preferencesRoute(request, context.env);
}

/** Preferences are a section of My account. */
export function loader({context}: Route.LoaderArgs) {
  requireAppAccounts(context.env);
  throw redirect('/account#preferences');
}
