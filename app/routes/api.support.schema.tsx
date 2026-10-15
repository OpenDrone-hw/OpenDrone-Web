import type {Route} from './+types/api.support.schema';

/**
 * GET /api/support/schema: the names of the D1 migrations applied to SUPPORT_DB,
 * from wrangler's own `d1_migrations` table. Names only, no ticket data. The
 * deploy workflow (scripts/d1-migrations.sh) compares it with `migrations/` when
 * its Cloudflare token cannot read D1, so a deploy fails before it ships code
 * whose tables are missing.
 */
export async function loader({context}: Route.LoaderArgs) {
  const headers = {'Content-Type': 'application/json', 'Cache-Control': 'no-store'};
  const db = context.env.SUPPORT_DB;
  if (!db) return new Response(JSON.stringify({ok: false, error: 'not_configured'}), {status: 503, headers});
  try {
    const {results} = await db.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{name: string}>();
    return new Response(JSON.stringify({ok: true, migrations: results.map((r) => r.name)}), {headers});
  } catch {
    return new Response(JSON.stringify({ok: false, error: 'unreadable'}), {status: 503, headers});
  }
}
