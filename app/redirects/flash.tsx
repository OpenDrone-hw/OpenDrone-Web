import {redirect} from 'react-router';
import type {Route} from './+types/flash';
import {flashRedirectTarget} from '~/lib/flash-path';

/**
 * /flash and /en|nl|fr/flash: the web flasher moved under the firmware guides
 * (/guides/flash). Permanent redirect, query string kept. A full document load
 * follows a 301, so the new page gets its USB/serial Permissions-Policy.
 *
 * Lives outside app/routes so flatRoutes does not register it; app/routes.ts
 * mounts it on each path.
 */
export async function loader({request}: Route.LoaderArgs) {
  return redirect(flashRedirectTarget(request.url), 301);
}
