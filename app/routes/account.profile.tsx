import {redirect} from 'react-router';
import type {Route} from './+types/account.profile';
import {requireAppAccounts} from '~/lib/commerce/app-account';
import {profileRoute} from '~/lib/commerce/app-account-manage';

/** POST /account/profile (app mode): save the name, or change the email address with a code to the new one. */
export async function action({request, context}: Route.ActionArgs) {
  requireAppAccounts(context.env);
  return profileRoute(request, context.env);
}

/** The profile is a section of My account. */
export function loader({context}: Route.LoaderArgs) {
  requireAppAccounts(context.env);
  throw redirect('/account#profile');
}
