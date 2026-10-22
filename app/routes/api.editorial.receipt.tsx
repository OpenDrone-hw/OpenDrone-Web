import manifest from 'virtual:editorial-manifest';
import type {Route} from './+types/api.editorial.receipt';
import {handleEditorial} from '~/lib/editorial/api';

/** GET /api/editorial/receipt: the publication receipt of this deployment. Off unless EDITORIAL_API=1; app credential only. */
export async function loader({request, context}: Route.LoaderArgs) {
  return handleEditorial(request, context.env, manifest);
}
