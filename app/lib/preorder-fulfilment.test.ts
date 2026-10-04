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
  assignBatches,
  batchOfUnit,
  batchPromiseMismatch,
  holdHealth,
  holdNote,
  overfullBatches,
  planPreorderHolds,
  planRelease,
  syncPreorderHolds,
  type PreorderOrder,
} from './preorder-fulfilment.ts';
import {reconcilePreorders} from './preorder-ops.ts';
import {opsStatus, resetOpsStatus} from './preorder-ops-status.ts';
import {parseCampaignConfig} from './preorder-campaign.ts';
import {BATCH_ATTRIBUTE, PREORDER_ATTRIBUTE, PREORDER_OWN_ATTRIBUTE, SHIP_REGION_ATTRIBUTE} from './shopify-storefront.ts';
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
    const second = order({lines: [['OPENFC-LITE-2020', 5], ['OPENRX-LITE', 1]]});
    // Listed out of order: creation time decides.
    const result = assignBatches([second, refunded, first], CONFIG);
    assert.deepEqual(result.get(first.id), [
      {sku: 'OPENFC-LITE-2020', batch: 1, units: 248, shipPromise: 'ships early November 2026'},
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
    assert.match(plans[0].note, /OPENFC-LITE-2020 batch 1 \(ships early November 2026\)/);
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
    const admin = order({lines: [['OPENFC-LITE-2020', 1, false]]});
    const accessory = order({lines: [['ACC-PROP-5-HQ-J37', 1, false]]});
    const other = order({lines: [['ACC-STRAP', 1, false]]});
    const removed = order({lines: [['OPENFC-LITE-2020', 0, false]]});
    const withAccessory = parseCampaignConfig({...CONFIG, shipsWith: {'ACC-PROP-5-HQ-J37': {sku: 'OPENFC-LITE-2020', batch: 1}}});
    const plans = new Map(planPreorderHolds([admin, accessory, other, removed], withAccessory).map((p) => [p.orderId, p]));
    assert.deepEqual(plans.get(admin.id)?.tags, ['preorder', 'batch:OPENFC-LITE-2020:1']);
    assert.deepEqual(plans.get(admin.id)?.hold, [admin.fulfillmentOrders.nodes[0].id]);
    assert.deepEqual(plans.get(accessory.id)?.tags, ['preorder', 'batch:OPENFC-LITE-2020:1']);
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
    assert.deepEqual(plans.get(first.id), ['preorder', 'batch:OPENFC-LITE-2020:1']);
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
    const [plan] = planPreorderHolds([props], WITH);
    assert.deepEqual(plan.tags, ['preorder', 'batch:OPENFC-LITE-2020:1']);
    assert.match(plan.note, /ACC-PROP-5-HQ-J37 with OPENFC-LITE-2020 batch 1/);
  });

  it('tags accessory units on hand with the dated batch and the rest with the run', () => {
    const stocked = parseCampaignConfig({
      ...CONFIG,
      shipsWith: {'ACC-ANT-T': {sku: 'OPENFC-LITE-2020', batch: 1, stock: 4, after: 2}},
    });
    const first = order({lines: [['ACC-ANT-T', 3]]});
    const second = order({lines: [['ACC-ANT-T', 3]]});
    const assigned = assignBatches([first, second], stocked);
    assert.deepEqual(assigned.get(first.id)?.map((b) => [b.batch, b.units]), [[1, 3]]);
    assert.deepEqual(assigned.get(second.id)?.map((b) => [b.batch, b.units, b.shipPromise]), [
      [1, 1, 'ships early November 2026'],
      [2, 2, CONFIG.pendingShips],
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
    // EU: the last paid unit, then batch 2; one antenna from stock, one after.
    assert.deepEqual(view(eu2), ['OPENFC-LITE-2020:1:1', 'OPENFC-LITE-2020:2:1', 'ACC-ANT-T:1:1', 'ACC-ANT-T:2:1']);
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

  it('retains an international accessory lead tag after its original lead line is removed', () => {
    const held = order({country:'NO',intPromise:true,lines:[['OTHER-ACCESSORY',1]],tags:['preorder','batch:OPENFC-LITE-2020:2'],holds:[{id:'hold',handle:PREORDER_HOLD_HANDLE}]});
    assert.deepEqual(planRelease([held],'OPENFC-LITE-2020',2,new Set(),{},config.usStock)[0].waitsFor,[]);
  });

  it('flags actual UK orders for payment review regardless of their preorder source attributes', () => {
    for (const intPromise of [true, false]) {
      const uk = order({country:'GB',intPromise,lines:[['OPENFC-LITE-2020',1]]});
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
