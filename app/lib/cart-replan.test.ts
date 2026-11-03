import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import type {Catalog} from './catalog.ts';
import {clearCatalogMemo, readAndRemember, recentCatalog, rememberCatalog} from './catalog-memo.ts';
import {REPLAN_REUSE_MS, cartReplannedCookie, cartReplannedFor, cartTag, planCartPage, reuseSwitchCatalog} from './cart-replan.ts';
import {readFileSync} from 'node:fs';
import type {ShippingQuote} from './shipping-rates.ts';
import type {ShopifyCart} from './shopify-storefront.ts';

const BE: ShippingQuote = {country: 'BE', kind: 'direct', zone: 'be', rate: 6} as ShippingQuote;
const EMPTY = {id: 'gid://shopify/Cart/a', checkoutUrl: '', totalQuantity: 0, subtotal: {amount: '0', currencyCode: 'EUR'}, total: {amount: '0', currencyCode: 'EUR'}, country: 'BE', lines: []} as unknown as ShopifyCart;
const CATALOG = {schema: 1, products: []} as unknown as Catalog;
const ENV = {SHOPIFY_CHECKOUT_WRITE_ENABLED: '1', PUBLIC_COMING_SOON: '0', PUBLIC_US_SALES: '0'} as never;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('the switch marker', () => {
  it('is a 15 s HttpOnly cookie naming the country and a tag of the cart, and reads back', () => {
    const tag = cartTag('gid://shopify/Cart/a');
    assert.match(tag, /^[0-9a-f]{8}$/);
    assert.notEqual(tag, cartTag('gid://shopify/Cart/b'));
    assert.equal(cartReplannedCookie('be', 'gid://shopify/Cart/a'), `od_cart_replanned=BE.${tag}; Path=/; Max-Age=15; HttpOnly; SameSite=Lax; Secure`);
    assert.equal(cartReplannedCookie('BE', 'x', false).includes('Secure'), false);
    assert.equal(REPLAN_REUSE_MS, 15_000);
    assert.deepEqual(cartReplannedFor(`a=1; od_cart_replanned=BE.${tag}; b=2`), {country: 'BE', cart: tag});
    assert.equal(cartReplannedFor('od_cart_replanned=BE'), null);
    assert.equal(cartReplannedFor('od_cart_replanned=nope'), null);
    assert.equal(cartReplannedFor(null), null);
  });
  it('is honoured only for this cart, the destination being planned, on a cart that already carries it', () => {
    const cart = {id: 'gid://shopify/Cart/a', country: 'BE'};
    const mine = {country: 'BE', cart: cartTag(cart.id)};
    assert.equal(reuseSwitchCatalog(mine, BE, cart), true);
    assert.equal(reuseSwitchCatalog(null, BE, cart), false);
    assert.equal(reuseSwitchCatalog({...mine, cart: cartTag('gid://shopify/Cart/b')}, BE, cart), false);
    assert.equal(reuseSwitchCatalog({...mine, country: 'DE'}, BE, cart), false);
    assert.equal(reuseSwitchCatalog(mine, BE, {...cart, country: 'US'}), false);
    assert.equal(reuseSwitchCatalog(mine, {country: 'BE', kind: 'closed'} as ShippingQuote, cart), false);
    assert.equal(reuseSwitchCatalog(mine, null, cart), false);
  });
});

describe('the recent catalog memo', () => {
  const A = {schema: 1, products: [], generated_at: 'A'} as unknown as Catalog;
  const B = {schema: 1, products: [], generated_at: 'B'} as unknown as Catalog;
  it('reuses a remembered read younger than the window, reads again after', async () => {
    clearCatalogMemo();
    let reads = 0;
    const load = async () => { reads += 1; return CATALOG; };
    rememberCatalog('default', CATALOG, 1_000);
    await recentCatalog('default', REPLAN_REUSE_MS, load, () => 1_000 + REPLAN_REUSE_MS - 1);
    assert.equal(reads, 0);
    await recentCatalog('default', REPLAN_REUSE_MS, load, () => 1_000 + REPLAN_REUSE_MS);
    assert.equal(reads, 1);
    clearCatalogMemo();
  });
  it('out-of-order writes keep the newer catalog, and a slow read never makes it look younger', async () => {
    clearCatalogMemo();
    rememberCatalog('default', B, 2_000); // started later, finished first
    rememberCatalog('default', A, 1_000); // started earlier, finished last: ignored
    const got = await recentCatalog('default', 10_000, async () => { throw new Error('no read expected'); }, () => 2_500);
    assert.equal((got as unknown as {generated_at: string}).generated_at, 'B');
    // Its age still counts from 2_000: at 2_000 + window it is read again.
    let reads = 0;
    await recentCatalog('default', 10_000, async () => { reads += 1; return A; }, () => 12_000);
    assert.equal(reads, 1);
    clearCatalogMemo();
  });
  it('a read is stamped when it started', async () => {
    clearCatalogMemo();
    let t = 5_000;
    await recentCatalog('default', 1_000, async () => { t = 9_000; return A; }, () => t);
    // Stamped 5_000: at 5_999 (when time reads 5_999) it is still fresh, at 6_000 it is not.
    let reads = 0;
    await recentCatalog('default', 1_000, async () => { reads += 1; return B; }, () => 5_999);
    assert.equal(reads, 0);
    await recentCatalog('default', 1_000, async () => { reads += 1; return B; }, () => 6_000);
    assert.equal(reads, 1);
    clearCatalogMemo();
  });
});

describe('createCatalogClient: fresh writes the memo, recent reuses it', () => {
  it('a fresh read is kept, and the next recent read reuses it; fresh always reads', async () => {
    clearCatalogMemo();
    let calls = 0;
    const load = async () => { calls += 1; return CATALOG; };
    await readAndRemember('default', load, () => 1_000);
    assert.equal(calls, 1);
    await recentCatalog('default', REPLAN_REUSE_MS, load, () => 1_000 + REPLAN_REUSE_MS - 1);
    assert.equal(calls, 1, 'recent reused the fresh read');
    await readAndRemember('default', load, () => 1_500);
    assert.equal(calls, 2, 'fresh always reads');
    clearCatalogMemo();
  });
  it('createCatalogClient wires fresh through readAndRemember and recent through recentCatalog', () => {
    // catalog-client imports JSON without an import attribute, so node:test cannot load it; check its wiring.
    const src = readFileSync(new URL('./catalog-client.ts', import.meta.url), 'utf8');
    assert.match(src, /const fresh = catalogReader\(env, request, \(market = 'default'\) => readAndRemember\(market, \(\) => read\(market\)\)\);/);
    assert.match(src, /const recent = catalogReader\(env, request, \(market = 'default'\) => recentCatalog\(market, REPLAN_REUSE_MS, \(\) => read\(market\)\)\);/);
    assert.match(src, /return \{\.\.\.cached, fresh, recent\};/);
    assert.doesNotMatch(src, /from '\.\/cart-replan\.ts'/);
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
