import {redirect} from 'react-router';
import type {Route} from './+types/account.privacy';
import {requireAppAccounts} from '~/lib/commerce/app-account';
import {erasureRoute} from '~/lib/commerce/app-account-manage';

/** POST /account/privacy (app mode): ask to have the account's data deleted. */
export async function action({request, context}: Route.ActionArgs) {
  requireAppAccounts(context.env);
  return erasureRoute(request, context.env);
}

/** Privacy is a section of My account. */
export function loader({context}: Route.LoaderArgs) {
  requireAppAccounts(context.env);
  throw redirect('/account#privacy');
}
