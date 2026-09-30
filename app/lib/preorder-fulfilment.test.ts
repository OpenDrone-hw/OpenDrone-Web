import assert from 'node:assert/strict';
import {afterEach, describe, it} from 'node:test';
import {
  PREORDER_HOLD_HANDLE,
  PREORDER_LINE_ATTRIBUTE,
  PROMISE_MISMATCH_TAG,
  US_REVIEW_TAG,
  SHIP_REGION_LINE_ATTRIBUTE,
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
import {PREORDER_ATTRIBUTE, SHIP_REGION_ATTRIBUTE} from './shopify-storefront.ts';
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
              {key: 'Preorder', value: 'ships early November 2026'},
              ...(partial.usPromise ? [{key: '_ship_region', value: 'US'}] : []),
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
