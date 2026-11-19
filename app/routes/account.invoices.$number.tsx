import type {Route} from './+types/account.invoices.$number';
import {invoiceRoute, requireAppAccounts} from '~/lib/commerce/app-account';
import '../styles/routes/account.css';

/** GET /account/invoices/<order number>: the invoice of the signed-in customer's own order (app mode). */
export function loader({request, context, params}: Route.LoaderArgs) {
  requireAppAccounts(context.env);
  return invoiceRoute(request, context.env, params.number);
}
