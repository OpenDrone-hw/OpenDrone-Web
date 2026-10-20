import type {Route} from './+types/api.account.widget-assertion';
import {widgetAssertion} from '~/lib/accounts/assertion';
import {appAccountsEnabled} from '~/lib/commerce/app-account';
import {appWidgetAssertion} from '~/lib/commerce/app-chatfpv';

/** GET /api/account/widget-assertion: 5-minute widget assertion, 204 signed out, 404 while ACCOUNTS_ENABLED is off. */
export function loader({request, context}: Route.LoaderArgs) {
  if (appAccountsEnabled(context.env)) return appWidgetAssertion(request, context.env);
  return widgetAssertion(request, context.env);
}
