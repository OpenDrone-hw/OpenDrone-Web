import type {Route} from './+types/account.reorder';
import {reorderRoute, requireAppAccounts} from '~/lib/commerce/app-account';

/** POST /account/reorder: put a past order's available lines in the cart (app mode). */
export function action({request, context}: Route.ActionArgs) {
  requireAppAccounts(context.env);
  return reorderRoute(request, context.env);
}

export function loader() {
  return new Response('Method Not Allowed', {status: 405, headers: {Allow: 'POST'}});
}
