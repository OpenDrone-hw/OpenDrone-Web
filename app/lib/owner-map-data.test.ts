import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {loadOwnerMap, ownerMapFixture, refreshOwnerMap, type OwnerMapEnv} from './owner-map-data.ts';
import {META_ATTEMPT, SNAPSHOT_MAX_AGE_MS, type SnapshotRow} from './owner-map.ts';

const NOW = 1_800_000_000_000;

/** Just enough D1 for the two statements this module runs. */
function fakeDb(initial: SnapshotRow[] = []) {
  let rows = [...initial];
  const statement = (sql: string, args: unknown[] = []) => ({
    bind: (...values: unknown[]) => statement(sql, values),
    all: async () => ({results: [...rows]}),
    run: async () => {
      apply(sql, args);
      return {};
    },
  });
  const apply = (sql: string, args: unknown[]) => {
    if (sql.startsWith('DELETE')) rows = rows.filter((r) => r.region === args[0]);
    else if (sql.includes('ON CONFLICT')) {
      rows = rows.filter((r) => r.region !== args[0]);
      rows.push({region: String(args[0]), generated_at: Number(args[1]), bucket: 0});
    } else rows.push({region: String(args[0]), generated_at: Number(args[1]), bucket: Number(args[2])});
  };
  const db = {
    prepare: (sql: string) => statement(sql),
    batch: async (list: Array<{run: () => Promise<unknown>}>) => {
      for (const s of list) await s.run();
      return [];
    },
  };
  return {db: db as unknown as D1Database, rows: () => rows};
}

const order = (id: string, country: string) => ({
  test: false,
  cancelledAt: null,
  displayFinancialStatus: 'PAID',
  email: null,
  customer: {id},
  shippingAddress: {countryCodeV2: country, provinceCode: null},
  lineItems: {nodes: [{requiresShipping: true}]},
});

function shopify(nodes: unknown[]) {
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    return new Response(JSON.stringify({data: {orders: {pageInfo: {hasNextPage: false, endCursor: null}, nodes}}}), {status: 200});
  }) as typeof fetch;
  return {fetcher, calls: () => calls};
}

const credentials = {SHOPIFY_STORE_DOMAIN: 'shop.myshopify.com', SHOPIFY_ADMIN_API_TOKEN: 'shpat_x'};

describe('ownerMapFixture', () => {
  it('is on only for the flag outside a dev server', () => {
    assert.equal(ownerMapFixture({OWNER_MAP_FIXTURE: '1'}), true);
    assert.equal(ownerMapFixture({}), false);
    assert.equal(ownerMapFixture({...credentials, OWNER_MAP_FIXTURE: '0'}), false);
  });
});

describe('loadOwnerMap', () => {
  it('serves the fixture, suppressed, when the flag is set', async () => {
    const snapshot = await loadOwnerMap({OWNER_MAP_FIXTURE: '1'}, NOW);
    assert.ok(snapshot && snapshot.regions.DE === 3);
  });

  it('is null without a database, and never invents numbers', async () => {
    assert.equal(await loadOwnerMap({}, NOW), null);
    assert.equal(await loadOwnerMap({SUPPORT_DB: fakeDb().db}, NOW), null);
  });
});

describe('refreshOwnerMap', () => {
  const nodes = Array.from({length: 7}, (_, i) => order(`c${i}`, 'BE'));

  it('writes a suppressed snapshot and no order data', async () => {
    const {db, rows} = fakeDb();
    const env: OwnerMapEnv = {...credentials, SUPPORT_DB: db};
    assert.equal(await refreshOwnerMap(env, NOW, shopify(nodes).fetcher), 'written');
    const snapshot = await loadOwnerMap(env, NOW);
    assert.deepEqual(snapshot?.regions, {BE: 0});
    assert.equal(snapshot?.generatedAt, NOW);
    assert.ok(rows().every((r) => r.region.startsWith('_') || /^[A-Z]{2}(-[A-Z]+)?$/.test(r.region)));
    assert.ok(!JSON.stringify(rows()).includes('c1'));
  });

  it('leaves a fresh snapshot alone and recomputes a 30 day old one', async () => {
    const {db} = fakeDb();
    const env: OwnerMapEnv = {...credentials, SUPPORT_DB: db};
    const api = shopify(nodes);
    await refreshOwnerMap(env, NOW, api.fetcher);
    assert.equal(await refreshOwnerMap(env, NOW + 1000, api.fetcher), 'fresh');
    assert.equal(api.calls(), 1);
    assert.equal(await refreshOwnerMap(env, NOW + SNAPSHOT_MAX_AGE_MS, api.fetcher), 'written');
    assert.equal(api.calls(), 2);
  });

  it('keeps the old snapshot and waits before retrying after a failure', async () => {
    const {db, rows} = fakeDb();
    const env: OwnerMapEnv = {...credentials, SUPPORT_DB: db};
    await refreshOwnerMap(env, NOW, shopify(nodes).fetcher);
    const failing = (async () => new Response('no', {status: 500})) as typeof fetch;
    const later = NOW + SNAPSHOT_MAX_AGE_MS;
    await assert.rejects(refreshOwnerMap(env, later, failing));
    assert.ok(rows().some((r) => r.region === 'BE'));
    assert.equal(rows().find((r) => r.region === META_ATTEMPT)?.generated_at, later);
    assert.equal(await refreshOwnerMap(env, later + 60_000, shopify(nodes).fetcher), 'waiting');
  });

  it('does nothing without credentials, a database, or in fixture mode', async () => {
    const {db} = fakeDb();
    const api = shopify(nodes);
    assert.equal(await refreshOwnerMap({SUPPORT_DB: db}, NOW, api.fetcher), 'skipped');
    assert.equal(await refreshOwnerMap(credentials, NOW, api.fetcher), 'skipped');
    assert.equal(await refreshOwnerMap({...credentials, SUPPORT_DB: db, OWNER_MAP_FIXTURE: '1'}, NOW, api.fetcher), 'skipped');
    assert.equal(api.calls(), 0);
  });
});
