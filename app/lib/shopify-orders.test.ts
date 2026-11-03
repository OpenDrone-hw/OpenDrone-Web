import assert from 'node:assert/strict';
import {afterEach, describe, it} from 'node:test';
import {campaignState, parseCampaignConfig, type UnitRuns} from './preorder-campaign.ts';
import {PAID_ORDERS_QUERY, fetchPaidUnitRuns, fetchPaidUnits, paidUnitRuns, paidUnits, resetPaidUnitsMemo} from './shopify-orders.ts';

afterEach(resetPaidUnitsMemo);

const ENV = {
  SHOPIFY_STORE_DOMAIN: 'store.myshopify.com',
  SHOPIFY_ADMIN_API_TOKEN: 'token',
  SHOPIFY_ADMIN_API_VERSION: '2026-07',
};
const SKUS = new Set(['OPENESC-2020', 'OPENFRAME-5']);

type Order = {
  test?: boolean;
  cancelledAt?: string | null;
  displayFinancialStatus: string;
  lines: Array<[string | null, number]>;
  more?: boolean;
  country?: string;
  /** Line attributes as the cart wrote them, for every line. */
  attrs?: Array<{key: string; value: string}>;
};

function page(orders: Order[], next: string | null = null): Response {
  return Response.json({
    data: {
      orders: {
        pageInfo: {hasNextPage: next !== null, endCursor: next},
        nodes: orders.map((o) => ({
          test: o.test ?? false,
          cancelledAt: o.cancelledAt ?? null,
          displayFinancialStatus: o.displayFinancialStatus,
          shippingAddress: o.country ? {countryCodeV2: o.country} : null,
          lineItems: {
            pageInfo: {hasNextPage: o.more ?? false},
            nodes: o.lines.map(([sku, currentQuantity]) => ({sku, currentQuantity, ...(o.attrs ? {customAttributes: o.attrs} : {})})),
          },
        })),
      },
    },
  });
}

describe('fetchPaidUnits', () => {
  it('counts paid and partially refunded lines of campaign SKUs only', async () => {
    const units = await fetchPaidUnits(ENV, '2026-09-21', SKUS, async () =>
      page([
        {displayFinancialStatus: 'PAID', lines: [['OPENESC-2020', 3], ['ACC-STRAP-20X220', 5]]},
        {displayFinancialStatus: 'PARTIALLY_REFUNDED', lines: [['OPENESC-2020', 1]]},
        {displayFinancialStatus: 'PENDING', lines: [['OPENESC-2020', 50]]},
        {displayFinancialStatus: 'AUTHORIZED', lines: [['OPENESC-2020', 50]]},
        {displayFinancialStatus: 'PAID', cancelledAt: '2026-09-22T00:00:00Z', lines: [['OPENESC-2020', 50]]},
        {displayFinancialStatus: 'PAID', test: true, lines: [['OPENFRAME-5', 50]]},
      ]),
    );
    assert.deepEqual(units, {'OPENESC-2020': 4});
  });

  it('retries a throttled page instead of failing the count', async () => {
    let calls = 0;
    const units = await fetchPaidUnits(ENV, '2026-09-21', SKUS, async () => {
      calls += 1;
      if (calls < 3) return Response.json({errors: [{message: 'Throttled', extensions: {code: 'THROTTLED'}}]});
      return page([{displayFinancialStatus: 'PAID', lines: [['OPENESC-2020', 2]]}]);
    });
    assert.equal(calls, 3);
    assert.deepEqual(units, {'OPENESC-2020': 2});
  });

  it('still fails when the throttle does not clear', async () => {
    await assert.rejects(
      fetchPaidUnits(ENV, '2026-09-21', SKUS, async () => Response.json({errors: [{message: 'Throttled'}]})),
      /rejected the query/,
    );
  });

  it('follows pagination and sends the countFrom filter', async () => {
    const queries: string[] = [];
    let call = 0;
    const units = await fetchPaidUnits(ENV, '2026-09-21', SKUS, async (_url, init) => {
      queries.push((JSON.parse(String(init?.body)) as {variables: {query: string}}).variables.query);
      call += 1;
      return call === 1
        ? page([{displayFinancialStatus: 'PAID', lines: [['OPENFRAME-5', 2]]}], 'cursor-1')
        : page([{displayFinancialStatus: 'PAID', lines: [['OPENFRAME-5', 5]]}]);
    });
    assert.deepEqual(units, {'OPENFRAME-5': 7});
    assert.deepEqual(queries, ['created_at:>=2026-09-21', 'created_at:>=2026-09-21']);
  });

  it('sends no status filter, so fulfilled and archived orders keep counting', async () => {
    let query = '';
    const units = await fetchPaidUnits(ENV, '2026-09-21', SKUS, async (_url, init) => {
      query = (JSON.parse(String(init?.body)) as {variables: {query: string}}).variables.query;
      const response = page([
        {displayFinancialStatus: 'PAID', lines: [['OPENESC-2020', 2]]},
        {displayFinancialStatus: 'PAID', lines: [['OPENESC-2020', 3]]},
      ]);
      // Shopify returns closed (fulfilled, archived) orders like open ones.
      const body = (await response.json()) as {data: {orders: {nodes: Array<Record<string, unknown>>}}};
      body.data.orders.nodes[1] = {...body.data.orders.nodes[1], closed: true, displayFulfillmentStatus: 'FULFILLED'};
      return Response.json(body);
    });
    assert.doesNotMatch(query, /status:/);
    assert.deepEqual(units, {'OPENESC-2020': 5});
  });

  it('fails instead of undercounting', async () => {
    await assert.rejects(
      fetchPaidUnits(ENV, '2026-09-21', SKUS, async () => new Response('nope', {status: 403})),
      /returned 403/,
    );
    await assert.rejects(
      fetchPaidUnits(ENV, '2026-09-21', SKUS, async () =>
        page([{displayFinancialStatus: 'PAID', lines: [['OPENESC-2020', 1]], more: true}]),
      ),
      /exceeds 250 lines/,
    );
    await assert.rejects(
      fetchPaidUnits(ENV, '2026-09-21', SKUS, async () => Response.json({errors: [{message: 'access denied'}]})),
      /rejected the query/,
    );
  });

  it('refuses an unconfigured or foreign Admin host', async () => {
    await assert.rejects(fetchPaidUnits({}, '2026-09-21', SKUS), /not configured/);
    await assert.rejects(
      fetchPaidUnits({...ENV, SHOPIFY_STORE_DOMAIN: 'attacker.example'}, '2026-09-21', SKUS),
      /not configured/,
    );
  });
});

describe('paidUnits', () => {
  it('never shares an in-flight fetch between callers, and reuses a result for a minute', async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return page([{displayFinancialStatus: 'PAID', lines: [['OPENESC-2020', 1]]}]);
    };
    const [a, b] = await Promise.all([
      paidUnits(ENV, '2026-09-21', SKUS, fetcher),
      paidUnits(ENV, '2026-09-21', SKUS, fetcher),
    ]);
    await paidUnits(ENV, '2026-09-21', SKUS, fetcher);
    assert.deepEqual(a, b);
    assert.equal(calls, 2);
  });
});

describe('paidUnitRuns after a failed read', () => {
  const throttled = async () => Response.json({errors: [{message: 'Throttled', extensions: {code: 'THROTTLED'}}]});
  it('serves the last good counts up to 15 minutes and stays off the Admin API for 30 seconds', async () => {
    let clock = 0;
    const now = () => clock;
    let calls = 0;
    const good = async () => { calls += 1; return page([{displayFinancialStatus: 'PAID', lines: [['OPENESC-2020', 3]]}]); };
    const bad = async () => { calls += 1; return throttled(); };
    const first = await paidUnitRuns(ENV, '2026-09-21', SKUS, good, now);
    clock = 2 * 60_000;
    assert.deepEqual(await paidUnitRuns(ENV, '2026-09-21', SKUS, bad, now), first);
    const tried = calls;
    clock += 10_000;
    assert.deepEqual(await paidUnitRuns(ENV, '2026-09-21', SKUS, bad, now), first);
    assert.equal(calls, tried, 'cooldown: no Admin call');
    clock = 16 * 60_000;
    await assert.rejects(paidUnitRuns(ENV, '2026-09-21', SKUS, bad, now), /rejected the query/);
  });
  it('throws without hitting the Admin API during the cooldown when nothing good is known', async () => {
    let clock = 0;
    let calls = 0;
    const bad = async () => { calls += 1; return throttled(); };
    await assert.rejects(paidUnitRuns(ENV, '2026-09-21', SKUS, bad, () => clock));
    const after = calls;
    clock = 5_000;
    await assert.rejects(paidUnitRuns(ENV, '2026-09-21', SKUS, bad, () => clock), /failed recently/);
    assert.equal(calls, after);
  });
});

describe('fetchPaidUnitRuns', () => {
  it('keeps each unit\'s shipping region in order, merging neighbours', async () => {
    assert.match(PAID_ORDERS_QUERY, /shippingAddress \{ countryCodeV2 \}/);
    const runs = await fetchPaidUnitRuns(ENV, '2026-09-21', SKUS, async () =>
      page([
        {displayFinancialStatus: 'PAID', country: 'BE', lines: [['OPENESC-2020', 3]]},
        {displayFinancialStatus: 'PAID', country: 'NL', lines: [['OPENESC-2020', 1]]},
        {displayFinancialStatus: 'PAID', country: 'US', lines: [['OPENESC-2020', 2]]},
        {displayFinancialStatus: 'PAID', country: 'CA', lines: [['OPENESC-2020', 3]]},
        {displayFinancialStatus: 'PAID', country: 'AU', lines: [['OPENESC-2020', 1]]},
        {displayFinancialStatus: 'PAID', lines: [['OPENESC-2020', 1]]},
      ]),
    );
    assert.deepEqual(runs, {'OPENESC-2020': [{region: 'EU', units: 4}, {region: 'US', units: 2}, {region:'INT', units:4}, {region: 'EU', units: 1}]});
  });
});

describe('fetchPaidUnitRuns: non-EU lines sold batch 1 keep it (grandfatheredPaidLine)', () => {
  const config = parseCampaignConfig({
    countFrom: '2026-09-21', endsOn: '2026-12-31', shipsBy: '2027-03-31',
    priceTiers: [{upTo: 100, off: 0.2}],
    pendingShips: 'ships by 31 March 2027 if the target is reached by 31 December 2026, otherwise you choose a refund or to wait',
    paidRegions: ['EU'],
    skus: {'OPENESC-2020': {batches: [{units: 250, reserved: 50, paid: true, ships: 'ships late November 2026'}, {units: 250}]}},
  });
  const oldInt = [{key: '_ship_region', value: 'INT'}, {key: '_batch', value: 'OPENESC-2020:1'}, {key: 'Preorder', value: 'ships late November 2026'}];
  const newNear = [{key: '_ship_region', value: 'NEAR'}, {key: '_batch', value: 'OPENESC-2020:2'}, {key: 'Preorder', value: config.pendingShips}];
  it('reads line attributes and counts a recorded batch 1 non-EU line as EU; new NEAR/INT lines in their own region', async () => {
    assert.match(PAID_ORDERS_QUERY, /customAttributes \{ key value \}/);
    const runs = await fetchPaidUnitRuns(ENV, '2026-09-21', SKUS, async () =>
      page([
        {displayFinancialStatus: 'PAID', country: 'GB', attrs: oldInt, lines: [['OPENESC-2020', 2]]},
        {displayFinancialStatus: 'PAID', country: 'CA', attrs: oldInt, lines: [['OPENESC-2020', 1]]},
        {displayFinancialStatus: 'PAID', country: 'GB', attrs: newNear, lines: [['OPENESC-2020', 1]]},
        {displayFinancialStatus: 'PAID', country: 'CA', attrs: [{key: '_ship_region', value: 'INT'}, {key: '_batch', value: 'OPENESC-2020:2'}], lines: [['OPENESC-2020', 1]]},
      ]),
    config);
    assert.deepEqual(runs, {'OPENESC-2020': [{region: 'EU', units: 3}, {region: 'NEAR', units: 1}, {region: 'INT', units: 1}]});
    // The storefront's batch 1 count is EU only: grandfathered units take it, new NEAR/INT units do not.
    const eu = campaignState(config.skus['OPENESC-2020'].batches, runs['OPENESC-2020'] as UnitRuns, config.pendingShips, [], null, 'EU');
    assert.equal(eu.batch, 1);
    assert.equal(eu.paidLeft, 197);
    const near = campaignState(config.skus['OPENESC-2020'].batches, runs['OPENESC-2020'] as UnitRuns, config.pendingShips, [], null, 'NEAR');
    assert.equal(near.batch, 2);
    assert.equal(near.paidStock, false);
  });
});

describe('fetchPaidUnitRuns with the campaign rule', () => {
  const config = parseCampaignConfig({
    countFrom: '2026-09-21', endsOn: '2026-12-31', shipsBy: '2027-03-11',
    priceTiers: [{upTo: 100, off: 0.2}],
    pendingShips: 'ships about 10 weeks after its target is reached',
    skus: {
      'OPENESC-2020': {batches: [{units: 250, paid: true, ships: 'ships early November 2026'}, {units: 250}]},
      'OPENFRAME-5': {batches: [{units: 250}]},
    },
  });

  it('flags units of an order with a line outside paid stock as march', async () => {
    const runs = await fetchPaidUnitRuns(ENV, '2026-09-21', SKUS, async () =>
      page([
        {displayFinancialStatus: 'PAID', lines: [['OPENESC-2020', 2]]},
        {displayFinancialStatus: 'PAID', lines: [['OPENESC-2020', 3], ['OPENFRAME-5', 1]]},
        {displayFinancialStatus: 'PAID', lines: [['OPENESC-2020', 1], ['ACC-PROP-5-HQ-J37', 1]]},
        {displayFinancialStatus: 'PAID', lines: [['OPENESC-2020', 4]]},
      ]), config);
    assert.deepEqual(runs, {
      'OPENESC-2020': [
        {region: 'EU', units: 2},
        {region: 'EU', units: 4, march: true},
        {region: 'EU', units: 4},
      ],
      'OPENFRAME-5': [{region: 'EU', units: 1, march: true}],
    });
  });

  it('keeps the plain counts without the campaign config', async () => {
    const runs = await fetchPaidUnitRuns(ENV, '2026-09-21', SKUS, async () =>
      page([{displayFinancialStatus: 'PAID', lines: [['OPENESC-2020', 3], ['OPENFRAME-5', 1]]}]));
    assert.deepEqual(runs['OPENESC-2020'], [{region: 'EU', units: 3}]);
  });
});
