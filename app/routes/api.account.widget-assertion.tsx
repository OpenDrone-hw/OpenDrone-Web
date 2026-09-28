import type {Route} from './+types/api.account.widget-assertion';
import {widgetAssertion} from '~/lib/accounts/assertion';

/** GET /api/account/widget-assertion: 5-minute widget assertion, 204 signed out, 404 while ACCOUNTS_ENABLED is off. */
export function loader({request, context}: Route.LoaderArgs) {
  return widgetAssertion(request, context.env);
}
