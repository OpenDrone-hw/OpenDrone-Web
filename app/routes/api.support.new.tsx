import type {Route} from './+types/api.support.new';
import {handleCreate, jsonOutcome} from '~/lib/support/handlers';

/**
 * POST /api/support/new: the /support form with JavaScript. The same
 * handler as the page's own action, answered as JSON so a failed send
 * never leaves the page (the typed text and chosen files stay).
 */
export async function action({request, context}: Route.ActionArgs) {
  return jsonOutcome(await handleCreate(request, context));
}

export function loader() {
  return new Response('Method Not Allowed', {status: 405, headers: {Allow: 'POST'}});
}
