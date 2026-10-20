import {redirect} from 'react-router';
import type {Route} from './+types/account.addresses';
import {addressRoute, requireAppAccounts} from '~/lib/commerce/app-account';

/** The addresses are a section of My account. */
export function loader({context}: Route.LoaderArgs) {
  requireAppAccounts(context.env);
  throw redirect('/account#addresses');
}

export async function action({request, context}: Route.ActionArgs) {
  requireAppAccounts(context.env);
  return addressRoute(request, context.env);
}
