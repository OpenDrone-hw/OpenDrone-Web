import assert from 'node:assert/strict';
import {afterEach, describe, it} from 'node:test';
import {
  BATCH_LINE_ATTRIBUTE,
  PREORDER_HOLD_HANDLE,
  PREORDER_LINE_ATTRIBUTE,
  PREORDER_OWN_LINE_ATTRIBUTE,
  PROMISE_MISMATCH_TAG,
  US_REVIEW_TAG,
  INT_REVIEW_TAG,
  UK_VAT_REVIEW_TAG,
  PICKUP_TAG,
  SHIP_REGION_LINE_ATTRIBUTE,
  SHIP_PROMISE_LINE_ATTRIBUTE,
  assignBatches,
  batchOfUnit,
  batchPromiseMismatch,
  holdHealth,
  holdNote,
  overfullBatches,
  planPreorderHolds,
  planRelease,
  shipsFromEuStock,
  syncPreorderHolds,
  EU_STOCK_TAG,
  type PreorderOrder,
} from './preorder-fulfilment.ts';
import {reconcilePreorders} from './preorder-ops.ts';
import {opsStatus, resetOpsStatus} from './preorder-ops-status.ts';
import {batchFill, parseCampaignConfig} from './preorder-campaign.ts';
import {BATCH_ATTRIBUTE, PREORDER_ATTRIBUTE, PREORDER_OWN_ATTRIBUTE, SHIP_PROMISE_ATTRIBUTE, SHIP_REGION_ATTRIBUTE} from './shopify-storefront.ts';
import {fetchPaidUnitRuns, resetPaidUnitsMemo} from './shopify-orders.ts';

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
  endsOn: '2026-12-31', shipsBy: '2027-03-11',
  priceTiers: [{upTo: 100, off: 0.2}, {upTo: 250, off: 0.1}],
  pendingShips: 'ships about 10 weeks after its target is reached',
  skus: {
    'OPENFC-LITE-2020': {batches: [{units: 250, paid: true, ships: 'ships early November 2026'}, {units: 250}]},
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
  /** Shipping country; omitted: none (EU). */
  country?: string;
  /** Lines added for a US destination carry `_ship_region: US`. */
  usPromise?: boolean;
  intPromise?: boolean;
  nearPromise?: boolean;
  /** The `Preorder` text; the default names no configured batch. */
  promise?: string;
  /** The hidden `_batch` attribute, `SKU:N`. */
  batch?: string;
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
    ...(partial.country ? {shippingAddress: {countryCodeV2: partial.country}} : {}),
    lineItems: {
      pageInfo: {hasNextPage: false},
      nodes: partial.lines.map(([sku, qty, preorder = true]) => ({
        sku,
        name: sku,
        currentQuantity: qty,
        customAttributes: preorder
          ? [
              {key: 'Preorder', value: partial.promise ?? 'preorder promise'},
              ...(partial.batch ? [{key: '_batch', value: partial.batch}] : []),
              ...(partial.usPromise ? [{key: '_ship_region', value: 'US'}] : []),
              ...(partial.intPromise ? [{key: '_ship_region', value: 'INT'}] : []),
              ...(partial.nearPromise ? [{key: '_ship_region', value: 'NEAR'}] : []),
            ]
          : [],
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

  it('maps paid units to batches, every unit past a reached last target staying in it', () => {
    const batches = CONFIG.skus['OPENFC-LITE-2020'].batches;
    assert.equal(batchOfUnit(batches, 1).batch, 1);
    assert.equal(batchOfUnit(batches, 250).batch, 1);
    assert.equal(batchOfUnit(batches, 251).batch, 2);
    assert.equal(batchOfUnit(batches, 751).batch, 2);
    assert.equal(batchOfUnit(batches, 5000).batch, 2);
  });

  it('assigns batches in creation order and splits a line over a boundary', () => {
    const first = order({lines: [['OPENFC-LITE-2020', 248]]});
    const refunded = order({lines: [['OPENFC-LITE-2020', 50]], status: 'REFUNDED'});
    const second = order({lines: [['OPENFC-LITE-2020', 5]]});
    // Listed out of order: creation time decides.
    const result = assignBatches([second, refunded, first], CONFIG);
    assert.deepEqual(result.get(first.id), [
      {sku: 'OPENFC-LITE-2020', batch: 1, units: 248, shipPromise: 'ships early November 2026'},
    ]);
    assert.equal(result.has(refunded.id), false);
    assert.deepEqual(
      result.get(second.id)?.map((b) => [b.sku, b.batch, b.units]),
      [['OPENFC-LITE-2020', 1, 2], ['OPENFC-LITE-2020', 2, 3]],
    );
  });

  it('gives paid stock only to orders whose every line ships with it (founder 2026-11-01)', () => {
    const boardsOnly = order({lines: [['OPENFC-LITE-2020', 2]]});
    // Boards plus a March item: the whole parcel ships in March, boards included.
    const mixed = order({lines: [['OPENFC-LITE-2020', 3], ['OPENRX-LITE', 1]]});
    // A non-campaign line is a line beyond batch 1 too.
    const withOther = order({lines: [['OPENFC-LITE-2020', 1], ['ACC-STRAP', 1, false]]});
    const later = order({lines: [['OPENFC-LITE-2020', 4]]});
    const result = assignBatches([boardsOnly, mixed, withOther, later], CONFIG);
    const view = (o: PreorderOrder) => result.get(o.id)?.map((b) => [b.sku, b.batch, b.units]);
    assert.deepEqual(view(boardsOnly), [['OPENFC-LITE-2020', 1, 2]]);
    assert.deepEqual(view(mixed), [['OPENFC-LITE-2020', 2, 3], ['OPENRX-LITE', 1, 1]]);
    assert.deepEqual(view(withOther), [['OPENFC-LITE-2020', 2, 1]]);
    assert.deepEqual(view(later), [['OPENFC-LITE-2020', 1, 4]]);
  });

  it('still splits a boards-only line over the paid batch boundary', () => {
    const first = order({lines: [['OPENFC-LITE-2020', 248]]});
    const second = order({lines: [['OPENFC-LITE-2020', 5]]});
    const result = assignBatches([first, second], CONFIG);
    assert.deepEqual(result.get(second.id)?.map((b) => [b.batch, b.units]), [[1, 2], [2, 3]]);
  });

  it('plans a hold and batch tags only for paid preorder orders not yet tagged', () => {
    const plain = order({lines: [['ACC-STRAP', 1, false]]});
    const done = order({lines: [['OPENRX-LITE', 1]], tags: ['preorder', 'batch:OPENRX-LITE:1']});
    const unpaid = order({lines: [['OPENRX-LITE', 1]], status: 'PENDING'});
    const test = order({lines: [['OPENRX-LITE', 1]], test: true});
    // EU batch 1 stock ships now: tagged eu-stock, no hold (shipsFromEuStock).
    const stock = order({lines: [['OPENFC-LITE-2020', 2]]});
    const fresh = order({lines: [['OPENRX-LITE', 2]]});
    const all = planPreorderHolds([plain, done, unpaid, test, stock, fresh], CONFIG);
    assert.deepEqual(all.filter((p) => p.orderId === stock.id).map((p) => [p.tags, p.hold]), [[[EU_STOCK_TAG, 'batch:OPENFC-LITE-2020:1'], []]]);
    const plans = all.filter((p) => p.orderId !== stock.id);
    assert.equal(plans.length, 1);
    assert.equal(plans[0].orderName, fresh.name);
    assert.deepEqual(plans[0].tags, ['preorder', 'batch:OPENRX-LITE:1']);
    assert.deepEqual(plans[0].hold, [fresh.fulfillmentOrders.nodes[0].id]);
    assert.match(plans[0].note, /OPENRX-LITE batch 1 \(ships about 10 weeks after its target is reached\)/);
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

  it('reads no promise text: a line carrying the mixed-order wording allocates and holds the same', () => {
    const plain = order({lines: [['OPENFC-LITE-2020', 2], ['OPENRX-LITE', 1]]});
    const worded = order({lines: [['OPENFC-LITE-2020', 2], ['OPENRX-LITE', 1]]});
    worded.lineItems.nodes[0].customAttributes = [
      {key: PREORDER_ATTRIBUTE, value: 'ships with the rest of this order by 31 March 2027'},
      {key: '_preorder_own', value: 'ships early November 2026'},
    ];
    const shape = (o: PreorderOrder) => assignBatches([o], CONFIG).get(o.id)?.map((b) => [b.sku, b.batch, b.units]);
    assert.deepEqual(shape(worded), shape(plain));
    const [a, b] = planPreorderHolds([plain, worded], CONFIG);
    assert.deepEqual([b.tags, b.note, b.batches], [a.tags, a.note, a.batches]);
    assert.equal(b.tags.includes(PROMISE_MISMATCH_TAG), false);
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

describe('orders without a Preorder attribute', () => {
  it('holds and tags a paid order with a live campaign SKU line and no promise (admin, draft or edited)', () => {
    const admin = order({lines: [['OPENRX-LITE', 1, false]]});
    const accessory = order({lines: [['ACC-PROP-5-HQ-J37', 1, false]]});
    const other = order({lines: [['ACC-STRAP', 1, false]]});
    const removed = order({lines: [['OPENFC-LITE-2020', 0, false]]});
    // EU batch 1 stock, admin-made or pinned accessory: ships now, unheld.
    const adminStock = order({lines: [['OPENFC-LITE-2020', 1, false]]});
    const accessoryStock = order({lines: [['ACC-PROP-5-HQ-J37', 1, false]]});
    const withAccessory = parseCampaignConfig({...CONFIG, shipsWith: {'ACC-PROP-5-HQ-J37': {sku: 'OPENRX-LITE', batch: 1}}});
    const plans = new Map(planPreorderHolds([admin, accessory, other, removed], withAccessory).map((p) => [p.orderId, p]));
    assert.deepEqual(plans.get(admin.id)?.tags, ['preorder', 'batch:OPENRX-LITE:1']);
    assert.deepEqual(plans.get(admin.id)?.hold, [admin.fulfillmentOrders.nodes[0].id]);
    assert.deepEqual(plans.get(accessory.id)?.tags, ['preorder', 'batch:OPENRX-LITE:1']);
    const pinnedToStock = parseCampaignConfig({...CONFIG, shipsWith: {'ACC-PROP-5-HQ-J37': {sku: 'OPENFC-LITE-2020', batch: 1}}});
    assert.deepEqual(planPreorderHolds([adminStock, accessoryStock], pinnedToStock).map((p) => [p.tags, p.hold]), [
      [[EU_STOCK_TAG, 'batch:OPENFC-LITE-2020:1'], []],
      [[EU_STOCK_TAG, 'batch:OPENFC-LITE-2020:1'], []],
    ]);
    assert.equal(plans.has(other.id), false);
    assert.equal(plans.has(removed.id), false);
  });
});

describe('batch promise mismatch', () => {
  const SMALL = parseCampaignConfig({
    ...CONFIG,
    skus: {'OPENFC-LITE-2020': {batches: [{units: 2, paid: true, ships: 'ships early November 2026'}, {units: 250}]}},
  });

  it('pins the hidden attribute keys to the cart', () => {
    assert.equal(BATCH_LINE_ATTRIBUTE, BATCH_ATTRIBUTE);
    assert.equal(PREORDER_OWN_LINE_ATTRIBUTE, PREORDER_OWN_ATTRIBUTE);
  });

  it('tags promise-mismatch when the paid batch filled before the order: _batch says 1, allocation says 2', () => {
    const first = order({lines: [['OPENFC-LITE-2020', 2]], promise: 'ships early November 2026', batch: 'OPENFC-LITE-2020:1'});
    const late = order({lines: [['OPENFC-LITE-2020', 1]], promise: 'ships early November 2026', batch: 'OPENFC-LITE-2020:1'});
    const plans = new Map(planPreorderHolds([first, late], SMALL).map((p) => [p.orderId, p.tags]));
    // The first order is EU batch 1 stock: it ships now, unheld.
    assert.deepEqual(plans.get(first.id), [EU_STOCK_TAG, 'batch:OPENFC-LITE-2020:1']);
    assert.deepEqual(plans.get(late.id), ['preorder', 'batch:OPENFC-LITE-2020:2', PROMISE_MISMATCH_TAG]);
  });

  it('falls back to the promise text without _batch, and never flags text that names no batch', () => {
    const first = order({lines: [['OPENFC-LITE-2020', 2]], promise: 'ships early November 2026'});
    const paidText = order({lines: [['OPENFC-LITE-2020', 1]], promise: 'ships early November 2026'});
    const fundingText = order({lines: [['OPENFC-LITE-2020', 1]], promise: SMALL.pendingShips});
    const unknown = order({lines: [['OPENFC-LITE-2020', 1]], promise: 'ships soon'});
    const all = [first, paidText, fundingText, unknown];
    const batches = assignBatches(all, SMALL);
    const flag = (o: PreorderOrder) => batchPromiseMismatch(o, batches.get(o.id) ?? [], SMALL);
    assert.deepEqual(all.map(flag), [false, true, false, false]);
  });

  it('reads the line own promise under the mixed-order wording', () => {
    const first = order({lines: [['OPENFC-LITE-2020', 2]]});
    const mixed = order({lines: [['OPENFC-LITE-2020', 1]]});
    mixed.lineItems.nodes[0].customAttributes = [
      {key: PREORDER_ATTRIBUTE, value: 'ships with the rest of this order by 31 March 2027'},
      {key: PREORDER_OWN_ATTRIBUTE, value: 'ships early November 2026'},
    ];
    const batches = assignBatches([first, mixed], SMALL);
    assert.equal(batchPromiseMismatch(mixed, batches.get(mixed.id)!, SMALL), true);
  });

  it('compares an order sold before a date change with the promise of that time', () => {
    const dated = parseCampaignConfig({
      ...SMALL,
      soldUnder: {before: '2026-09-22T12:00:00Z', shipsBy: '2027-03-01', paidShips: 'ships late October 2026', deliveryBy: '2027-03-15', deliveryByUS: '2027-03-31'},
    });
    const old = order({lines: [['OPENFC-LITE-2020', 1]], promise: 'ships late October 2026'});
    const batches = assignBatches([old], dated);
    assert.equal(batchPromiseMismatch(old, batches.get(old.id)!, dated), false);
  });

  it('checks the batch promise only when the batch tags are written', () => {
    const first = order({lines: [['OPENFC-LITE-2020', 2]]});
    const done = order({lines: [['OPENFC-LITE-2020', 1]], batch: 'OPENFC-LITE-2020:1', tags: ['preorder', 'batch:OPENFC-LITE-2020:1']});
    assert.equal(planPreorderHolds([first, done], SMALL).some((p) => p.orderId === done.id), false);
  });

  it('reports a batch whose tags carry more units than it has', () => {
    const a = order({lines: [['OPENFC-LITE-2020', 2]], tags: ['preorder', 'batch:OPENFC-LITE-2020:1']});
    const b = order({lines: [['OPENFC-LITE-2020', 1]], tags: ['preorder', 'batch:OPENFC-LITE-2020:1']});
    const c = order({lines: [['OPENFC-LITE-2020', 300]], tags: ['preorder', 'batch:OPENFC-LITE-2020:2']});
    assert.deepEqual(overfullBatches([a, b, c], SMALL), [{sku: 'OPENFC-LITE-2020', batch: 1, units: 2, tagged: 3}]);
    assert.deepEqual(overfullBatches([a], SMALL), []);
  });

  it('tags and checks a paid batch by its sellable units, not its reserved ones', () => {
    const reserved = parseCampaignConfig({
      ...CONFIG,
      skus: {'OPENFC-LITE-2020': {batches: [{units: 3, reserved: 1, paid: true, ships: 'ships early November 2026'}, {units: 250}]}},
    });
    const a = order({lines: [['OPENFC-LITE-2020', 1]]});
    const b = order({lines: [['OPENFC-LITE-2020', 2]]});
    const batches = assignBatches([a, b], reserved);
    assert.deepEqual(batches.get(a.id)!.map((x) => [x.batch, x.units]), [[1, 1]]);
    assert.deepEqual(batches.get(b.id)!.map((x) => [x.batch, x.units]), [[1, 1], [2, 1]]);
    const t1 = order({lines: [['OPENFC-LITE-2020', 2]], tags: ['preorder', 'batch:OPENFC-LITE-2020:1']});
    const t2 = order({lines: [['OPENFC-LITE-2020', 1]], tags: ['preorder', 'batch:OPENFC-LITE-2020:1']});
    assert.deepEqual(overfullBatches([t1], reserved), []);
    assert.deepEqual(overfullBatches([t1, t2], reserved), [{sku: 'OPENFC-LITE-2020', batch: 1, units: 2, tagged: 3}]);
  });

  it('counts the orders the planner would hold that carry no hold', () => {
    const fresh = order({lines: [['OPENRX-LITE', 1]]});
    const heldUntagged = order({
      lines: [['OPENRX-LITE', 1]], foStatus: 'ON_HOLD',
      holds: [{id: 'gid://shopify/FulfillmentHold/9', handle: PREORDER_HOLD_HANDLE}],
    });
    const done = order({lines: [['OPENRX-LITE', 1]], tags: ['preorder', 'batch:OPENRX-LITE:1']});
    assert.deepEqual(holdHealth([fresh, heldUntagged, done], CONFIG), {unheld: 1, overfull: []});
  });
});

describe('reconcilePreorders', () => {
  it('holds with the price-step switch off and reads no paid count or price', async () => {
    const fresh = order({lines: [['OPENRX-LITE', 1]]});
    const {fetcher, calls} = adminDouble([fresh]);
    const result = await reconcilePreorders({...ENV, SHOPIFY_PRICE_TIER_WRITE_ENABLED: '0'}, CONFIG, fetcher);
    assert.deepEqual(result.held, [fresh.name]);
    assert.equal(result.priceError, null);
    assert.deepEqual(calls.map((c) => c.op), ['OpenDronePreorderOrders', 'OpenDronePreorderHold', 'OpenDronePreorderTags']);
  });

  it('still holds when the paid counts fail, and records the failure', async () => {
    const fresh = order({lines: [['OPENRX-LITE', 1]]});
    const {fetcher: base} = adminDouble([fresh]);
    const fetcher = (async (url: string, init?: RequestInit) =>
      String(init?.body).includes('OpenDronePaidPreorders') ? new Response('down', {status: 502}) : base(url, init)) as typeof fetch;
    const result = await reconcilePreorders(ENV, CONFIG, fetcher);
    assert.match(result.priceError ?? '', /502/);
    assert.deepEqual(result.held, [fresh.name]);
    assert.equal(opsStatus().paidCounts?.last.ok, false);
    assert.equal(opsStatus().holdSync?.last.ok, true);
  });

  it('still holds when the price write fails', async () => {
    const fresh = order({lines: [['OPENRX-LITE', 1]]});
    const {fetcher: base} = adminDouble([fresh], {variants: [{sku: 'OPENRX-LITE', price: '39.00', compareAtPrice: '39.00'}]});
    const fetcher = (async (url: string, init?: RequestInit) =>
      String(init?.body).includes('OpenDronePreorderPrices') ? new Response('nope', {status: 500}) : base(url, init)) as typeof fetch;
    const result = await reconcilePreorders(ENV, CONFIG, fetcher);
    assert.ok(result.priceError);
    assert.equal(opsStatus().priceSync?.last.ok, false);
    assert.deepEqual(result.held, [fresh.name]);
  });

  it('writes no hold on staging, which shares the production store', async () => {
    const {fetcher, calls} = adminDouble([order({lines: [['OPENRX-LITE', 1]]})]);
    const result = await reconcilePreorders({...ENV, SHOPIFY_PRICE_TIER_WRITE_ENABLED: '0', STAGING_PASSWORD: 'x'}, CONFIG, fetcher);
    assert.deepEqual(result.held, []);
    assert.deepEqual(calls, []);
  });

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

describe('SKUs that ship with a campaign SKU', () => {
  const WITH = parseCampaignConfig({
    ...CONFIG,
    shipsWith: {
      'ACC-PROP-5-HQ-J37': {sku: 'OPENFC-LITE-2020', batch: 1},
      'ACC-FRM-ARM-5': {sku: 'OPENRX-LITE'},
    },
  });

  it('tags an accessory with its lead batch and adds no units to the lead', () => {
    const props = order({lines: [['ACC-PROP-5-HQ-J37', 3]]});
    const fc = order({lines: [['OPENFC-LITE-2020', 250]]});
    const late = order({lines: [['OPENFC-LITE-2020', 1], ['ACC-PROP-5-HQ-J37', 1]]});
    const assigned = assignBatches([props, fc, late], WITH);
    assert.deepEqual(assigned.get(props.id), [
      {sku: 'OPENFC-LITE-2020', batch: 1, units: 3, shipPromise: 'ships early November 2026', item: 'ACC-PROP-5-HQ-J37'},
    ]);
    // The props did not use up FC units: unit 251 is the 251st FC.
    assert.deepEqual(assigned.get(late.id)?.map((b) => [b.sku, b.batch, b.item ?? null]), [
      ['OPENFC-LITE-2020', 2, null],
      ['OPENFC-LITE-2020', 1, 'ACC-PROP-5-HQ-J37'],
    ]);
    // Pinned to EU batch 1 stock: ships now, unheld; the note still names the lead.
    const [plan] = planPreorderHolds([props], WITH);
    assert.deepEqual([plan.tags, plan.hold], [[EU_STOCK_TAG, 'batch:OPENFC-LITE-2020:1'], []]);
    assert.match(holdNote(assigned.get(props.id)!), /ACC-PROP-5-HQ-J37 with OPENFC-LITE-2020 batch 1/);
  });

  it('tags accessory units on hand with the dated batch and the rest with the run', () => {
    const stocked = parseCampaignConfig({
      ...CONFIG,
      shipsWith: {'ACC-ANT-T': {sku: 'OPENFC-LITE-2020', batch: 1, stock: 4, after: 2}},
    });
    const first = order({lines: [['ACC-ANT-T', 3]]});
    const second = order({lines: [['ACC-ANT-T', 1]]});
    // Past the stock the order ships in March whole: it takes no stock units.
    const third = order({lines: [['ACC-ANT-T', 3]]});
    const assigned = assignBatches([first, second, third], stocked);
    assert.deepEqual(assigned.get(first.id)?.map((b) => [b.batch, b.units]), [[1, 3]]);
    assert.deepEqual(assigned.get(second.id)?.map((b) => [b.batch, b.units]), [[1, 1]]);
    assert.deepEqual(assigned.get(third.id)?.map((b) => [b.batch, b.units, b.shipPromise]), [
      [2, 3, CONFIG.pendingShips],
    ]);
  });

  it('puts a follower on the batch its lead next unit falls into', () => {
    const rx = order({lines: [['OPENRX-LITE', 250]]});
    const arm = order({lines: [['ACC-FRM-ARM-5', 2]]});
    assert.deepEqual(assignBatches([rx, arm], WITH).get(arm.id)?.map((b) => [b.sku, b.batch]), [['OPENRX-LITE', 2]]);
  });

  it('keeps a lead tag live for release while an accessory line still ships', () => {
    const hold = [{id: 'h1', handle: PREORDER_HOLD_HANDLE}];
    const mixed = order({
      lines: [['OPENRX-LITE', 1], ['ACC-PROP-5-HQ-J37', 1]],
      tags: ['preorder', 'batch:OPENRX-LITE:1', 'batch:OPENFC-LITE-2020:1'],
      holds: hold,
    });
    const [plan] = planRelease([mixed], 'OPENRX-LITE', 1, new Set(), WITH.shipsWith);
    assert.deepEqual(plan.waitsFor, ['batch:OPENFC-LITE-2020:1']);
  });
});

describe('US and EU orders in one campaign', () => {
  const REGIONAL = parseCampaignConfig({
    countFrom: '2026-09-21',
    endsOn: '2026-12-31', shipsBy: '2027-03-11',
    priceTiers: [{upTo: 100, off: 0.2}],
    pendingShips: 'ships about 10 weeks after its target is reached',
    skus: {
      'OPENFC-LITE-2020': {batches: [{units: 3, paid: true, ships: 'ships early November 2026', regions: ['EU']}, {units: 250}]},
    },
    shipsWith: {'ACC-ANT-T': {sku: 'OPENFC-LITE-2020', batch: 1, stock: 1, after: 2}},
  });

  it('pins the region attribute key', () => {
    assert.equal(SHIP_REGION_LINE_ATTRIBUTE, SHIP_REGION_ATTRIBUTE);
  });

  it('puts US units in the first batch that serves the US and EU units in paid stock first', () => {
    const us1 = order({lines: [['OPENFC-LITE-2020', 2]], country: 'US', usPromise: true});
    const eu1 = order({lines: [['OPENFC-LITE-2020', 2]], country: 'BE'});
    const us2 = order({lines: [['OPENFC-LITE-2020', 1], ['ACC-ANT-T', 1]], country: 'US', usPromise: true});
    const eu2 = order({lines: [['OPENFC-LITE-2020', 2], ['ACC-ANT-T', 2]], country: 'NL'});
    const batches = assignBatches([eu2, us2, eu1, us1], REGIONAL);
    const view = (o: PreorderOrder) => batches.get(o.id)!.map((b) => `${b.item ?? b.sku}:${b.batch}:${b.units}`);
    assert.deepEqual(view(us1), ['OPENFC-LITE-2020:2:2']);
    assert.deepEqual(view(eu1), ['OPENFC-LITE-2020:1:2']);
    // US: no Belgian stock for the accessory, the lead's next US batch.
    assert.deepEqual(view(us2), ['OPENFC-LITE-2020:2:1', 'ACC-ANT-T:2:1']);
    // EU: boards plus antennas.
    // The antennas outrun the stock, so the whole order ships with batch 2.
    assert.deepEqual(view(eu2), ['OPENFC-LITE-2020:2:2', 'ACC-ANT-T:2:2']);
  });

  it('holds and tags us-review a US order with a line no US batch carries, preorder or not', () => {
    const inStockOnly = order({lines: [['ACC-CAP-470UF-35V', 2, false]], country: 'US'});
    const mixed = order({lines: [['OPENFC-LITE-2020', 1], ['ACC-CAP-470UF-35V', 1, false]], country: 'US', usPromise: true});
    const campaignOnly = order({lines: [['OPENFC-LITE-2020', 1]], country: 'US', usPromise: true});
    const euInStock = order({lines: [['ACC-CAP-470UF-35V', 1, false]], country: 'BE'});
    const reviewed = order({lines: [['ACC-CAP-470UF-35V', 1, false]], country: 'US', tags: [US_REVIEW_TAG]});
    const plans = new Map(
      planPreorderHolds([inStockOnly, mixed, campaignOnly, euInStock, reviewed], REGIONAL).map((p) => [p.orderId, p]),
    );
    const only = plans.get(inStockOnly.id)!;
    assert.deepEqual(only.tags, [US_REVIEW_TAG]);
    assert.deepEqual(only.hold, [inStockOnly.fulfillmentOrders.nodes[0].id]);
    assert.match(only.note, /^US review/);
    const both = plans.get(mixed.id)!;
    assert.deepEqual(both.tags, ['preorder', 'batch:OPENFC-LITE-2020:2', US_REVIEW_TAG]);
    assert.ok(both.note.length <= 255);
    assert.ok(!plans.get(campaignOnly.id)!.tags.includes(US_REVIEW_TAG));
    // EU in-stock orders are not preorder orders: no plan, as before.
    assert.equal(plans.has(euInStock.id), false);
    // Idempotent: an order already tagged us-review is not planned again.
    assert.equal(plans.has(reviewed.id), false);
  });

  it('gives a US line for an unlisted SKU the usStock batch and no review; without the US line property it stays under review', () => {
    const withUsStock = parseCampaignConfig({
      countFrom: '2026-09-21',
      endsOn: '2026-12-31', shipsBy: '2027-03-11',
      priceTiers: [{upTo: 100, off: 0.2}],
      pendingShips: 'ships about 10 weeks after its target is reached',
      skus: {'OPENFC-LITE-2020': {batches: [{units: 3, paid: true, ships: 'ships early November 2026', regions: ['EU']}, {units: 250}]}},
      usStock: {sku: 'OPENFC-LITE-2020', batch: 2},
    });
    const usItem = order({lines: [['NEW-THING', 2]], country: 'US', usPromise: true});
    const euCartToUs = order({lines: [['NEW-THING', 1, false]], country: 'US'});
    const euItem = order({lines: [['NEW-THING', 1, false]], country: 'BE'});
    const batches = assignBatches([usItem, euCartToUs, euItem], withUsStock);
    const view = (o: PreorderOrder) => (batches.get(o.id) ?? []).map((b) => `${b.item ?? b.sku}:${b.sku}:${b.batch}:${b.units}`);
    assert.deepEqual(view(usItem), ['NEW-THING:OPENFC-LITE-2020:2:2']);
    assert.deepEqual(view(euCartToUs), []);
    assert.deepEqual(view(euItem), []);
    const plans = new Map(planPreorderHolds([usItem, euCartToUs, euItem], withUsStock).map((p) => [p.orderId, p]));
    assert.deepEqual(plans.get(usItem.id)!.tags, ['preorder', 'batch:OPENFC-LITE-2020:2']);
    assert.deepEqual(plans.get(euCartToUs.id)!.tags, [US_REVIEW_TAG]);
    assert.equal(plans.has(euItem.id), false);
    // Released with its batch, like any US preorder.
    const held = order({
      lines: [['NEW-THING', 1]], country: 'US', usPromise: true,
      tags: ['preorder', 'batch:OPENFC-LITE-2020:2'],
      holds: [{id: 'h1', handle: PREORDER_HOLD_HANDLE}],
    });
    assert.deepEqual(planRelease([held], 'OPENFC-LITE-2020', 2, new Set(), {}, withUsStock.usStock)[0].waitsFor, []);
  });

  it('never releases a us-review order with its batch', () => {
    const held = order({
      lines: [['OPENFC-LITE-2020', 1]],
      country: 'US',
      tags: ['preorder', 'batch:OPENFC-LITE-2020:2', US_REVIEW_TAG],
      holds: [{id: 'h1', handle: PREORDER_HOLD_HANDLE}],
    });
    const [plan] = planRelease([held], 'OPENFC-LITE-2020', 2, new Set());
    assert.deepEqual(plan.waitsFor, [US_REVIEW_TAG]);
  });

  it('never releases a pickup-leuven order with its batch', () => {
    const held = order({
      lines: [['OPENFC-LITE-2020', 1]],
      country: 'BE',
      tags: ['preorder', 'batch:OPENFC-LITE-2020:1', PICKUP_TAG],
      holds: [{id: 'h1', handle: PREORDER_HOLD_HANDLE}],
    });
    const [plan] = planRelease([held], 'OPENFC-LITE-2020', 1, new Set());
    assert.deepEqual(plan.waitsFor, [PICKUP_TAG]);
  });

  it('tags an order shipping to another region than its promise promise-mismatch', () => {
    const usPromiseToEu = order({lines: [['OPENFC-LITE-2020', 1]], country: 'DE', usPromise: true});
    const euPromiseToUs = order({lines: [['OPENFC-LITE-2020', 1]], country: 'US'});
    const matching = order({lines: [['OPENFC-LITE-2020', 1]], country: 'US', usPromise: true});
    const plans = new Map(planPreorderHolds([usPromiseToEu, euPromiseToUs, matching], REGIONAL).map((p) => [p.orderId, p.tags]));
    assert.ok(plans.get(usPromiseToEu.id)!.includes(PROMISE_MISMATCH_TAG));
    assert.ok(plans.get(euPromiseToUs.id)!.includes(PROMISE_MISMATCH_TAG));
    assert.ok(!plans.get(matching.id)!.includes(PROMISE_MISMATCH_TAG));
    // Batches follow the real shipping region: the US-promised order to DE takes paid stock.
    assert.ok(plans.get(usPromiseToEu.id)!.includes('batch:OPENFC-LITE-2020:1'));
    assert.ok(plans.get(euPromiseToUs.id)!.includes('batch:OPENFC-LITE-2020:2'));
  });
});


describe('international allocation and checkout address changes', () => {
  const config = parseCampaignConfig({
    countFrom:'2026-09-21', endsOn:'2026-12-15', shipsBy:'2027-03-31', priceTiers:[], pendingShips:'ships by 31 March 2027 if funded',
    skus:{'OPENFC-LITE-2020':{batches:[{units:250,paid:true,ships:'ships early November 2026',regions:['EU']},{units:250}]},
      'OPENRX-LITE':{batches:[{units:250}]}},
    shipsWith:{'ACC-ANT-T':{sku:'OPENFC-LITE-2020',batch:1,stock:1,after:2}},
    usStock:{sku:'OPENFC-LITE-2020',batch:2},
  });

  it('allocates a mixed international order from March while leaving EU paid units and accessories available', () => {
    const international = order({country:'CA', intPromise:true, lines:[['OPENFC-LITE-2020',2],['ACC-ANT-T',2],['OTHER-ACCESSORY',1],['OPENRX-LITE',1]]});
    const eu = order({country:'BE',lines:[['OPENFC-LITE-2020',1],['ACC-ANT-T',1]]});
    const batches = assignBatches([international,eu],config);
    assert.deepEqual(batches.get(international.id)?.map(b=>[b.item??b.sku,b.batch,b.units]),[
      ['OPENFC-LITE-2020',2,2],['ACC-ANT-T',2,2],['OTHER-ACCESSORY',2,1],['OPENRX-LITE',1,1],
    ]);
    assert.deepEqual(batches.get(eu.id)?.map(b=>[b.item??b.sku,b.batch,b.units]),[['OPENFC-LITE-2020',1,1],['ACC-ANT-T',1,1]]);
    const plan = planPreorderHolds([international],config)[0];
    assert.deepEqual(plan.tags,['preorder','batch:OPENFC-LITE-2020:2','batch:OPENRX-LITE:1']);
    assert.equal(plan.hold.length,1);
  });

  it('holds an EU cart completed with an international address and prevents automatic release of its changed promise', () => {
    const changed = order({country:'AU',lines:[['OPENFC-LITE-2020',1],['ACC-ANT-T',1],['OTHER-ACCESSORY',1,false]]});
    const plan = planPreorderHolds([changed],config)[0];
    assert.ok(plan.tags.includes(PROMISE_MISMATCH_TAG));
    assert.ok(plan.tags.includes(INT_REVIEW_TAG));
    assert.ok(plan.tags.includes('batch:OPENFC-LITE-2020:2'));
    assert.ok(!plan.tags.includes('batch:OPENFC-LITE-2020:1'));
    changed.tags = plan.tags;
    changed.fulfillmentOrders.nodes[0].fulfillmentHolds = [{id:'hold',handle:PREORDER_HOLD_HANDLE,reasonNotes:null}];
    const release = planRelease([changed],'OPENFC-LITE-2020',2,new Set(),config.shipsWith,config.usStock)[0];
    assert.deepEqual(release.waitsFor,[INT_REVIEW_TAG,PROMISE_MISMATCH_TAG]);
    assert.equal(planPreorderHolds([changed],config).length,0);
  });

  it('allocates a NEAR order (GB, CH, NO) recorded NEAR from March with no review, like INT', () => {
    for (const country of ['GB', 'CH', 'NO']) {
      const near = order({country, nearPromise:true, lines:[['OPENFC-LITE-2020',1],['OPENRX-LITE',1]]});
      const tags = planPreorderHolds([near],config)[0].tags;
      assert.ok(tags.includes('batch:OPENFC-LITE-2020:2'), country);
      assert.ok(!tags.includes('batch:OPENFC-LITE-2020:1'), country);
      assert.ok(!tags.includes(INT_REVIEW_TAG) && !tags.includes(US_REVIEW_TAG), country);
    }
  });

  it('puts a NEAR order whose lines were recorded for the EU on the international review tag, never the US one', () => {
    const changed = order({country:'CH', lines:[['OPENFC-LITE-2020',1]]});
    const tags = planPreorderHolds([changed],config)[0].tags;
    assert.ok(tags.includes(INT_REVIEW_TAG));
    assert.ok(!tags.includes(US_REVIEW_TAG));
  });

  it('accepts a line recorded INT on a GB/CH/NO order: the cart recorded them INT before NEAR existed', () => {
    const old = order({country:'CH', intPromise:true, lines:[['OPENFC-LITE-2020',1]]});
    const tags = planPreorderHolds([old],config)[0].tags;
    assert.ok(!tags.includes(INT_REVIEW_TAG));
    assert.ok(!tags.includes(PROMISE_MISMATCH_TAG));
  });

  it('retains an international accessory lead tag after its original lead line is removed', () => {
    const held = order({country:'NO',intPromise:true,lines:[['OTHER-ACCESSORY',1]],tags:['preorder','batch:OPENFC-LITE-2020:2'],holds:[{id:'hold',handle:PREORDER_HOLD_HANDLE}]});
    assert.deepEqual(planRelease([held],'OPENFC-LITE-2020',2,new Set(),{},config.usStock)[0].waitsFor,[]);
  });

  it('flags actual UK orders for payment review regardless of their preorder source attributes', () => {
    for (const intPromise of [true, false]) {
      const uk = (order({country:'GB',intPromise,lines:[['OPENFC-LITE-2020',1]]}));
      const plan = planPreorderHolds([uk],config)[0];
      assert.ok(plan.tags.includes(UK_VAT_REVIEW_TAG));
      assert.equal(plan.hold.length,1);
      assert.match(plan.note,/gross payment, currency and payment date/);
      uk.tags=plan.tags;
      uk.fulfillmentOrders.nodes[0].fulfillmentHolds=[{id:'hold',handle:PREORDER_HOLD_HANDLE,reasonNotes:null}];
      assert.equal(planPreorderHolds([uk],config).length,0);
      assert.ok(planRelease([uk],'OPENFC-LITE-2020',2,new Set(),config.shipsWith,config.usStock)[0].waitsFor.includes(UK_VAT_REVIEW_TAG));
    }
    const canadian=order({country:'CA',intPromise:true,lines:[['OPENFC-LITE-2020',1]]});
    assert.ok(!planPreorderHolds([canadian],config)[0].tags.includes(UK_VAT_REVIEW_TAG));
  });
});

describe('EU batch 1 stock ships now (founder 2026-11-03)', () => {
  const LIVE = parseCampaignConfig({
    countFrom: '2026-09-21',
    endsOn: '2026-12-31', shipsBy: '2027-03-31',
    priceTiers: [{upTo: 100, off: 0.2}],
    pendingShips: 'ships by 31 March 2027 if funded',
    skus: {
      'OPENFC-LITE-2020': {batches: [{units: 250, reserved: 50, paid: true, ships: 'ships late November 2026', regions: ['EU', 'INT']}, {units: 250}]},
      'OPENRX-LITE': {batches: [{units: 250}]},
    },
    usStock: {sku: 'OPENFC-LITE-2020', batch: 2},
  });
  /** The attributes the cart writes today for a line (shopify-cart-action `lineAttributes`). */
  const euStockLine = [
    {key: 'Shipping', value: 'In stock in Belgium, ships in a few working days.'},
    {key: SHIP_PROMISE_LINE_ATTRIBUTE, value: 'ships late November 2026'},
    {key: '_batch', value: 'OPENFC-LITE-2020:1'},
  ];
  const withAttrs = (o: PreorderOrder, attrs: Array<{key: string; value: string}>) => {
    for (const line of o.lineItems.nodes) if (line.sku === 'OPENFC-LITE-2020') line.customAttributes = attrs;
    return o;
  };

  it('pins the hidden promise key to the cart', () => {
    assert.equal(SHIP_PROMISE_LINE_ATTRIBUTE, SHIP_PROMISE_ATTRIBUTE);
  });

  it('tags an EU batch 1 order eu-stock with its batch once and never holds it, old or new line attributes, admin-made too', () => {
    const fresh = withAttrs(order({lines: [['OPENFC-LITE-2020', 2]], country: 'BE'}), euStockLine);
    const old = order({lines: [['OPENFC-LITE-2020', 1]], country: 'DE', promise: 'ships late November 2026', batch: 'OPENFC-LITE-2020:1'});
    const admin = order({lines: [['OPENFC-LITE-2020', 1, false]], country: 'FR'});
    const all = [fresh, old, admin];
    const plans = planPreorderHolds(all, LIVE);
    assert.deepEqual(plans.map((p) => [p.orderId, p.tags, p.hold]), all.map((o) => [o.id, [EU_STOCK_TAG, 'batch:OPENFC-LITE-2020:1'], []]));
    // Tagged, it is done: the next run plans nothing.
    for (const o of all) o.tags = [EU_STOCK_TAG, 'batch:OPENFC-LITE-2020:1'];
    assert.deepEqual(planPreorderHolds(all, LIVE), []);
    assert.equal(holdHealth(all, LIVE).unheld, 0);
    const batches = assignBatches(all, LIVE);
    assert.ok(all.every((o) => shipsFromEuStock(o, batches.get(o.id)!, LIVE)));
    // Its units still take batch 1 slots: the cap and the count are unchanged.
    assert.deepEqual(all.map((o) => batches.get(o.id)!.map((b) => [b.batch, b.units])), [[[1, 2]], [[1, 1]], [[1, 1]]]);
  });

  it('holds an EU batch 1 unit allocated past the cap like any preorder', () => {
    const filler = order({lines: [['OPENFC-LITE-2020', 200]], country: 'BE'});
    const over = withAttrs(order({lines: [['OPENFC-LITE-2020', 1]], country: 'BE'}), euStockLine);
    const plans = new Map(planPreorderHolds([filler, over], LIVE).map((p) => [p.orderId, p.tags]));
    assert.deepEqual(plans.get(filler.id), [EU_STOCK_TAG, 'batch:OPENFC-LITE-2020:1']);
    assert.deepEqual(plans.get(over.id), ['preorder', 'batch:OPENFC-LITE-2020:2', PROMISE_MISMATCH_TAG]);
  });

  it('holds a mixed EU order whole for March: FC + receiver', () => {
    const mixed = order({lines: [['OPENFC-LITE-2020', 1], ['OPENRX-LITE', 1]], country: 'BE', promise: 'ships with the rest of this order by 31 March 2027'});
    mixed.lineItems.nodes[0].customAttributes = [
      {key: 'Preorder', value: 'ships with the rest of this order by 31 March 2027'},
      {key: SHIP_PROMISE_LINE_ATTRIBUTE, value: 'ships late November 2026'},
      {key: '_batch', value: 'OPENFC-LITE-2020:1'},
      {key: PREORDER_OWN_LINE_ATTRIBUTE, value: 'ships late November 2026'},
    ];
    const [plan] = planPreorderHolds([mixed], LIVE);
    assert.deepEqual(plan.tags, ['preorder', 'batch:OPENFC-LITE-2020:2', 'batch:OPENRX-LITE:1']);
    assert.deepEqual(plan.hold, [mixed.fulfillmentOrders.nodes[0].id]);
  });

  // Batch 1 is EU only since 2026-11-03 (paidRegions). A non-EU order that
  // recorded a batch 1 promise is now allocated to the March batch, so it is
  // held with the international review and promise-mismatch tags for a
  // manual decision (the order keeps its recorded promise until then).
  it('keeps a non-EU line that recorded batch 1 in batch 1 (grandfathered), reviews EU lines shipped abroad, US as before', () => {
    const make = () => [
      order({lines: [['OPENFC-LITE-2020', 1]], country: 'CH', intPromise: true, promise: 'ships late November 2026', batch: 'OPENFC-LITE-2020:1'}),
      order({lines: [['OPENFC-LITE-2020', 1]], country: 'US', usPromise: true, promise: 'ships by 31 March 2027 if funded', batch: 'OPENFC-LITE-2020:2'}),
      order({lines: [['OPENFC-LITE-2020', 1]], country: 'NO'}),
      withAttrs(order({lines: [['OPENFC-LITE-2020', 1]], country: 'CH'}), euStockLine),
    ];
    const [intLine, usLine, euPromiseToInt, euStockToInt] = make();
    const plans = new Map(planPreorderHolds([intLine, usLine, euPromiseToInt, euStockToInt], LIVE).map((p) => [p.orderId, p]));
    assert.deepEqual(plans.get(intLine.id)?.tags, ['preorder', 'batch:OPENFC-LITE-2020:1']);
    assert.deepEqual(plans.get(usLine.id)?.tags, ['preorder', 'batch:OPENFC-LITE-2020:2']);
    assert.deepEqual(plans.get(euPromiseToInt.id)?.tags, ['preorder', 'batch:OPENFC-LITE-2020:2', INT_REVIEW_TAG, PROMISE_MISMATCH_TAG]);
    // An EU stock line shipped outside the EU reads `_ship_promise` as the
    // old `Preorder`: the same review and mismatch tags, held.
    assert.deepEqual(plans.get(euStockToInt.id)?.tags, plans.get(euPromiseToInt.id)?.tags);
    for (const p of plans.values()) assert.equal(p.hold.length, 1);
  });

  it('holds an INT line shipped to an EU address as before: promise-mismatch, no eu-stock', () => {
    const intToEu = order({lines: [['OPENFC-LITE-2020', 1]], country: 'BE', intPromise: true, promise: 'ships late November 2026', batch: 'OPENFC-LITE-2020:1'});
    const [plan] = planPreorderHolds([intToEu], LIVE);
    assert.deepEqual(plan.tags, ['preorder', 'batch:OPENFC-LITE-2020:1', PROMISE_MISMATCH_TAG]);
    assert.equal(plan.hold.length, 1);
  });

  it('reads an order without a shipping address as EU (the hold pass default): eu-stock, unheld', () => {
    const bare = withAttrs(order({lines: [['OPENFC-LITE-2020', 1]]}), euStockLine);
    assert.equal(bare.shippingAddress, undefined);
    const [plan] = planPreorderHolds([bare], LIVE);
    assert.deepEqual([plan.tags, plan.hold], [[EU_STOCK_TAG, 'batch:OPENFC-LITE-2020:1'], []]);
  });

  it('keeps holding a pickup-leuven order, so the bpost plugin never imports it', () => {
    const pickup = withAttrs(order({lines: [['OPENFC-LITE-2020', 1]], country: 'BE', tags: [PICKUP_TAG]}), euStockLine);
    const [plan] = planPreorderHolds([pickup], LIVE);
    assert.deepEqual(plan.tags, ['preorder', 'batch:OPENFC-LITE-2020:1']);
    assert.deepEqual(plan.hold, [pickup.fulfillmentOrders.nodes[0].id]);
  });

  it('finishes a legacy order held but never tagged (failed tag write) as a preorder, not eu-stock', () => {
    const legacy = withAttrs(order({
      lines: [['OPENFC-LITE-2020', 1]],
      country: 'BE',
      foStatus: 'ON_HOLD',
      holds: [{id: 'gid://shopify/FulfillmentHold/9', handle: PREORDER_HOLD_HANDLE}],
    }), euStockLine);
    const [plan] = planPreorderHolds([legacy], LIVE);
    assert.deepEqual(plan.tags, ['preorder', 'batch:OPENFC-LITE-2020:1']);
    assert.deepEqual(plan.hold, []);
    // The batch release then lifts its hold as for any preorder.
    legacy.tags = plan.tags;
    assert.equal(planRelease([legacy], 'OPENFC-LITE-2020', 1, new Set()).length, 1);
  });

  it('never retags an eu-stock order when a later allocation shift moves it; overfull reports the drift', () => {
    const stock = withAttrs(order({lines: [['OPENFC-LITE-2020', 1]], country: 'BE'}), euStockLine);
    const [first] = planPreorderHolds([stock], LIVE);
    stock.tags = first.tags;
    // An older order indexed late fills the batch ahead of it.
    const late = order({lines: [['OPENFC-LITE-2020', 200]], country: 'BE'});
    late.createdAt = '2026-09-01T00:00:00Z';
    const second = planPreorderHolds([late, stock], LIVE);
    assert.equal(second.some((p) => p.orderId === stock.id), false);
    assert.deepEqual(stock.tags, [EU_STOCK_TAG, 'batch:OPENFC-LITE-2020:1']);
    late.tags = second.find((p) => p.orderId === late.id)!.tags;
    assert.deepEqual(overfullBatches([late, stock], LIVE), [{sku: 'OPENFC-LITE-2020', batch: 1, units: 200, tagged: 201}]);
  });

  it('counts a partial refund back under the cap: the next unit is eu-stock and the batch is not overfull', () => {
    const filler = order({lines: [['OPENFC-LITE-2020', 200]], country: 'BE', tags: [EU_STOCK_TAG, 'batch:OPENFC-LITE-2020:1']});
    filler.lineItems.nodes[0].currentQuantity = 199;
    const next = withAttrs(order({lines: [['OPENFC-LITE-2020', 1]], country: 'BE'}), euStockLine);
    const [plan] = planPreorderHolds([filler, next], LIVE);
    assert.deepEqual([plan.orderId, plan.tags, plan.hold], [next.id, [EU_STOCK_TAG, 'batch:OPENFC-LITE-2020:1'], []]);
    next.tags = plan.tags;
    assert.deepEqual(overfullBatches([filler, next], LIVE), []);
  });
});

describe('non-EU lines sold batch 1 before it became EU only keep it (recorded _batch / promise, grandfatheredPaidLine)', () => {
  const NOW = parseCampaignConfig({
    countFrom: '2026-09-21',
    endsOn: '2026-12-31', shipsBy: '2027-03-31',
    priceTiers: [{upTo: 100, off: 0.2}],
    pendingShips: 'ships by 31 March 2027 if funded',
    paidRegions: ['EU'],
    skus: {'OPENFC-LITE-2020': {batches: [{units: 250, reserved: 50, paid: true, ships: 'ships late November 2026'}, {units: 250}]}},
    usStock: {sku: 'OPENFC-LITE-2020', batch: 2},
  });
  it('an old GB order with batch 1 attributes (_batch, INT) stays in batch 1, no promise-mismatch or review', () => {
    const old = order({country: 'GB', intPromise: true, promise: 'ships late November 2026', batch: 'OPENFC-LITE-2020:1', lines: [['OPENFC-LITE-2020', 1]]});
    const plan = planPreorderHolds([old], NOW)[0];
    assert.ok(plan.tags.includes('batch:OPENFC-LITE-2020:1'), plan.tags.join(','));
    assert.ok(!plan.tags.includes(PROMISE_MISMATCH_TAG));
    assert.ok(!plan.tags.includes(INT_REVIEW_TAG));
  });
  it('an old line without _batch is kept by its paid-batch promise', () => {
    const old = order({country: 'CA', intPromise: true, promise: 'ships late November 2026', lines: [['OPENFC-LITE-2020', 1]]});
    assert.ok(planPreorderHolds([old], NOW)[0].tags.includes('batch:OPENFC-LITE-2020:1'));
  });
  it('a new GB order (NEAR, March promise) takes the March batch, whatever its date', () => {
    const fresh = order({country: 'GB', nearPromise: true, promise: 'ships by 31 March 2027 if funded', batch: 'OPENFC-LITE-2020:2', lines: [['OPENFC-LITE-2020', 1]]});
    fresh.createdAt = '2026-09-01T00:00:00Z';
    const plan = planPreorderHolds([fresh], NOW)[0];
    assert.ok(plan.tags.includes('batch:OPENFC-LITE-2020:2'), plan.tags.join(','));
    assert.ok(!plan.tags.includes(PROMISE_MISMATCH_TAG));
  });
  it('an EU batch 1 line shipped to GB is not grandfathered: it is reviewed', () => {
    const moved = order({country: 'GB', promise: 'ships late November 2026', batch: 'OPENFC-LITE-2020:1', lines: [['OPENFC-LITE-2020', 1]]});
    const plan = planPreorderHolds([moved], NOW)[0];
    assert.ok(plan.tags.includes('batch:OPENFC-LITE-2020:2'), plan.tags.join(','));
    assert.ok(plan.tags.includes(INT_REVIEW_TAG));
  });
  it('a grandfathered unit fills batch 1 ahead of later EU units', () => {
    const old = order({country: 'GB', intPromise: true, promise: 'ships late November 2026', batch: 'OPENFC-LITE-2020:1', lines: [['OPENFC-LITE-2020', 200]]});
    const eu = order({lines: [['OPENFC-LITE-2020', 1]]});
    const plans = new Map(planPreorderHolds([old, eu], NOW).map((p) => [p.orderId, p]));
    // 200 sellable in batch 1: the old GB order took them all, the EU unit goes to March.
    assert.ok(plans.get(eu.id)!.tags.includes('batch:OPENFC-LITE-2020:2'), plans.get(eu.id)!.tags.join(','));
  });
});

describe('grandfathered lines: mixed orders, and the storefront count agrees with the planner', () => {
  const NOW = parseCampaignConfig({
    countFrom: '2026-09-21',
    endsOn: '2026-12-31', shipsBy: '2027-03-31',
    priceTiers: [{upTo: 100, off: 0.2}],
    pendingShips: 'ships by 31 March 2027 if funded',
    paidRegions: ['EU'],
    skus: {
      'OPENFC-LITE-2020': {batches: [{units: 250, reserved: 50, paid: true, ships: 'ships late November 2026'}, {units: 250}]},
      'OPENESC-2020': {batches: [{units: 250, reserved: 50, paid: true, ships: 'ships late November 2026'}, {units: 250}]},
    },
    usStock: {sku: 'OPENFC-LITE-2020', batch: 2},
  });
  const OLD = [{key: 'Preorder', value: 'ships late November 2026'}, {key: '_ship_region', value: 'INT'}, {key: '_batch', value: 'OPENFC-LITE-2020:1'}];
  const NEW = [{key: 'Preorder', value: 'ships by 31 March 2027 if funded'}, {key: '_ship_region', value: 'NEAR'}, {key: '_batch', value: 'OPENESC-2020:2'}];
  const mixed = () => {
    const o = order({country: 'GB', lines: [['OPENFC-LITE-2020', 1], ['OPENESC-2020', 1]]});
    o.lineItems.nodes[0].customAttributes = OLD;
    o.lineItems.nodes[1].customAttributes = NEW;
    return o;
  };
  it('an order mixing a grandfathered line and a new line keeps each line on its own batch, no mismatch', () => {
    const plan = planPreorderHolds([mixed()], NOW)[0];
    assert.ok(plan.tags.includes('batch:OPENFC-LITE-2020:1'), plan.tags.join(','));
    assert.ok(plan.tags.includes('batch:OPENESC-2020:2'), plan.tags.join(','));
    assert.ok(!plan.tags.includes(PROMISE_MISMATCH_TAG));
    assert.ok(!plan.tags.includes(INT_REVIEW_TAG));
  });
  it('fetchPaidUnitRuns and assignBatches put the same units in the same batches', async () => {
    const refunded = order({country: 'CA', intPromise: true, promise: 'ships late November 2026', batch: 'OPENFC-LITE-2020:1', lines: [['OPENFC-LITE-2020', 3]]});
    refunded.displayFinancialStatus = 'PARTIALLY_REFUNDED';
    refunded.lineItems.nodes[0].currentQuantity = 2;
    const orders = [
      order({lines: [['OPENFC-LITE-2020', 4], ['OPENESC-2020', 2]]}),
      mixed(),
      refunded,
      order({country: 'GB', nearPromise: true, promise: 'ships by 31 March 2027 if funded', batch: 'OPENFC-LITE-2020:2', lines: [['OPENFC-LITE-2020', 2]]}),
      order({country: 'AU', intPromise: true, promise: 'ships by 31 March 2027 if funded', batch: 'OPENESC-2020:2', lines: [['OPENESC-2020', 1]]}),
    ];
    const runs = await fetchPaidUnitRuns(ENV, '2026-09-21', new Set(Object.keys(NOW.skus)), async () =>
      Response.json({data: {orders: {pageInfo: {hasNextPage: false, endCursor: null}, nodes: orders}}}),
    NOW);
    const planned = assignBatches(orders, NOW);
    for (const sku of Object.keys(NOW.skus)) {
      const fromPlanner = [0, 0];
      for (const lines of planned.values()) for (const b of lines) if (b.sku === sku && !b.item) fromPlanner[b.batch - 1] += b.units;
      const fromCounts = batchFill(NOW.skus[sku].batches, runs[sku] ?? []);
      assert.deepEqual(fromCounts.slice(0, 2), fromPlanner, sku);
    }
    // FC batch 1: 4 EU + 1 grandfathered GB + 2 grandfathered CA (after the refund).
    assert.equal(batchFill(NOW.skus['OPENFC-LITE-2020'].batches, runs['OPENFC-LITE-2020'])[0], 7);
  });
});
