/**
 * The added-to-cart drawer and checkout must agree on a mixed order. The
 * drawer decides from the summary the add returns (`hasMixedShipGroups`),
 * checkout from the cart and catalog (`hasMixedShipDates`). When they
 * disagree, checkout sends the buyer back to `/cart?check=mixed-dates`.
 * These tests run the real add and checkout handlers against the committed
 * `content/preorders.json`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {describe, it} from 'node:test';
import type {Catalog} from './catalog.ts';
import {applyCampaign, parseCampaignConfig, type Region} from './preorder-campaign.ts';
import {
  DATES_SEEN_FIELD,
  cartLineInfo,
  handleShopifyCartAction,
  hasMixedShipDates,
  hasMixedShipGroups,
  type CartSummary,
} from './shopify-cart-action.ts';
import type {CartLineInput, ShopifyCart, ShopifyCartLine} from './shopify-storefront.ts';

const CONFIG = parseCampaignConfig(
  JSON.parse(fs.readFileSync(new URL('../../content/preorders.json', import.meta.url), 'utf8')),
);
const NOW = new Date('2026-10-01T12:00:00Z');
const CHECKOUT = 'https://checkout.opendrone.be/checkouts/cn/ok';
const ENV = {SHOPIFY_CHECKOUT_WRITE_ENABLED: '1', PUBLIC_COMING_SOON: '0'} as const;
const APPROVED = Object.fromEntries(['BE', 'NL', 'DE'].map((c) => [c, {saleApproved: true}]));
const US_RATE = 9.95;

const SKUS: Record<string, string> = {
  'OPENFC-LITE-2020': 'openfc-lite',
  'OPENRX-LITE': 'openrx',
  'OPENFRAME-5': 'openframe',
  'OPENMOTOR-2306': 'openmotor',
};
const idOf = (sku: string) => `gid://shopify/ProductVariant/${sku}`;

/** Every SKU at its first price step (20 % off retail), as Shopify sells it. */
const RAW: Catalog = {
  schema: 1,
  generated_at: '2026-10-01T00:00:00Z',
  max_age: 0,
  currency: 'EUR',
  prices_include_vat: true,
  shop_url: 'https://store.myshopify.com',
  cart_url: 'https://store.myshopify.com/cart',
  add_url: '/api/shopify/cart',
  add_method: 'POST',
  products: Object.entries(SKUS).map(([sku, handle]) => ({
    handle, title: handle, family: null, description: null, url: `/products/${handle}`, images: [], rating: null,
    variants: [{
      sku, title: 'Default Title', model: null, options: {}, price: 80, compare_price: 100, currency: 'EUR',
      availability: 'preorder', ship_promise: 'preview promise', image: null,
      url: `/products/${handle}`, cart_add_url: '/api/shopify/cart', merchandise_id: idOf(sku),
    }],
  })) as Catalog['products'],
};
const CATALOGS: Record<Region, Catalog> = {
  EU: applyCampaign(RAW, CONFIG, {}, NOW, 'EU'),
  US: applyCampaign(RAW, CONFIG, {}, NOW, 'US'),
  INT: applyCampaign(RAW, CONFIG, {}, NOW, 'INT'),
};

/** An in-memory Shopify cart: lines keep the attributes the add wrote. */
function fakeShop() {
  let cart: ShopifyCart | null = null;
  let n = 0;
  const attr = (input: CartLineInput, key: string) => input.attributes?.find((a) => a.key === key)?.value ?? null;
  const toLine = (input: CartLineInput): ShopifyCartLine => {
    const sku = input.merchandiseId.split('/').pop() ?? '';
    return {
      id: `gid://shopify/CartLine/${++n}?cart=a`,
      merchandiseId: input.merchandiseId,
      quantity: input.quantity,
      title: SKUS[sku],
      variantTitle: 'Default Title',
      handle: SKUS[sku],
      sku,
      image: null,
      selectedOptions: [],
      shipPromise: attr(input, 'Preorder'),
      deliveryBy: attr(input, 'Delivery by'),
      shipRegion: attr(input, '_ship_region'),
      batch: attr(input, '_batch'),
      total: {amount: '80.00', currencyCode: 'EUR'},
    };
  };
  const withTotals = (c: ShopifyCart): ShopifyCart => ({
    ...c,
    totalQuantity: c.lines.reduce((s, l) => s + l.quantity, 0),
    subtotal: {amount: '0.00', currencyCode: c.country === 'US' ? 'USD' : 'EUR'},
  });
  return {
    get: () => cart,
    deps: {
      registrations: APPROVED,
      usRate: US_RATE,
      fetchCatalog: async (region: Region = 'EU') => CATALOGS[region],
      createCart: async (lines: CartLineInput[], countryCode?: string) => {
        cart = withTotals({
          id: 'cart-a', checkoutUrl: CHECKOUT, totalQuantity: 0, country: countryCode ?? null,
          subtotal: {amount: '0.00', currencyCode: 'EUR'}, total: {amount: '0.00', currencyCode: 'EUR'},
          lines: lines.map(toLine),
        });
        return cart;
      },
      getCartId: () => (cart ? cart.id : undefined),
      setCartId: () => {},
      unsetCartId: () => { cart = null; },
      getCart: async () => cart,
      addCartLines: async (_id: string, lines: CartLineInput[]) => {
        cart = withTotals({...cart!, lines: [...cart!.lines, ...lines.map(toLine)]});
        return cart;
      },
      updateCartLines: async () => cart!,
      setCountry: async (_id: string, country: string) => { cart = withTotals({...cart!, country}); },
      setAttributes: async () => {},
    },
  };
}

function post(values: Array<[string, string]>, country: string): Request {
  return new Request('https://opendrone.be/api/shopify/cart', {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://opendrone.be', 'CF-IPCountry': country},
    body: new URLSearchParams([...values, ['country', country]]),
  });
}

/** Add each SKU from a product page as the drawer does, then press the
 *  drawer's Checkout with exactly the fields it would send. */
async function dialogCheckout(country: string, skus: string[]) {
  const shop = fakeShop();
  let summary: CartSummary | null = null;
  for (const sku of skus) {
    const response = await handleShopifyCartAction(
      post([['sku', sku], ['qty', '1'], ['response', 'summary']], country), ENV, shop.deps,
    );
    assert.equal(response.status, 200, `add ${sku}`);
    summary = await response.json() as CartSummary;
  }
  const dialogMixed = hasMixedShipGroups(summary!.lines);
  const fields: Array<[string, string]> = [['intent', 'checkout'], ...(dialogMixed ? [[DATES_SEEN_FIELD, '1'] as [string, string]] : [])];
  const response = await handleShopifyCartAction(post(fields, country), ENV, shop.deps);
  const cart = shop.get()!;
  return {
    location: response.headers.get('Location'),
    dialogMixed,
    serverMixed: hasMixedShipDates(cart, cartLineInfo(cart, CATALOGS[country === 'US' ? 'US' : 'EU'])),
    groups: summary!.lines.map((l) => l.shipGroup),
  };
}

describe('mixed order: the drawer uses checkout\'s grouping', () => {
  const cases: Array<{name: string; country: string; skus: string[]; mixed: boolean}> = [
    {name: 'US FC + RX (two funding targets, same date text)', country: 'US', skus: ['OPENFC-LITE-2020', 'OPENRX-LITE'], mixed: true},
    {name: 'US FC + frame', country: 'US', skus: ['OPENFC-LITE-2020', 'OPENFRAME-5'], mixed: true},
    {name: 'EU frame + motors + RX', country: 'BE', skus: ['OPENFRAME-5', 'OPENMOTOR-2306', 'OPENRX-LITE'], mixed: true},
    {name: 'EU batch-1 FC + March RX', country: 'BE', skus: ['OPENFC-LITE-2020', 'OPENRX-LITE'], mixed: true},
    {name: 'EU one funding target', country: 'BE', skus: ['OPENRX-LITE'], mixed: false},
  ];
  for (const c of cases) {
    it(`${c.name}: drawer Checkout goes to Shopify checkout, not back to the cart`, async () => {
      const result = await dialogCheckout(c.country, c.skus);
      assert.ok(result.groups.every(Boolean), 'every summary line carries its ship group');
      assert.equal(result.dialogMixed, c.mixed);
      assert.equal(result.serverMixed, c.mixed, 'drawer and checkout agree');
      assert.equal(result.location, CHECKOUT);
    });
  }

  it('reads two funding targets with the same promise text as mixed, as checkout does', () => {
    const promise = CONFIG.pendingShips;
    const lines = [
      {shipPromise: promise, shipGroup: 'target:OPENFC-LITE-2020:2'},
      {shipPromise: promise, shipGroup: 'target:OPENRX-LITE:1'},
    ];
    assert.equal(hasMixedShipGroups(lines), true);
    // The old drawer rule compared the text only and missed it.
    assert.equal(new Set(lines.map((l) => l.shipPromise)).size, 1);
    // Without a group (no catalog), the promise text decides.
    assert.equal(hasMixedShipGroups([{shipPromise: promise}, {shipPromise: promise}]), false);
    assert.equal(hasMixedShipGroups([{shipPromise: promise}, {shipPromise: 'ships early November 2026'}]), true);
  });

  it('still sends a drawer checkout without the field back to the cart for a mixed US cart', async () => {
    const shop = fakeShop();
    for (const sku of ['OPENFC-LITE-2020', 'OPENRX-LITE']) {
      await handleShopifyCartAction(post([['sku', sku], ['qty', '1'], ['response', 'summary']], 'US'), ENV, shop.deps);
    }
    const response = await handleShopifyCartAction(post([['intent', 'checkout']], 'US'), ENV, shop.deps);
    assert.equal(response.headers.get('Location'), '/cart?check=mixed-dates');
  });
});
