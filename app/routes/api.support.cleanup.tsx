import type {Route} from './+types/api.support.cleanup';
import {originOf, supportDeps, supportReady} from '~/lib/support/server';
import {cleanupExpired, runScheduled} from '~/lib/support/tickets';
import {constantTimeEqual} from '~/lib/support/tokens';

/**
 * POST /api/support/cleanup with `Authorization: Bearer
 * <SUPPORT_CLEANUP_SECRET>`: deletes tickets closed more than 24 months ago
 * (Discord thread, Shopify entry, stored conversation). `?dry=1` lists them
 * without deleting; `?jobs=1` runs the whole scheduled pass (sync, notices,
 * auto-close, cleanup). The five-minute cron runs the same pass.
 */
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}});

export async function action({request, context}: Route.ActionArgs) {
  const env = context.env;
  const secret = env.SUPPORT_CLEANUP_SECRET;
  const given = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!secret || !given || !constantTimeEqual(given, secret)) return json({ok: false}, 401);
  if (!supportReady(env)) return json({ok: false, error: 'support not configured'}, 503);
  const url = new URL(request.url);
  const deps = supportDeps(env, originOf(request));
  if (url.searchParams.get('jobs') === '1') return json({ok: true, ...(await runScheduled(deps))});
  const refs = await cleanupExpired(deps, {dryRun: url.searchParams.get('dry') === '1', limit: 100});
  return json({ok: true, dryRun: url.searchParams.get('dry') === '1', refs});
}

export function loader() {
  return new Response('Method Not Allowed', {status: 405, headers: {Allow: 'POST'}});
}
