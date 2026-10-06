/**
 * Worker side of the owners map: read the published snapshot from D1, and
 * the scheduled refresh that recomputes it from Shopify orders.
 *
 * Only the suppressed snapshot (`suppress` in owner-map.ts) is written.
 * Orders and addresses live in memory for the length of one refresh.
 *
 * Local development never reads orders: with OWNER_MAP_FIXTURE=1, or on the
 * dev server without Admin credentials, the fixture stands in. A production
 * build without credentials shows nothing rather than invented numbers.
 */
import {adminGraphql, type AdminEnv} from './preorder-fulfilment.ts';
import {
  META_ATTEMPT,
  REFRESH_RETRY_MS,
  fixtureCounts,
  snapshotFromRows,
  snapshotRows,
  snapshotStale,
  suppress,
  tallyOwners,
  type OwnerOrder,
  type Snapshot,
  type SnapshotRow,
} from './owner-map.ts';

export type OwnerMapEnv = AdminEnv & {SUPPORT_DB?: D1Database; OWNER_MAP_FIXTURE?: string};

const PAGE_SIZE = 25;
const MAX_PAGES = 400;
const PAGE_PAUSE_MS = 500;

export const OWNER_ORDERS_QUERY = `#graphql
  query OpenDroneOwnerMap($first: Int!, $after: String, $query: String!) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        test
        cancelledAt
        displayFinancialStatus
        email
        customer { id }
        shippingAddress { countryCodeV2 provinceCode }
        lineItems(first: 10) { nodes { requiresShipping } }
      }
    }
  }
`;

const adminReady = (env: Pick<AdminEnv, 'SHOPIFY_STORE_DOMAIN' | 'SHOPIFY_ADMIN_API_TOKEN'>) =>
  Boolean(env.SHOPIFY_STORE_DOMAIN?.trim() && env.SHOPIFY_ADMIN_API_TOKEN?.trim());

/** True when the map shows the fixture instead of Shopify data. */
export function ownerMapFixture(env: OwnerMapEnv): boolean {
  if (env.OWNER_MAP_FIXTURE === '1') return true;
  return Boolean(import.meta.env?.DEV) && !adminReady(env);
}

/** The snapshot a visitor sees, or null when none has been computed. */
export async function loadOwnerMap(env: OwnerMapEnv, now = Date.now()): Promise<Snapshot | null> {
  if (ownerMapFixture(env)) return suppress(fixtureCounts(), now);
  if (!env.SUPPORT_DB) return null;
  try {
    const {results} = await env.SUPPORT_DB.prepare('SELECT region, generated_at, bucket FROM owner_map_snapshot').all<SnapshotRow>();
    return snapshotFromRows(results ?? []);
  } catch (error) {
    console.error('owner map read failed', error instanceof Error ? error.message : 'error');
    return null;
  }
}

async function fetchOwnerOrders(env: AdminEnv, fetcher: typeof fetch): Promise<OwnerOrder[]> {
  const orders: OwnerOrder[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data: {orders: {pageInfo: {hasNextPage: boolean; endCursor: string | null}; nodes: OwnerOrder[]}} = await adminGraphql(
      env,
      OWNER_ORDERS_QUERY,
      {first: PAGE_SIZE, after, query: 'financial_status:paid OR financial_status:partially_refunded'},
      fetcher,
    );
    orders.push(...data.orders.nodes);
    if (!data.orders.pageInfo.hasNextPage) return orders;
    after = data.orders.pageInfo.endCursor;
    if (!after) throw new Error('owner map: pagination cursor is missing');
    // Shopify's query cost bucket refills slowly; stay under it.
    await new Promise((resolve) => setTimeout(resolve, PAGE_PAUSE_MS));
  }
  throw new Error('owner map: more orders than the page limit');
}

export type RefreshResult = 'skipped' | 'fresh' | 'waiting' | 'written';

/**
 * Scheduled: recompute the snapshot when it is missing or 30 days old.
 * A failure keeps the old snapshot and waits REFRESH_RETRY_MS before the
 * next try, so the five-minute cron does not hammer Shopify.
 */
export async function refreshOwnerMap(
  env: OwnerMapEnv,
  now = Date.now(),
  fetcher: typeof fetch = fetch,
): Promise<RefreshResult> {
  const db = env.SUPPORT_DB;
  if (!db || ownerMapFixture(env) || !adminReady(env)) return 'skipped';

  const {results} = await db.prepare('SELECT region, generated_at, bucket FROM owner_map_snapshot').all<SnapshotRow>();
  const rows = results ?? [];
  if (!snapshotStale(snapshotFromRows(rows), now)) return 'fresh';
  const attempt = rows.find((r) => r.region === META_ATTEMPT);
  if (attempt && now - attempt.generated_at < REFRESH_RETRY_MS) return 'waiting';

  await db
    .prepare('INSERT INTO owner_map_snapshot (region, generated_at, bucket) VALUES (?, ?, 0) ON CONFLICT (region) DO UPDATE SET generated_at = excluded.generated_at')
    .bind(META_ATTEMPT, now)
    .run();
  const snapshot = suppress(tallyOwners(await fetchOwnerOrders(env, fetcher)), now);
  await db.batch([
    db.prepare('DELETE FROM owner_map_snapshot WHERE region != ?').bind(META_ATTEMPT),
    ...snapshotRows(snapshot).map((row) =>
      db.prepare('INSERT INTO owner_map_snapshot (region, generated_at, bucket) VALUES (?, ?, ?)').bind(row.region, row.generated_at, row.bucket),
    ),
  ]);
  return 'written';
}
