/**
 * Staging bench firmware files (review 3, F1 + F2). The unreleased bench
 * binaries are NEVER static assets: they are not in public/ and never in a
 * build output. A bench Worker reads them from a local-only R2 binding
 * (FIRMWARE_STAGING, declared only in wrangler.bench.toml) and serves them at
 * /firmware-staging/<file> behind the same basic auth as the staging site.
 *
 * The route exists only when ALL hold (else the files cannot be fetched):
 *   - the build was made with VITE_FLASH_STAGING_GATES=1 (server.ts calls
 *     this only then; in a production build the call is dead code);
 *   - the FIRMWARE_STAGING binding exists (wrangler.bench.toml only; never
 *     wrangler.toml or wrangler.production.toml);
 *   - STAGING_PASSWORD is set (no password = no files, fail-closed).
 * Missing binding or password: 404. Wrong or no credentials: 401.
 *
 * The build guard (vite.config.ts) fails `react-router build` if the old
 * public/firmware-staging/ folder exists, or if any build output contains a
 * firmware-staging folder. Pure module: runs under `node --test`.
 */

import {stagingChallenge, stagingCredentialsOk} from '../staging-auth.ts';

export const STAGING_FIRMWARE_PREFIX = '/firmware-staging/';

/** Same plain-file-name rule as isStagingFirmwareUrl (manifest.ts): no dot segments, no nesting, no encodings. */
const FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/** The part of an R2 bucket the route uses (structurally an R2Bucket). */
export type StagingFirmwareStore = {get(key: string): Promise<{body: ReadableStream; size: number} | null>};

export type StagingFirmwareEnv = {
  /** STAGING_PASSWORD; unset or blank = no files. */
  password: string | undefined;
  /** The FIRMWARE_STAGING binding; absent = no files. */
  store: StagingFirmwareStore | undefined;
};

function notFound(): Response {
  return new Response('Not found', {status: 404, headers: {'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow'}});
}

/** null = not a /firmware-staging path (the request goes on to the site). Otherwise the full answer. */
export async function handleStagingFirmware(request: Request, env: StagingFirmwareEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/firmware-staging' && !url.pathname.startsWith(STAGING_FIRMWARE_PREFIX)) return null;
  const password = env.password?.trim();
  if (!env.store || !password) return notFound();
  if (!stagingCredentialsOk(request.headers.get('Authorization'), password)) return stagingChallenge();
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', {status: 405, headers: {Allow: 'GET, HEAD', 'Cache-Control': 'no-store'}});
  }
  const name = url.pathname.slice(STAGING_FIRMWARE_PREFIX.length);
  if (url.search || !FILE_NAME_RE.test(name)) return notFound();
  const obj = await env.store.get(name);
  if (!obj) return notFound();
  return new Response(request.method === 'HEAD' ? null : obj.body, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(obj.size),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}

/** Source paths that must not exist when building (relative to the project root): Vite would copy them into dist/client. */
export const FIRMWARE_STAGING_FORBIDDEN_SOURCES: readonly string[] = ['public/firmware-staging'];
/** Output paths that must not exist after a build. */
export const FIRMWARE_STAGING_FORBIDDEN_OUTPUTS: readonly string[] = ['dist/client/firmware-staging', 'build/client/firmware-staging'];

/** F2 build guard: an error message when any forbidden path exists, else null. */
export function firmwareStagingBuildProblem(exists: (relPath: string) => boolean, paths: readonly string[]): string | null {
  const found = paths.filter((p) => exists(p));
  if (!found.length) return null;
  return (
    `Refusing to build: ${found.join(', ')} exists. Unreleased bench firmware must never reach a deployable build. ` +
    'Delete the folder; bench files live in .firmware-staging/ and are served only by the bench Worker (wrangler.bench.toml).'
  );
}
