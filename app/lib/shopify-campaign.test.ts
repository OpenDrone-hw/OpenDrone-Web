import assert from 'node:assert/strict';
import {afterEach, describe, it} from 'node:test';
import type {Catalog} from './catalog.ts';
import {
  applyCampaignProgress,
  fetchShopifyCampaignProgress,
  resetCampaignProgressMemo,
} from './shopify-campaign.ts';

afterEach(resetCampaignProgressMemo);

const CATALOG = {
  schema: 1, generated_at: '', max_age: 0, currency: 'EUR', prices_include_vat: true,
  shop_url: '', cart_url: '', add_url: '', products: [{
    handle: 'openesc', title: 'OpenESC', family: 'ESC', description: null, url: '/products/openesc', images: [], rating: null,
    variants: [
      {sku: 'OPENESC-2020', title: '20×20', model: '20×20', options: {}, price: 35, compare_price: null, currency: 'EUR', availability: 'preorder', ship_promise: null, image: null, url: '', cart_add_url: ''},
      {sku: 'OPENESC-3030', title: '30×30', model: '30×30', options: {}, price: 45, compare_price: null, currency: 'EUR', availability: 'preorder', ship_promise: null, image: null, url: '', cart_add_url: ''},
    ],
  }],
} as Catalog;

describe('Shopify preorder campaign progress', () => {
  it('counts only paid, non-cancelled OpenDrone preorder lines', async () => {
    const snapshot = await fetchShopifyCampaignProgress({
      SHOPIFY_STORE_DOMAIN: 'store.myshopify.com', SHOPIFY_ADMIN_API_TOKEN: 'token', SHOPIFY_ADMIN_API_VERSION: '2026-07',
    } as Env, async () => new Response(JSON.stringify({data: {orders: {
      pageInfo: {hasNextPage: false, endCursor: null},
      nodes: [
        {cancelledAt: null, displayFinancialStatus: 'PAID', customAttributes: [{key: 'OpenDrone order type', value: 'Pre-order'}], lineItems: {pageInfo: {hasNextPage: false}, nodes: [{sku: 'OPENESC-2020', currentQuantity: 3}]}},
        {cancelledAt: null, displayFinancialStatus: 'PENDING', customAttributes: [{key: 'OpenDrone order type', value: 'Pre-order'}], lineItems: {pageInfo: {hasNextPage: false}, nodes: [{sku: 'OPENESC-2020', currentQuantity: 99}]}},
        {cancelledAt: null, displayFinancialStatus: 'PAID', customAttributes: [], lineItems: {pageInfo: {hasNextPage: false}, nodes: [{sku: 'OPENESC-2020', currentQuantity: 99}]}},
      ],
    }}}), {headers: {'Content-Type': 'application/json'}}));
    assert.deepEqual(snapshot.unitsBySku, {'OPENESC-2020': 3});
  });

  it('attaches per-SKU goals and a product summary without capping orders', () => {
    const catalog = applyCampaignProgress(CATALOG, {unitsBySku: {'OPENESC-2020': 1200, 'OPENESC-3030': 25}, updatedAt: ''});
    assert.equal(catalog.products[0].variants[0].campaign_target, 1000);
    assert.equal(catalog.products[0].variants[0].campaign_units_funded, 1200);
    assert.equal(catalog.products[0].funding?.targetUnits, 2000);
    assert.equal(catalog.products[0].funding?.unitsFunded, 1225);
    assert.equal(catalog.products[0].funding?.state, 'open');
  });
});
