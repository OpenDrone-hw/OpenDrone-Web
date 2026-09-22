import assert from 'node:assert/strict';
import {afterEach, describe, it} from 'node:test';
import {
  PREORDER_HOLD_HANDLE,
  PREORDER_LINE_ATTRIBUTE,
  assignBatches,
  batchOfUnit,
  holdNote,
  planPreorderHolds,
  planRelease,
  syncPreorderHolds,
  type PreorderOrder,
} from './preorder-fulfilment.ts';
import {reconcilePreorders} from './preorder-ops.ts';
import {opsStatus, resetOpsStatus} from './preorder-ops-status.ts';
import {parseCampaignConfig} from './preorder-campaign.ts';
import {PREORDER_ATTRIBUTE} from './shopify-storefront.ts';
import {resetPaidUnitsMemo} from './shopify-orders.ts';

afterEach(() => {
  resetOpsStatus();
  resetPaidUnitsMemo();
});

const ENV = {
  SHOPIFY_STORE_DOMAIN: 'store.myshopify.com',
  SHOPIFY_ADMIN_API_TOKEN: 'token',
  SHOPIFY_ADMIN_API_VERSION: '2026-07',
  SHOPIFY_PRICE_TIER_WRITE_ENABLED: '1',
};

const CONFIG = parseCampaignConfig({
  countFrom: '2026-09-21',
  endsOn: '2026-12-31',
  priceTiers: [{upTo: 100, off: 0.2}, {upTo: 250, off: 0.1}],
  pendingShips: 'ships about 10 weeks after its target is reached',
  skus: {
    'OPENFC-LITE-2020': {batches: [{units: 250, paid: true, ships: 'ships late October 2026'}, {units: 250}]},
    'OPENRX-LITE': {batches: [{units: 250}, {units: 1000}]},
  },
});

let seq = 0;
function order(partial: {
  lines: Array<[string, number, boolean?]>;
  tags?: string[];
  status?: string;
  foStatus?: string;
  holds?: Array<{id: string; handle: string}>;
  test?: boolean;
  cancelled?: boolean;
}): PreorderOrder {
  seq += 1;
  return {
    id: `gid://shopify/Order/${seq}`,
    name: `#${1000 + seq}`,
    createdAt: `2026-09-22T10:${String(seq).padStart(2, '0')}:00Z`,
    test: partial.test ?? false,
    cancelledAt: partial.cancelled ? '2026-09-23T00:00:00Z' : null,
    displayFinancialStatus: partial.status ?? 'PAID',
    tags: partial.tags ?? [],
    email: `buyer${seq}@example.com`,
    customerLocale: 'en',
    lineItems: {
      pageInfo: {hasNextPage: false},
      nodes: partial.lines.map(([sku, qty, preorder = true]) => ({
        sku,
        name: sku,
        currentQuantity: qty,
        customAttributes: preorder ? [{key: 'Preorder', value: 'ships late October 2026'}] : [],
      })),
    },
    fulfillmentOrders: {
      nodes: [
        {
          id: `gid://shopify/FulfillmentOrder/${seq}`,
          status: partial.foStatus ?? 'OPEN',
          fulfillmentHolds: (partial.holds ?? []).map((h) => ({...h, reasonNotes: null})),
        },
      ],
    },
  };
}

/** A fetch double for the Admin API: answers the orders query with
 *  `orders` and records every mutation. */
function adminDouble(
  orders: PreorderOrder[],
  opts: {tagError?: string; variants?: Array<{sku: string; price: string; compareAtPrice: string | null}>} = {},
) {
  const calls: Array<{op: string; variables: Record<string, unknown>}> = [];
  const fetcher = (async (_url: string, init?: RequestInit) => {
    const {query, variables} = JSON.parse(String(init?.body)) as {query: string; variables: Record<string, unknown>};
    const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? '?';
    calls.push({op, variables});
    switch (op) {
      case 'OpenDronePreorderOrders':
        return Response.json({data: {orders: {pageInfo: {hasNextPage: false, endCursor: null}, nodes: orders}}});
      case 'OpenDronePaidPreorders':
        return Response.json({
          data: {
            orders: {
              pageInfo: {hasNextPage: false, endCursor: null},
              nodes: orders.map((o) => ({
                test: o.test,
                cancelledAt: o.cancelledAt,
                displayFinancialStatus: o.displayFinancialStatus,
                lineItems: {
                  pageInfo: {hasNextPage: false},
                  nodes: o.lineItems.nodes.map((l) => ({sku: l.sku, currentQuantity: l.currentQuantity})),
                },
              })),
            },
          },
        });
      case 'OpenDronePreorderVariants':
        return Response.json({
          data: {
            productVariants: {
              nodes: (opts.variants ?? []).map((v, i) => ({id: `v${i}`, product: {id: `p${i}`}, ...v})),
            },
          },
        });
      case 'OpenDronePreorderPrices':
        return Response.json({data: {productVariantsBulkUpdate: {userErrors: []}}});
      case 'OpenDronePreorderHold':
        return Response.json({data: {fulfillmentOrderHold: {userErrors: []}}});
      case 'OpenDronePreorderTags':
        return Response.json({
          data: {tagsAdd: {userErrors: opts.tagError ? [{field: null, message: opts.tagError}] : []}},
        });
      default:
        return new Response('unexpected', {status: 500});
    }
  }) as typeof fetch;
  return {fetcher, calls};
}

describe('preorder fulfilment', () => {
  it('uses the same line attribute as the cart', () => {
    assert.equal(PREORDER_LINE_ATTRIBUTE, PREORDER_ATTRIBUTE);
  });

  it('maps paid units to batches, repeating the last batch size', () => {
    const batches = CONFIG.skus['OPENFC-LITE-2020'].batches;
    assert.equal(batchOfUnit(batches, 1).batch, 1);
    assert.equal(batchOfUnit(batches, 250).batch, 1);
    assert.equal(batchOfUnit(batches, 251).batch, 2);
    assert.equal(batchOfUnit(batches, 751).batch, 4);
  });

  it('assigns batches in creation order and splits a line over a boundary', () => {
    const first = order({lines: [['OPENFC-LITE-2020', 248]]});
    const refunded = order({lines: [['OPENFC-LITE-2020', 50]], status: 'REFUNDED'});
    const second = order({lines: [['OPENFC-LITE-2020', 5], ['OPENRX-LITE', 1]]});
    // Listed out of order: creation time decides.
    const result = assignBatches([second, refunded, first], CONFIG);
    assert.deepEqual(result.get(first.id), [
      {sku: 'OPENFC-LITE-2020', batch: 1, units: 248, shipPromise: 'ships late October 2026'},
    ]);
    assert.equal(result.has(refunded.id), false);
    assert.deepEqual(
      result.get(second.id)?.map((b) => [b.sku, b.batch, b.units]),
      [['OPENFC-LITE-2020', 1, 2], ['OPENFC-LITE-2020', 2, 3], ['OPENRX-LITE', 1, 1]],
    );
  });

  it('plans a hold and batch tags only for paid preorder orders not yet tagged', () => {
    const plain = order({lines: [['ACC-STRAP', 1, false]]});
    const done = order({lines: [['OPENRX-LITE', 1]], tags: ['preorder', 'batch:OPENRX-LITE:1']});
    const unpaid = order({lines: [['OPENRX-LITE', 1]], status: 'PENDING'});
    const test = order({lines: [['OPENRX-LITE', 1]], test: true});
    const fresh = order({lines: [['OPENFC-LITE-2020', 2]]});
    const plans = planPreorderHolds([plain, done, unpaid, test, fresh], CONFIG);
    assert.equal(plans.length, 1);
    assert.equal(plans[0].orderName, fresh.name);
    assert.deepEqual(plans[0].tags, ['preorder', 'batch:OPENFC-LITE-2020:1']);
    assert.deepEqual(plans[0].hold, [fresh.fulfillmentOrders.nodes[0].id]);
    assert.match(plans[0].note, /OPENFC-LITE-2020 batch 1 \(ships late October 2026\)/);
  });

  it('does not hold a fulfillment order twice', () => {
    const held = order({
      lines: [['OPENRX-LITE', 1]],
      foStatus: 'ON_HOLD',
      holds: [{id: 'gid://shopify/FulfillmentHold/1', handle: PREORDER_HOLD_HANDLE}],
    });
    const plans = planPreorderHolds([held], CONFIG);
    assert.deepEqual(plans[0].hold, []);
    assert.deepEqual(plans[0].tags, ['preorder', 'batch:OPENRX-LITE:1']);
  });

  it('keeps the hold note within Shopify limits', () => {
    const many = Array.from({length: 20}, (_, i) => ({
      sku: `SKU-${i}`,
      batch: 1,
      units: 1,
      shipPromise: 'ships about 10 weeks after its target is reached',
    }));
    assert.ok(holdNote(many).length <= 255);
  });

  it('holds before tagging, with reason OTHER and the batch note', async () => {
    const fresh = order({lines: [['OPENRX-LITE', 3]]});
    const {fetcher, calls} = adminDouble([fresh]);
    const result = await syncPreorderHolds(ENV, CONFIG, {apply: true, fetcher});
    assert.deepEqual(result.errors, {});
    const ops = calls.map((c) => c.op);
    assert.deepEqual(ops, ['OpenDronePreorderOrders', 'OpenDronePreorderHold', 'OpenDronePreorderTags']);
    const hold = calls[1].variables as {fulfillmentHold: {reason: string; handle: string; reasonNotes: string}};
    assert.equal(hold.fulfillmentHold.reason, 'OTHER');
    assert.equal(hold.fulfillmentHold.handle, PREORDER_HOLD_HANDLE);
    assert.match(hold.fulfillmentHold.reasonNotes, /OPENRX-LITE batch 1/);
    assert.deepEqual(calls[2].variables.tags, ['preorder', 'batch:OPENRX-LITE:1']);
  });

  it('writes nothing on a dry run', async () => {
    const {fetcher, calls} = adminDouble([order({lines: [['OPENRX-LITE', 1]]})]);
    const result = await syncPreorderHolds(ENV, CONFIG, {fetcher});
    assert.equal(result.planned.length, 1);
    assert.deepEqual(calls.map((c) => c.op), ['OpenDronePreorderOrders']);
  });

  it('names an order whose tags fail and keeps going', async () => {
    const a = order({lines: [['OPENRX-LITE', 1]]});
    const b = order({lines: [['OPENRX-LITE', 1]]});
    const {fetcher} = adminDouble([a, b], {tagError: 'Access denied for tagsAdd'});
    const result = await syncPreorderHolds(ENV, CONFIG, {apply: true, fetcher});
    assert.deepEqual(Object.keys(result.errors), [a.name, b.name]);
    assert.match(result.errors[a.name], /tags: Access denied/);
  });
});

describe('planRelease', () => {
  const hold = (id: string) => [{id, handle: PREORDER_HOLD_HANDLE}];

  it('releases an order only when every batch it carries is ready', () => {
    const only = order({lines: [['OPENFC-LITE-2020', 1]], tags: ['preorder', 'batch:OPENFC-LITE-2020:1'], foStatus: 'ON_HOLD', holds: hold('h1')});
    const mixed = order({
      lines: [['OPENFC-LITE-2020', 1], ['OPENRX-LITE', 1]],
      tags: ['preorder', 'batch:OPENFC-LITE-2020:1', 'batch:OPENRX-LITE:1'],
      foStatus: 'ON_HOLD',
      holds: hold('h2'),
    });
    const other = order({lines: [['OPENRX-LITE', 1]], tags: ['preorder', 'batch:OPENRX-LITE:1'], foStatus: 'ON_HOLD', holds: hold('h3')});
    const released = order({lines: [['OPENFC-LITE-2020', 1]], tags: ['preorder', 'batch:OPENFC-LITE-2020:1']});

    const plans = planRelease([only, mixed, other, released], 'OPENFC-LITE-2020', 1, new Set());
    assert.deepEqual(plans.map((p) => [p.orderName, p.waitsFor]), [
      [only.name, []],
      [mixed.name, ['batch:OPENRX-LITE:1']],
    ]);
    assert.deepEqual(plans[0].release, [{id: only.fulfillmentOrders.nodes[0].id, holdIds: ['h1']}]);

    const withRx = planRelease([mixed], 'OPENFC-LITE-2020', 1, new Set(['batch:OPENRX-LITE:1']));
    assert.deepEqual(withRx[0].waitsFor, []);
  });

  it('ignores a batch whose line was refunded', () => {
    const refundedRx = order({
      lines: [['OPENFC-LITE-2020', 1], ['OPENRX-LITE', 0]],
      tags: ['preorder', 'batch:OPENFC-LITE-2020:1', 'batch:OPENRX-LITE:1'],
      foStatus: 'ON_HOLD',
      holds: hold('h4'),
    });
    assert.deepEqual(planRelease([refundedRx], 'OPENFC-LITE-2020', 1, new Set())[0].waitsFor, []);
  });
});

describe('reconcilePreorders', () => {
  it('syncs prices, then holds untagged paid preorder orders, and records both', async () => {
    const fresh = order({lines: [['OPENRX-LITE', 1]]});
    const {fetcher, calls} = adminDouble([fresh], {
      variants: [{sku: 'OPENRX-LITE', price: '31.20', compareAtPrice: '39.00'}],
    });
    const result = await reconcilePreorders(ENV, CONFIG, fetcher);
    assert.deepEqual(result.changed, []);
    assert.deepEqual(result.held, [fresh.name]);
    assert.ok(calls.some((c) => c.op === 'OpenDronePreorderHold'));
    const status = opsStatus();
    assert.equal(status.priceSync?.last.ok, true);
    assert.equal(status.holdSync?.last.ok, true);
  });

  it('keeps a hold failure out of the price result and records it', async () => {
    const fresh = order({lines: [['OPENRX-LITE', 1]]});
    const {fetcher} = adminDouble([fresh], {
      tagError: 'Access denied',
      variants: [{sku: 'OPENRX-LITE', price: '31.20', compareAtPrice: '39.00'}],
    });
    const result = await reconcilePreorders(ENV, CONFIG, fetcher);
    assert.deepEqual(Object.keys(result.holdErrors), [fresh.name]);
    assert.equal(opsStatus().holdSync?.last.ok, false);
    assert.match(opsStatus().holdSync?.lastError?.error ?? '', /Access denied/);
  });
});
