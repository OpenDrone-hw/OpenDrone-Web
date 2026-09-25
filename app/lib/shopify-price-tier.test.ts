import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {parseCampaignConfig} from './preorder-campaign.ts';
import {priceTierWritesEnabled, syncPriceTiers, targetPrice} from './shopify-price-tier.ts';

const CONFIG = parseCampaignConfig({
  countFrom: '2026-09-21',
  endsOn: '2026-12-31',
  priceTiers: [{upTo: 100, off: 0.2}, {upTo: 250, off: 0.1}],
  pendingShips: 'ships later',
  skus: {'OPENESC-2020': {batches: [{units: 250}]}, 'OPENRX-LITE': {batches: [{units: 250}]}},
});

const ENV = {
  SHOPIFY_STORE_DOMAIN: 'shop.myshopify.com',
  SHOPIFY_ADMIN_API_TOKEN: 'token',
  SHOPIFY_ADMIN_API_VERSION: '2026-07',
  SHOPIFY_PRICE_TIER_WRITE_ENABLED: '1',
} as const;

/** Admin API double: one variants read, then the bulk updates. */
function shopify(variants: Array<{sku: string; price: string; compareAtPrice: string | null}>) {
  const calls: Array<{query: string; variables: Record<string, unknown>}> = [];
  const fetcher = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as {query: string; variables: Record<string, unknown>};
    calls.push(body);
    if (body.query.includes('productVariants(')) {
      return new Response(
        JSON.stringify({
          data: {
            productVariants: {
              nodes: variants.map((v, i) => ({
                id: `gid://shopify/ProductVariant/${i}`,
                sku: v.sku,
                price: v.price,
                compareAtPrice: v.compareAtPrice,
                product: {id: `gid://shopify/Product/${i}`},
              })),
            },
          },
        }),
        {status: 200},
      );
    }
    return new Response(
      JSON.stringify({data: {productVariantsBulkUpdate: {userErrors: []}}}),
      {status: 200},
    );
  }) as unknown as typeof fetch;
  return {calls, fetcher};
}

describe('targetPrice', () => {
  it('walks the steps and ends at retail with no compare-at price', () => {
    assert.deepEqual(targetPrice(CONFIG, 0, 50), {price: 40, compareAt: 50});
    assert.deepEqual(targetPrice(CONFIG, 99, 50), {price: 40, compareAt: 50});
    assert.deepEqual(targetPrice(CONFIG, 100, 50), {price: 45, compareAt: 50});
    assert.deepEqual(targetPrice(CONFIG, 249, 50), {price: 45, compareAt: 50});
    assert.deepEqual(targetPrice(CONFIG, 250, 50), {price: 50, compareAt: null});
  });
});

describe('priceTierWritesEnabled', () => {
  it('is off for anything but "1"', () => {
    assert.equal(priceTierWritesEnabled({...ENV, SHOPIFY_PRICE_TIER_WRITE_ENABLED: '1'}), true);
    assert.equal(priceTierWritesEnabled({...ENV, SHOPIFY_PRICE_TIER_WRITE_ENABLED: '0'}), false);
    assert.equal(priceTierWritesEnabled({...ENV, SHOPIFY_PRICE_TIER_WRITE_ENABLED: undefined}), false);
  });
});

describe('syncPriceTiers', () => {
  it('writes only the SKU whose step changed', async () => {
    const {calls, fetcher} = shopify([
      {sku: 'OPENESC-2020', price: '39.20', compareAtPrice: '49.00'},
      {sku: 'OPENRX-LITE', price: '16.80', compareAtPrice: '21.00'},
    ]);
    const result = await syncPriceTiers(
      ENV,
      CONFIG,
      {'OPENESC-2020': 120, 'OPENRX-LITE': 4},
      {apply: true, fetcher},
    );
    assert.deepEqual(result.changed, [{sku: 'OPENESC-2020', from: 39.2, to: 44.1, compareAt: 49}]);
    assert.equal(result.applied, true);
    const update = calls.find((c) => c.query.includes('productVariantsBulkUpdate'));
    assert.deepEqual(update?.variables.variants, [
      {id: 'gid://shopify/ProductVariant/0', price: '44.10', compareAtPrice: '49.00'},
    ]);
    assert.equal(calls.filter((c) => c.query.includes('productVariantsBulkUpdate')).length, 1);
  });

  it('clears the compare-at price past the last step', async () => {
    const {fetcher} = shopify([
      {sku: 'OPENESC-2020', price: '44.10', compareAtPrice: '49.00'},
      {sku: 'OPENRX-LITE', price: '16.80', compareAtPrice: '21.00'},
    ]);
    const result = await syncPriceTiers(ENV, CONFIG, {'OPENESC-2020': 250}, {apply: true, fetcher});
    assert.deepEqual(result.changed, [{sku: 'OPENESC-2020', from: 44.1, to: 49, compareAt: null}]);
  });

  it('leaves a SKU already at retail alone once its steps are used up', async () => {
    const {calls, fetcher} = shopify([
      {sku: 'OPENESC-2020', price: '49.00', compareAtPrice: null},
      {sku: 'OPENRX-LITE', price: '16.80', compareAtPrice: '21.00'},
    ]);
    const result = await syncPriceTiers(ENV, CONFIG, {'OPENESC-2020': 300}, {apply: true, fetcher});
    assert.deepEqual(result.changed, []);
    assert.equal(calls.some((c) => c.query.includes('productVariantsBulkUpdate')), false);
  });

  it('plans without writing on a dry run, and names what it skipped', async () => {
    const {calls, fetcher} = shopify([{sku: 'OPENESC-2020', price: '39.20', compareAtPrice: '49.00'}]);
    const result = await syncPriceTiers(ENV, CONFIG, {'OPENESC-2020': 120}, {fetcher});
    assert.equal(result.applied, false);
    assert.equal(result.changed.length, 1);
    assert.deepEqual(result.skipped, {'OPENRX-LITE': 'not in Shopify'});
    assert.equal(calls.some((c) => c.query.includes('productVariantsBulkUpdate')), false);
  });

  it('throws when Shopify reports an error, so the webhook retries', async () => {
    const fetcher = (async () =>
      new Response(JSON.stringify({errors: [{message: 'Throttled'}]}), {status: 200})) as unknown as typeof fetch;
    await assert.rejects(
      () => syncPriceTiers(ENV, CONFIG, {'OPENESC-2020': 1}, {apply: true, fetcher}),
      /Throttled/,
    );
  });
});

describe('per-SKU price steps', () => {
  const MOTORS = parseCampaignConfig({
    countFrom: '2026-09-21',
    endsOn: '2026-12-31',
    priceTiers: [{upTo: 100, off: 0.2}, {upTo: 250, off: 0.1}],
    pendingShips: 'ships later',
    skus: {
      'OPENESC-2020': {batches: [{units: 250}]},
      'OPENMOTOR-1604': {
        batches: [{units: 1000}],
        priceTiers: [{upTo: 250, off: 0.2}, {upTo: 1000, off: 0.1}],
      },
    },
  });

  it('steps a SKU with its own tiers at its own unit counts', () => {
    assert.deepEqual(targetPrice(MOTORS, 200, 20, 'OPENMOTOR-1604'), {price: 16, compareAt: 20});
    assert.deepEqual(targetPrice(MOTORS, 250, 20, 'OPENMOTOR-1604'), {price: 18, compareAt: 20});
    assert.deepEqual(targetPrice(MOTORS, 999, 20, 'OPENMOTOR-1604'), {price: 18, compareAt: 20});
    assert.deepEqual(targetPrice(MOTORS, 1000, 20, 'OPENMOTOR-1604'), {price: 20, compareAt: null});
  });

  it('keeps the campaign tiers for a SKU without its own', () => {
    assert.deepEqual(targetPrice(MOTORS, 200, 50, 'OPENESC-2020'), {price: 45, compareAt: 50});
  });

  it('writes a motor at the 20% step until unit 250', async () => {
    const {fetcher} = shopify([
      {sku: 'OPENESC-2020', price: '40.00', compareAtPrice: '50.00'},
      {sku: 'OPENMOTOR-1604', price: '15.20', compareAtPrice: '19.00'},
    ]);
    const result = await syncPriceTiers(ENV, MOTORS, {'OPENMOTOR-1604': 120}, {apply: true, fetcher});
    assert.deepEqual(result.changed, []);
  });

  it('refuses per-SKU tiers that do not increase', () => {
    assert.throws(
      () =>
        parseCampaignConfig({
          countFrom: '2026-09-21',
          endsOn: '2026-12-31',
          priceTiers: [{upTo: 100, off: 0.2}],
          pendingShips: 'ships later',
          skus: {X: {batches: [{units: 10}], priceTiers: [{upTo: 250, off: 0.2}, {upTo: 100, off: 0.1}]}},
        }),
      /X priceTiers need whole, increasing upTo values/,
    );
  });
});
