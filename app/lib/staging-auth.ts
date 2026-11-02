/**
 * HTTP basic auth of the staging Worker (server.ts stagingGate): user
 * `opendrone`, password STAGING_PASSWORD (a secret or .dev.vars, never
 * committed). One implementation, so the site gate and the staging firmware
 * route (app/lib/flasher/staging-serve.ts) check exactly the same thing.
 */

export const STAGING_AUTH_USER = 'opendrone';

/** True when `header` is `Basic base64(opendrone:<password>)`. A malformed header is false. */
export function stagingCredentialsOk(header: string | null, password: string): boolean {
  if (!password || !header?.startsWith('Basic ')) return false;
  try {
    const [user, given] = atob(header.slice(6)).split(':');
    return user === STAGING_AUTH_USER && given === password;
  } catch {
    return false;
  }
}

/** The 401 that asks the browser for the staging credentials (same realm everywhere, so one login covers every path). */
export function stagingChallenge(): Response {
  return new Response('Staging', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="OpenDrone staging", charset="UTF-8"',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}
