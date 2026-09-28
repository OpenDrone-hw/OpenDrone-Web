import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {orderPreorderLabel, readCustomerAccount} from './customer-shopify.ts';
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
      batches: [{units: 250, paid: true, ships: 'ships late October 2026'}, {units: 250}],
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
}) {
  return {
    id: 'gid://shopify/Order/1',
    name: partial.name ?? '#1042',
    createdAt: '2026-09-28T10:00:00Z',
    statusPageUrl: 'https://store.myshopify.com/1234/orders/abc/authenticate',
    tags: partial.tags ?? [],
    lineItems: {
      nodes: (partial.lines ?? [['OPENFC-LITE-2020', 1]]).map(([sku, currentQuantity]) => ({
        sku,
        name: sku ?? 'Item',
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
    assert.deepEqual(result?.orders[0].lines, [{sku: 'OPENFC-LITE-2020', name: 'OPENFC-LITE-2020', quantity: 1}]);
    assert.equal(result?.orders[0].preorderLabel, null);
  });

  it('labels a preorder order waiting on a dated batch', async () => {
    const order = rawOrder({tags: ['preorder', 'batch:OPENFC-LITE-2020:1']});
    const {fetcher} = adminDouble({
      customer: {id: 'x', email: 'jane@example.com', emailMarketingConsent: null, orders: {nodes: [order]}},
    });
    const result = await readCustomerAccount(ENV, 'gid://shopify/Customer/1', CONFIG, fetcher);
    assert.match(result!.orders[0].preorderLabel!, /^Preorder: /);
    assert.match(result!.orders[0].preorderLabel!, /October 2026/);
  });

  it('labels a preorder order waiting on a funding target', async () => {
    const order = rawOrder({tags: ['preorder', 'batch:OPENFC-LITE-2020:2']});
    const {fetcher} = adminDouble({
      customer: {id: 'x', email: 'jane@example.com', emailMarketingConsent: null, orders: {nodes: [order]}},
    });
    const result = await readCustomerAccount(ENV, 'gid://shopify/Customer/1', CONFIG, fetcher);
    assert.equal(result?.orders[0].preorderLabel, 'Preorder: ships by 14 March 2027 if reached');
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

describe('orderPreorderLabel', () => {
  it('is null without a preorder tag', () => {
    assert.equal(orderPreorderLabel({tags: [], lineItems: {nodes: []}}, CONFIG), null);
  });

  it('falls back to a bare "Preorder" when tagged but no live line matches a batch tag', () => {
    const label = orderPreorderLabel(
      {tags: ['preorder', 'batch:OPENFC-LITE-2020:1'], lineItems: {nodes: [{sku: 'OPENFC-LITE-2020', name: 'x', currentQuantity: 0}]}},
      CONFIG,
    );
    assert.equal(label, 'Preorder');
  });

  it('follows a shipsWith accessory line to its lead SKU batch tag', () => {
    const label = orderPreorderLabel(
      {
        tags: ['preorder', 'batch:OPENFC-LITE-2020:1'],
        lineItems: {nodes: [{sku: 'ACC-STRAP-001', name: 'Strap', currentQuantity: 2}]},
      },
      CONFIG,
    );
    assert.match(label!, /^Preorder: /);
  });
});
