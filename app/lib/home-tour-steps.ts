import studio from '../../public/models/od3/studio.json';
import {tourStillId, tourSteps} from '~/lib/home-tour';
import {assetUrl} from '~/lib/asset-url';

/**
 * The walkthrough's steps, bundled for the server render and the phone
 * layout. The 3D scene reads the same file at runtime; both go through
 * tourSteps, so the words come from studio.json alone.
 */
export const HOME_TOUR_STEPS = tourSteps(studio.beats);

// /public is served with a long max-age and these files are not
// content-hashed, so the URL carries the deployment's base as a build id,
// the same one the 3D scene puts on studio.json.
const V = encodeURIComponent(
  (import.meta.env.BASE_URL || '/').replace(/[^a-z0-9]/gi, '').slice(-24) || 'dev',
);

/** The phone walkthrough's still of one step, written by
 *  `npm run gen:tour-stills` (scripts/capture-tour-stills.mjs). */
export function tourStillUrl(id: string): string {
  return assetUrl(`/models/od3/tour/${tourStillId(id)}.webp?v=${V}`);
}
