import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {batchPromiseOf, orderPromise, readCustomerAccount} from './customer-shopify.ts';
import {parseCampaignConfig} from '../preorder-campaign.ts';

const ENV = {
  SHOPIFY_STORE_DOMAIN: 'store.myshopify.com',
  SHOPIFY_ADMIN_API_TOKEN: 'token',
  SHOPIFY_ADMIN_API_VERSION: '2026-07',
};

const CONFIG = parseCampaignConfig({
  countFrom: '2026-09-21',
  endsOn: '2026-11-22',
  shipsBy: '2027-03-14',
  priceTiers: [{upTo: 100, off: 0.2}, {upTo: 250, off: 0.1}],
  pendingShips: 'ships by 14 March 2027 if the target is reached by 22 November 2026, otherwise you choose a refund or to wait',
  skus: {
    'OPENFC-LITE-2020': {
      batches: [{units: 250, paid: true, ships: 'ships late October 2026', deliveryBy: '2026-11-30'}, {units: 250}],
    },
    'OPENMOTOR-2306': {
      batches: [{units: 100}],
    },
  },
  shipsWith: {
    'ACC-STRAP-001': {sku: 'OPENFC-LITE-2020', batch: 1},
  },
});

/** A fetch double for the Admin API, matching preorder-fulfilment.test.ts's style. */
function adminDouble(data: unknown, opts: {ok?: boolean; errors?: boolean} = {}) {
  const calls: Array<{op: string; variables: Record<string, unknown>}> = [];
  const fetcher = (async (_url: string, init?: RequestInit) => {
    const {query, variables} = JSON.parse(String(init?.body)) as {query: string; variables: Record<string, unknown>};
    const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? '?';
    calls.push({op, variables});
    if (opts.ok === false) return new Response('boom', {status: 500});
    if (opts.errors) return Response.json({errors: [{message: 'nope'}]});
    return Response.json({data});
  }) as typeof fetch;
  return {fetcher, calls};
}

function rawOrder(partial: {
  name?: string;
  tags?: string[];
  lines?: Array<[string | null, number]>;
  fulfillment?: string;
  financial?: string;
  cancelledAt?: string | null;
}) {
  return {
    id: 'gid://shopify/Order/1',
    name: partial.name ?? '#1042',
    createdAt: '2026-09-28T10:00:00Z',
    statusPageUrl: 'https://store.myshopify.com/1234/orders/abc/authenticate',
    tags: partial.tags ?? [],
    cancelledAt: partial.cancelledAt ?? null,
    displayFulfillmentStatus: partial.fulfillment ?? 'UNFULFILLED',
    displayFinancialStatus: partial.financial ?? 'PAID',
    currentTotalPriceSet: {presentmentMoney: {amount: '612.40', currencyCode: 'EUR'}},
    lineItems: {
      nodes: (partial.lines ?? [['OPENFC-LITE-2020', 1]]).map(([sku, currentQuantity]) => ({
        sku,
        title: sku ?? 'Item',
        variantTitle: sku === 'OPENFC-LITE-2020' ? '30×30' : 'Default Title',
        currentQuantity,
      })),
    },
  };
}

describe('readCustomerAccount', () => {
  it('returns null when the Admin API is not configured (no token)', async () => {
    const {fetcher, calls} = adminDouble({});
    const result = await readCustomerAccount({SHOPIFY_STORE_DOMAIN: 'store.myshopify.com'}, 'gid://shopify/Customer/1', CONFIG, fetcher);
    assert.equal(result, null);
    assert.equal(calls.length, 0);
  });

  it('returns null on a transport error', async () => {
    const {fetcher} = adminDouble(null, {ok: false});
    const result = await readCustomerAccount(ENV, 'gid://shopify/Customer/1', CONFIG, fetcher);
    assert.equal(result, null);
  });

  it('returns null on a GraphQL error', async () => {
    const {fetcher} = adminDouble(null, {errors: true});
    const result = await readCustomerAccount(ENV, 'gid://shopify/Customer/1', CONFIG, fetcher);
    assert.equal(result, null);
  });

  it('returns null when Shopify has no such customer', async () => {
    const {fetcher} = adminDouble({customer: null});
    const result = await readCustomerAccount(ENV, 'gid://shopify/Customer/999', CONFIG, fetcher);
    assert.equal(result, null);
  });

  it('reads email, consent and an empty order list', async () => {
    const {fetcher} = adminDouble({
      customer: {
        id: 'gid://shopify/Customer/1',
        email: 'jane@example.com',
        emailMarketingConsent: {marketingState: 'SUBSCRIBED'},
        orders: {nodes: []},
      },
    });
    const result = await readCustomerAccount(ENV, 'gid://shopify/Customer/1', CONFIG, fetcher);
    assert.deepEqual(result, {email: 'jane@example.com', newsletter: 'SUBSCRIBED', orders: []});
  });

  it('drops fully-refunded (quantity 0) lines and reads a plain, non-preorder order', async () => {
    const order = rawOrder({tags: [], lines: [['OPENFC-LITE-2020', 1], ['OPENESC-3030', 0]]});
    const {fetcher} = adminDouble({
      customer: {id: 'x', email: 'jane@example.com', emailMarketingConsent: null, orders: {nodes: [order]}},
    });
    const result = await readCustomerAccount(ENV, 'gid://shopify/Customer/1', CONFIG, fetcher);
    assert.equal(result?.newsletter, null);
    assert.equal(result?.orders.length, 1);
    assert.deepEqual(result?.orders[0].lines, [
      {sku: 'OPENFC-LITE-2020', name: 'OPENFC-LITE-2020', variant: '30×30', quantity: 1},
    ]);
    assert.equal(result?.orders[0].isPreorder, false);
    assert.equal(result?.orders[0].promise, null);
    assert.deepEqual(result?.orders[0].total, {amount: '612.40', currencyCode: 'EUR'});
    assert.equal(result?.orders[0].fulfillmentStatus, 'UNFULFILLED');
    assert.equal(result?.orders[0].financialStatus, 'PAID');
    assert.equal(result?.orders[0].cancelled, false);
  });

  it('labels a preorder order waiting on a dated batch', async () => {
    const order = rawOrder({tags: ['preorder', 'batch:OPENFC-LITE-2020:1']});
    const {fetcher} = adminDouble({
      customer: {id: 'x', email: 'jane@example.com', emailMarketingConsent: null, orders: {nodes: [order]}},
    });
    const result = await readCustomerAccount(ENV, 'gid://shopify/Customer/1', CONFIG, fetcher);
    assert.equal(result!.orders[0].isPreorder, true);
    assert.equal(result!.orders[0].promise?.kind, 'date');
    assert.equal(result!.orders[0].promise?.text, 'ships late Oct 2026');
    assert.equal(result!.orders[0].promise?.delivered, '30 Nov 2026');
  });

  it('labels a preorder order waiting on a funding target', async () => {
    const order = rawOrder({tags: ['preorder', 'batch:OPENFC-LITE-2020:2']});
    const {fetcher} = adminDouble({
      customer: {id: 'x', email: 'jane@example.com', emailMarketingConsent: null, orders: {nodes: [order]}},
    });
    const result = await readCustomerAccount(ENV, 'gid://shopify/Customer/1', CONFIG, fetcher);
    assert.equal(result?.orders[0].promise?.kind, 'target');
    assert.equal(result?.orders[0].promise?.text, 'ships by 14 Mar 2027');
  });

  it('caps at the 5 orders the query itself asked for', async () => {
    const orders = Array.from({length: 5}, (_, i) => rawOrder({name: `#${1000 + i}`}));
    const {fetcher} = adminDouble({
      customer: {id: 'x', email: 'jane@example.com', emailMarketingConsent: null, orders: {nodes: orders}},
    });
    const result = await readCustomerAccount(ENV, 'gid://shopify/Customer/1', CONFIG, fetcher);
    assert.equal(result?.orders.length, 5);
  });
});

describe('orderPromise', () => {
  const node = (sku: string, currentQuantity = 1) => ({sku, title: sku, variantTitle: null, currentQuantity});

  it('is null without a preorder tag', () => {
    assert.equal(orderPromise({tags: [], lineItems: {nodes: []}}, CONFIG), null);
  });

  it('is null when tagged but no live line matches a batch tag', () => {
    const promise = orderPromise(
      {tags: ['preorder', 'batch:OPENFC-LITE-2020:1'], lineItems: {nodes: [node('OPENFC-LITE-2020', 0)]}},
      CONFIG,
    );
    assert.equal(promise, null);
  });

  it('follows a shipsWith accessory line to its lead SKU batch tag', () => {
    const promise = orderPromise(
      {tags: ['preorder', 'batch:OPENFC-LITE-2020:1'], lineItems: {nodes: [node('ACC-STRAP-001', 2)]}},
      CONFIG,
    );
    assert.equal(promise?.kind, 'date');
  });

  it('takes the LATEST promise of a mixed order, whatever the tag order', () => {
    const nodes = [node('OPENFC-LITE-2020'), node('OPENMOTOR-2306', 4)];
    for (const tags of [
      ['preorder', 'batch:OPENFC-LITE-2020:1', 'batch:OPENMOTOR-2306:1'],
      ['preorder', 'batch:OPENMOTOR-2306:1', 'batch:OPENFC-LITE-2020:1'],
    ]) {
      const promise = orderPromise({tags, lineItems: {nodes}}, CONFIG);
      assert.equal(promise?.kind, 'target');
      assert.equal(promise?.day, '2027-03-14');
      assert.equal(promise?.text, 'ships by 14 Mar 2027');
    }
  });

  it('ignores the later batch once its line is refunded', () => {
    const promise = orderPromise(
      {
        tags: ['preorder', 'batch:OPENFC-LITE-2020:1', 'batch:OPENMOTOR-2306:1'],
        lineItems: {nodes: [node('OPENFC-LITE-2020'), node('OPENMOTOR-2306', 0)]},
      },
      CONFIG,
    );
    assert.equal(promise?.kind, 'date');
    assert.equal(promise?.day, '2026-10-31');
  });

  it('lets a funding target that names an earlier ship day than a dated batch lose to it', () => {
    const config = {...CONFIG, shipsBy: '2026-09-01'};
    const promise = orderPromise(
      {
        tags: ['preorder', 'batch:OPENFC-LITE-2020:1', 'batch:OPENMOTOR-2306:1'],
        lineItems: {nodes: [node('OPENFC-LITE-2020'), node('OPENMOTOR-2306')]},
      },
      config,
    );
    assert.equal(promise?.kind, 'date');
  });
});

describe('batchPromiseOf', () => {
  it('reads a funding target as the campaign ship-by date', () => {
    assert.deepEqual(batchPromiseOf({units: 100}, {shipsBy: '2027-03-14'}), {
      kind: 'target',
      day: '2027-03-14',
      text: 'ships by 14 Mar 2027',
      delivered: null,
    });
  });

  it('resolves early, mid and late to sortable days, with delivery from the promise text', () => {
    const cfg = {shipsBy: '2027-03-14'};
    assert.equal(batchPromiseOf({units: 1, ships: 'ships early February 2027'}, cfg).day, '2027-02-10');
    assert.equal(batchPromiseOf({units: 1, ships: 'ships mid February 2027'}, cfg).day, '2027-02-20');
    assert.equal(batchPromiseOf({units: 1, ships: 'ships February 2028'}, cfg).day, '2028-02-29');
    const late = batchPromiseOf({units: 1, ships: 'ships late October 2026, delivered by 30 November 2026'}, cfg);
    assert.equal(late.text, 'ships late Oct 2026');
    assert.equal(late.delivered, '30 Nov 2026');
  });

  it('reads unparseable dated text as the later shipsBy', () => {
    assert.equal(batchPromiseOf({units: 1, ships: 'ships soon'}, {shipsBy: '2027-03-14'}).kind, 'target');
  });
});
