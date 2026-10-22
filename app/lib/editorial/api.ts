/**
 * GET /api/editorial/manifest and GET /api/editorial/receipt: read-only evidence of the running build for the
 * company app (incutec-app docs/storefront-chatfpv.md, capabilities `editorial.manifest` v1 and
 * `publication.receipt` v1). Publishing stays a person's click (a GitHub merge or the Worker deploy); these only
 * say what is live.
 *
 * Off (404) unless EDITORIAL_API is "1". Authenticated like the staff API: the app's bearer token compared in
 * constant time, plus the Cloudflare Access JWT when Access is configured (staff-auth.ts). Never public.
 */
import {authenticateStaff, type StaffAuthEnv} from '../support/staff-auth.ts';
import type {EditorialManifest} from './manifest.ts';

export type EditorialEnv = StaffAuthEnv & {
  EDITORIAL_API?: string;
  /** Workers version metadata binding (wrangler `[version_metadata]`). */
  CF_VERSION_METADATA?: {id?: string; tag?: string; timestamp?: string};
};

export const editorialEnabled = (env: {EDITORIAL_API?: string}): boolean => env.EDITORIAL_API === '1';

const PROVIDER = 'storefront';
const CAPABILITIES = [
  {name: 'editorial.manifest', version: 1},
  {name: 'publication.receipt', version: 1},
];

const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra}});

/** The contract's Runtime: provider, the deployed version and the capabilities this deployment offers. */
function runtime(m: EditorialManifest) {
  return {schema_version: 1, provider: PROVIDER, runtime_version: m.build.commit ?? 'unknown', capabilities: CAPABILITIES};
}

export function manifestBody(m: EditorialManifest) {
  return {
    schema_version: 1,
    runtime: runtime(m),
    capability: 'editorial.manifest',
    audience: 'public',
    // One complete page: the manifest is small and listed in full.
    snapshot: m.manifest_hash,
    cursor: null,
    next_cursor: null,
    completeness: m.completeness,
    items: m.items.map((i) => ({
      ref: {provider: PROVIDER, kind: i.kind, id: i.path},
      revision: i.sha256,
      audience: 'public',
    })),
    manifest: m,
  };
}

export function receiptBody(m: EditorialManifest, env: EditorialEnv) {
  const v = env.CF_VERSION_METADATA;
  return {
    schema_version: 1,
    runtime: runtime(m),
    capability: 'publication.receipt',
    deployed_revision: m.build.commit,
    // The readback evidence: the hash of the source bytes this deployment renders.
    verification_ref: m.manifest_hash,
    manifest_hash: m.manifest_hash,
    build_time: m.build.built_at,
    deployed_at: v?.timestamp ?? null,
    worker_version_id: v?.id ?? null,
    item_count: m.items.length,
  };
}

export async function handleEditorial(
  request: Request,
  env: EditorialEnv,
  manifest: EditorialManifest,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  if (!editorialEnabled(env)) return new Response('Not found', {status: 404, headers: {'Cache-Control': 'no-store'}});
  if (request.method !== 'GET' && request.method !== 'HEAD') return json(405, {ok: false, error: 'method_not_allowed'}, {Allow: 'GET, HEAD'});
  const auth = await authenticateStaff(request, env, fetcher);
  if (!auth.ok) return json(auth.status, {ok: false, error: auth.error}, auth.status === 401 ? {'WWW-Authenticate': 'Bearer'} : {});
  const name = new URL(request.url).pathname.replace(/\/+$/, '').split('/').pop();
  if (name === 'manifest') return json(200, manifestBody(manifest));
  if (name === 'receipt') return json(200, receiptBody(manifest, env));
  return json(404, {ok: false, error: 'not_found'});
}
