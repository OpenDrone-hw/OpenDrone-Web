import manifest from 'virtual:editorial-manifest';
import type {Route} from './+types/api.editorial.manifest';
import {handleEditorial} from '~/lib/editorial/api';

/** GET /api/editorial/manifest: the editorial sources of this build. Off unless EDITORIAL_API=1; app credential only. */
export async function loader({request, context}: Route.LoaderArgs) {
  return handleEditorial(request, context.env, manifest);
}
