import assert from 'node:assert/strict';
import {afterEach, describe, it} from 'node:test';
import {fetchPaidUnits, paidUnits, resetPaidUnitsMemo} from './shopify-orders.ts';

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
          lineItems: {
            pageInfo: {hasNextPage: o.more ?? false},
            nodes: o.lines.map(([sku, currentQuantity]) => ({sku, currentQuantity})),
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
    assert.deepEqual(queries, ['created_at:>=2026-09-21 status:any', 'created_at:>=2026-09-21 status:any']);
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
  it('shares one fetch between concurrent callers and reuses it for a minute', async () => {
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
    assert.equal(calls, 1);
  });
});
