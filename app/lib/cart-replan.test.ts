import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import type {Catalog} from './catalog.ts';
import {clearCatalogMemo, recentCatalog, rememberCatalog} from './catalog-memo.ts';
import {REPLAN_REUSE_MS, cartReplannedCookie, cartReplannedFor, planCartPage, reuseSwitchCatalog} from './cart-replan.ts';
import type {ShippingQuote} from './shipping-rates.ts';
import type {ShopifyCart} from './shopify-storefront.ts';

const BE: ShippingQuote = {country: 'BE', kind: 'direct', zone: 'be', rate: 6} as ShippingQuote;
const EMPTY = {id: 'gid://shopify/Cart/a', checkoutUrl: '', totalQuantity: 0, subtotal: {amount: '0', currencyCode: 'EUR'}, total: {amount: '0', currencyCode: 'EUR'}, country: 'BE', lines: []} as unknown as ShopifyCart;
const CATALOG = {schema: 1, products: []} as unknown as Catalog;
const ENV = {SHOPIFY_CHECKOUT_WRITE_ENABLED: '1', PUBLIC_COMING_SOON: '0', PUBLIC_US_SALES: '0'} as never;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('the switch marker', () => {
  it('is a 15 s HttpOnly cookie naming the country, and reads back', () => {
    assert.equal(cartReplannedCookie('be'), 'od_cart_replanned=BE; Path=/; Max-Age=15; HttpOnly; SameSite=Lax; Secure');
    assert.equal(REPLAN_REUSE_MS, 15_000);
    assert.equal(cartReplannedFor('a=1; od_cart_replanned=BE; b=2'), 'BE');
    assert.equal(cartReplannedFor('od_cart_replanned=nope'), null);
    assert.equal(cartReplannedFor(null), null);
  });
  it('is honoured only for the destination being planned on a cart that already carries it', () => {
    assert.equal(reuseSwitchCatalog('BE', BE, {country: 'BE'}), true);
    assert.equal(reuseSwitchCatalog(null, BE, {country: 'BE'}), false);
    assert.equal(reuseSwitchCatalog('DE', BE, {country: 'BE'}), false);
    assert.equal(reuseSwitchCatalog('BE', BE, {country: 'US'}), false);
    assert.equal(reuseSwitchCatalog('BE', {country: 'BE', kind: 'closed'} as ShippingQuote, {country: 'BE'}), false);
    assert.equal(reuseSwitchCatalog('BE', null, {country: 'BE'}), false);
  });
});

describe('the recent catalog memo', () => {
  it('reuses a remembered read younger than the window, reads again after', async () => {
    clearCatalogMemo();
    let reads = 0;
    const load = async () => { reads += 1; return CATALOG; };
    rememberCatalog('default', CATALOG, () => 1_000);
    await recentCatalog('default', REPLAN_REUSE_MS, load, () => 1_000 + REPLAN_REUSE_MS - 1);
    assert.equal(reads, 0);
    await recentCatalog('default', REPLAN_REUSE_MS, load, () => 1_000 + REPLAN_REUSE_MS);
    assert.equal(reads, 1);
    clearCatalogMemo();
  });
});

describe('planCartPage', () => {
  it('reads the payment methods alongside the re-plan, not after it', async () => {
    const started = Date.now();
    const plan = await planCartPage(EMPTY, BE, ENV, null, {
      fresh: async () => { await sleep(120); return CATALOG; },
      recent: async () => CATALOG,
      fetchPaymentMethods: async () => { await sleep(120); return ['visa']; },
    });
    const took = Date.now() - started;
    assert.deepEqual(plan.payments, ['visa']);
    assert.ok(took < 200, `took ${took} ms`);
  });
  it('a failed re-plan or payment read degrades as before: the cart unplanned, no methods', async () => {
    const plan = await planCartPage(EMPTY, BE, ENV, null, {
      fresh: async () => { throw new Error('storefront down'); },
      recent: async () => CATALOG,
      fetchPaymentMethods: async () => { throw new Error('admin down'); },
    });
    assert.equal(plan.catalog, null);
    assert.equal(plan.cart, EMPTY);
    assert.deepEqual(plan.payments, []);
  });
});
