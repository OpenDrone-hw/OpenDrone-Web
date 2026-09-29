import assert from 'node:assert/strict';
import fs from 'node:fs';
import {describe, it} from 'node:test';
import type {Catalog, CatalogVariant} from './catalog.ts';
import {applyCampaign, datedShipParts, parseCampaignConfig, shipLabelFromPromise, type Region} from './preorder-campaign.ts';
import {shipCountryFromCookie} from './shipping-rates.ts';
import {forwardedCountry, handleShopifyCartAction, withCountry, type ShopifyCartDependencies} from './shopify-cart-action.ts';
import {handleCartCountry} from './shopify-cart-country.ts';
import type {CartLineInput, CartLineUpdate, ShopifyCart, ShopifyCartLine} from './shopify-storefront.ts';

const CAMPAIGN = parseCampaignConfig(
  JSON.parse(fs.readFileSync(new URL('../../content/preorders.json', import.meta.url), 'utf8')),
);
const NOW = new Date('2026-10-01T12:00:00Z');
const ENV = {SHOPIFY_CHECKOUT_WRITE_ENABLED: '1', PUBLIC_COMING_SOON: '0', PUBLIC_US_SALES: '1'} as const;
const REGISTRATIONS = {BE: {saleApproved: true}, DE: {saleApproved: true}};
const CHECKOUT = 'https://checkout.opendrone.be/checkouts/cn/ok';
const FC = 'gid://shopify/ProductVariant/OPENFC-LITE-2020';
const RX = 'gid://shopify/ProductVariant/OPENRX-LITE';
const EU_PROMISE = 'ships early November 2026, delivered by 30 November 2026';

function variant(sku: string, extra: Partial<CatalogVariant> = {}): CatalogVariant {
  return {
    sku,
    title: sku, model: null, options: {}, price: 31.2, compare_price: 39, currency: 'EUR',
    availability: 'preorder', ship_promise: null, image: null, url: '/products/x',
    cart_add_url: '/api/shopify/cart', merchandise_id: `gid://shopify/ProductVariant/${sku}`, ...extra,
  };
}

function catalogFor(region: Region): Catalog {
  const eur: Catalog = {
    schema: 1, generated_at: '2026-10-01T00:00:00Z', max_age: 0, currency: 'EUR', prices_include_vat: true,
    shop_url: 'https://s.myshopify.com', cart_url: 'https://s.myshopify.com', add_url: '/api/shopify/cart', add_method: 'POST',
    products: [
      {handle: 'openfc-lite', title: 'OpenFC Lite', family: null, description: null, url: '/products/openfc-lite', images: [], rating: null,
        variants: [variant('OPENFC-LITE-2020')]},
      {handle: 'openrx', title: 'OpenRX', family: null, description: null, url: '/products/openrx', images: [], rating: null,
        variants: [variant('OPENRX-LITE', {availability: 'in_stock'})]},
    ],
  };
  return applyCampaign(eur, CAMPAIGN, {'OPENFC-LITE-2020': 3}, NOW, region);
}

function cartLine(id: string, merchandiseId: string, sku: string, attributes: Array<{key: string; value: string}>): ShopifyCartLine {
  const promise = attributes.find((a) => a.key === 'Preorder')?.value ?? null;
  const region = attributes.find((a) => a.key === '_ship_region')?.value;
  return {
    id, merchandiseId, quantity: 1, title: sku, variantTitle: sku, handle: 'openfc-lite', sku, image: null,
    selectedOptions: [], shipPromise: promise, ...(region ? {shipRegion: region} : {}),
    total: {amount: '31.2', currencyCode: 'EUR'},
  };
}

/** A Shopify cart in memory: the buyer country decides the currency, and a
 *  line update replaces its attributes, as the Storefront API does. */
function shopify(country: string | null, lines: ShopifyCartLine[]) {
  const state = {country, lines, calls: [] as string[]};
  const view = (): ShopifyCart => {
    const currencyCode = state.country === 'US' ? 'USD' : 'EUR';
    return {
      id: 'gid://shopify/Cart/a', checkoutUrl: CHECKOUT, totalQuantity: state.lines.length,
      subtotal: {amount: '31.2', currencyCode}, total: {amount: '31.2', currencyCode},
      ...(state.country ? {country: state.country} : {}),
      lines: state.lines.map((l) => ({...l, total: {amount: '31.2', currencyCode}})),
    };
  };
  return {
    state,
    getCart: async () => view(),
    setCountry: async (_id: string, code: string) => { state.calls.push(`country:${code}`); state.country = code; },
    updateCartLines: async (_id: string, updates: CartLineUpdate[]) => {
      for (const update of updates) {
        state.calls.push(`update:${update.id}`);
        state.lines = state.lines.map((l) => {
          if (l.id !== update.id) return l;
          const attrs = update.attributes ?? [];
          const region = attrs.find((a) => a.key === '_ship_region')?.value;
          const {shipRegion: _drop, ...rest} = l;
          return {...rest, shipPromise: attrs.find((a) => a.key === 'Preorder')?.value ?? null, ...(region ? {shipRegion: region} : {})};
        });
      }
      return view();
    },
  };
}

const euLine = () => cartLine('gid://shopify/CartLine/1', FC, 'OPENFC-LITE-2020', [{key: 'Preorder', value: EU_PROMISE}]);

function switchRequest(country: string): Request {
  return new Request('https://opendrone.be/api/shopify/cart-country', {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://opendrone.be'},
    body: new URLSearchParams({country}),
  });
}

function switcher(fake: ReturnType<typeof shopify>) {
  return {
    registrations: REGISTRATIONS,
    getCartId: () => 'gid://shopify/Cart/a',
    setCountry: fake.setCountry,
    getCart: fake.getCart,
    fetchCatalog: async (region: Region) => catalogFor(region),
    updateCartLines: fake.updateCartLines,
  };
}

describe('cart country switch', () => {
  it('rewrites every line promise EU to US and back, and re-prices in the market currency', async () => {
    const fake = shopify('BE', [euLine()]);

    const toUs = await handleCartCountry(switchRequest('US'), ENV, switcher(fake));
    assert.equal(toUs.status, 200);
    const us = (await toUs.json()) as {applied: boolean; summary: {subtotal: {currencyCode: string}; lines: Array<{shipPromise: string}>}};
    assert.equal(us.applied, true);
    assert.equal(us.summary.subtotal.currencyCode, 'USD');
    assert.match(us.summary.lines[0].shipPromise, /31 March 2027/);
    assert.match(us.summary.lines[0].shipPromise, /delivered by 30 April 2027/);
    assert.equal(fake.state.lines[0].shipRegion, 'US');
    assert.equal(fake.state.country, 'US');

    const toBe = await handleCartCountry(switchRequest('BE'), ENV, switcher(fake));
    const eu = (await toBe.json()) as {summary: {subtotal: {currencyCode: string}; lines: Array<{shipPromise: string}>}};
    assert.equal(eu.summary.subtotal.currencyCode, 'EUR');
    assert.equal(eu.summary.lines[0].shipPromise, EU_PROMISE);
    assert.equal(fake.state.lines[0].shipRegion, undefined);
    assert.deepEqual(fake.state.calls, ['country:US', 'update:gid://shopify/CartLine/1', 'country:BE', 'update:gid://shopify/CartLine/1']);
  });

  it('sets the destination cookie the pages read', async () => {
    const res = await handleCartCountry(switchRequest('US'), ENV, switcher(shopify('BE', [euLine()])));
    const cookie = res.headers.get('Set-Cookie') ?? '';
    assert.match(cookie, /^od_ship_country=US;/);
    assert.equal(shipCountryFromCookie(cookie.split(';')[0]), 'US');
  });

  it('does not touch a line that is already right for the region', async () => {
    const fake = shopify('DE', [euLine()]);
    await handleCartCountry(switchRequest('BE'), ENV, switcher(fake));
    assert.deepEqual(fake.state.calls, ['country:BE']);
  });

  it('puts an in-stock line on the March batch promise when the destination becomes the US', async () => {
    const rx = cartLine('gid://shopify/CartLine/2', RX, 'OPENRX-LITE', []);
    const fake = shopify('BE', [euLine(), rx]);
    await handleCartCountry(switchRequest('US'), ENV, switcher(fake));
    assert.match(fake.state.lines[1].shipPromise ?? '', /31 March 2027/);
    assert.equal(fake.state.lines[1].shipRegion, 'US');
    assert.equal(fake.state.lines[0].shipRegion, 'US');
  });

  it('keeps the cart and sets only the cookie for a country not sold direct', async () => {
    const fake = shopify('BE', [euLine()]);
    const res = await handleCartCountry(switchRequest('CH'), ENV, switcher(fake));
    assert.deepEqual(await res.json(), {country: 'CH', applied: false});
    assert.match(res.headers.get('Set-Cookie') ?? '', /od_ship_country=CH/);
    assert.deepEqual(fake.state.calls, []);
  });

  it('sets no cookie when Shopify refuses the country', async () => {
    const fake = shopify('BE', [euLine()]);
    const res = await handleCartCountry(switchRequest('US'), ENV, {
      ...switcher(fake),
      setCountry: async () => { throw new Error('shopify: cartBuyerIdentityUpdate failed'); },
    });
    assert.equal(res.status, 502);
    assert.equal(res.headers.get('Set-Cookie'), null);
  });
});

function checkoutRequest(country: string | null, fields: Record<string, string> = {}): Request {
  return new Request('https://opendrone.be/api/shopify/cart', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://opendrone.be',
      ...(country ? {Cookie: `od_ship_country=${country}`} : {}),
    },
    body: new URLSearchParams({intent: 'checkout', datesSeen: '1', ...fields}),
  });
}

function actionDeps(fake: ReturnType<typeof shopify>, regions: Region[] = []): ShopifyCartDependencies {
  return {
    registrations: REGISTRATIONS,
    fetchCatalog: async (region) => { regions.push(region ?? 'EU'); return catalogFor(region ?? 'EU'); },
    createCart: async () => { throw new Error('must not create'); },
    getCartId: () => 'gid://shopify/Cart/a',
    getCart: fake.getCart,
    setCountry: fake.setCountry,
    updateCartLines: fake.updateCartLines,
  };
}

describe('checkout re-derives the promises from the destination', () => {
  it('refreshes a BE cart to the US promise and market before a US checkout', async () => {
    const fake = shopify('BE', [euLine()]);
    const regions: Region[] = [];
    const res = await handleShopifyCartAction(checkoutRequest('US'), ENV, actionDeps(fake, regions));
    assert.equal(res.headers.get('Location'), '/cart?check=market');
    assert.deepEqual(regions, ['US']);
    assert.equal(fake.state.country, 'US');
    assert.match(fake.state.lines[0].shipPromise ?? '', /delivered by 30 April 2027/);
    assert.equal(fake.state.lines[0].shipRegion, 'US');
  });

  it('refreshes a US cart to the EU promise and market before an EU checkout', async () => {
    const fake = shopify('US', [
      cartLine('gid://shopify/CartLine/1', FC, 'OPENFC-LITE-2020', [
        {key: 'Preorder', value: 'ships by 31 March 2027 if the target is reached by 15 December 2026'},
        {key: '_ship_region', value: 'US'},
      ]),
    ]);
    const res = await handleShopifyCartAction(checkoutRequest('BE'), ENV, actionDeps(fake));
    assert.equal(res.headers.get('Location'), '/cart?check=market');
    assert.equal(fake.state.country, 'BE');
    assert.equal(fake.state.lines[0].shipPromise, EU_PROMISE);
    assert.equal(fake.state.lines[0].shipRegion, undefined);
  });

  it('never hands a stale promise to checkout: a stale line goes back to the cart first', async () => {
    const fake = shopify('BE', [cartLine('gid://shopify/CartLine/1', FC, 'OPENFC-LITE-2020', [{key: 'Preorder', value: 'ships late September 2026'}])]);
    const res = await handleShopifyCartAction(checkoutRequest('BE'), ENV, actionDeps(fake));
    assert.equal(res.headers.get('Location'), '/cart?check=ship-date');
    assert.equal(fake.state.lines[0].shipPromise, EU_PROMISE);
  });

  it('points a cart at another EU country and goes on to checkout when the market is unchanged', async () => {
    const fake = shopify('BE', [euLine()]);
    const res = await handleShopifyCartAction(checkoutRequest('DE'), ENV, actionDeps(fake));
    assert.equal(res.headers.get('Location'), CHECKOUT);
    assert.equal(fake.state.country, 'DE');
  });

  it('goes straight to checkout when cart country, promises and destination agree', async () => {
    const fake = shopify('BE', [euLine()]);
    const res = await handleShopifyCartAction(checkoutRequest('BE'), ENV, actionDeps(fake));
    assert.equal(res.headers.get('Location'), CHECKOUT);
    assert.deepEqual(fake.state.calls, []);
  });

  it('re-derives a US cart line for an in-stock item to the March promise before checkout', async () => {
    const rx = cartLine('gid://shopify/CartLine/2', RX, 'OPENRX-LITE', []);
    const fake = shopify('US', [rx]);
    const res = await handleShopifyCartAction(checkoutRequest('US'), ENV, actionDeps(fake));
    assert.notEqual(res.headers.get('Location'), '/cart?check=us-eu-only');
    assert.match(fake.state.lines[0].shipPromise ?? '', /31 March 2027/);
    assert.equal(fake.state.lines[0].shipRegion, 'US');
  });
});

describe('add to cart forwards the resolved country', () => {
  function addRequest(fields: Record<string, string>, cookie?: string): Request {
    return new Request('https://opendrone.be/api/shopify/cart', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://opendrone.be', 'CF-IPCountry': 'BE',
        ...(cookie ? {Cookie: cookie} : {}),
      },
      body: new URLSearchParams({sku: 'OPENFC-LITE-2020', qty: '1', ...fields}),
    });
  }

  async function add(fields: Record<string, string>, cookie?: string) {
    const seen: {region?: Region; lines?: CartLineInput[]; country?: string} = {};
    const res = await handleShopifyCartAction(addRequest(fields, cookie), ENV, {
      registrations: REGISTRATIONS,
      fetchCatalog: async (region) => { seen.region = region; return catalogFor(region ?? 'EU'); },
      createCart: async (lines, country) => {
        seen.lines = lines;
        seen.country = country;
        return shopify(country ?? null, []).getCart();
      },
    });
    return {res, seen};
  }

  it('creates a US cart from a ?country=US page on a Belgian IP', async () => {
    const {res, seen} = await add({country: 'US'});
    assert.equal(res.status, 303);
    assert.equal(seen.country, 'US');
    assert.equal(seen.region, 'US');
    assert.equal(seen.lines?.[0].attributes?.find((a) => a.key === '_ship_region')?.value, 'US');
    assert.match(seen.lines?.[0].attributes?.find((a) => a.key === 'Preorder')?.value ?? '', /30 April 2027/);
  });

  it('lets the forwarded country win over the cookie of the POST', async () => {
    const {seen} = await add({country: 'BE'}, 'od_ship_country=US');
    assert.equal(seen.country, 'BE');
    assert.equal(seen.region, 'EU');
  });

  it('falls back to the request without the field, and ignores a malformed one', async () => {
    assert.equal((await add({})).seen.country, 'BE');
    assert.equal((await add({country: 'USA'})).seen.country, 'BE');
    assert.equal((await add({country: '1'})).seen.country, 'BE');
  });

  it('builds the field the browser sends', () => {
    assert.deepEqual(withCountry([['sku', 'A']], 'US'), [['sku', 'A'], ['country', 'US']]);
    assert.deepEqual(withCountry([['sku', 'A']], null), [['sku', 'A']]);
    assert.deepEqual(withCountry([['country', 'BE']], 'US'), [['country', 'BE']]);
    assert.equal(forwardedCountry(new URLSearchParams({country: ' us '}) as unknown as FormData), 'US');
    assert.equal(forwardedCountry(new URLSearchParams({country: 'usa'}) as unknown as FormData), null);
  });
});

describe('one ship line everywhere', () => {
  it('names the month qualifier and delivery date of the BE FC/ESC promise', () => {
    assert.deepEqual(datedShipParts(EU_PROMISE), {when: 'early Nov 2026', delivered: '30 Nov 2026'});
    assert.equal(shipLabelFromPromise(EU_PROMISE, 'short'), 'Ships early Nov 2026 · Delivered by 30 Nov 2026');
    assert.equal(shipLabelFromPromise('ships early November 2026', 'short'), 'Ships early Nov 2026');
    assert.equal(shipLabelFromPromise('ships October 2026, delivered by 15 November 2026', 'short'), 'Ships Oct 2026 · Delivered by 15 Nov 2026');
    assert.equal(datedShipParts('ships once funded'), null);
  });
});

describe('blocked visitors, half-applied switches, checkout country', () => {
  it('keeps a blocked IP country blocked whatever the cookie, field or query says', async () => {
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://opendrone.be',
      'CF-IPCountry': 'RU', Cookie: 'od_ship_country=BE',
    };
    for (const url of ['https://opendrone.be/api/shopify/cart', 'https://opendrone.be/api/shopify/cart?country=BE']) {
      for (const intent of ['checkout', 'add']) {
        const fake = shopify('BE', [euLine()]);
        const response = await handleShopifyCartAction(
          new Request(url, {method: 'POST', headers, body: new URLSearchParams({intent, country: 'BE', sku: 'OPENFC-LITE-2020', qty: '1', datesSeen: '1'})}),
          ENV,
          {...actionDeps(fake), addCartLines: async () => { throw new Error('must not add'); }, createCart: async () => { throw new Error('must not create'); }},
        ).then((r) => r, (e: unknown) => e);
        // Checkout is refused outright; an add is refused only while US sales are open, which they are here.
        assert.ok(response instanceof Response, `${intent} ${url}`);
        assert.equal(response.status, 403, `${intent} ${url}`);
      }
    }
    const res = await handleCartCountry(
      new Request('https://opendrone.be/api/shopify/cart-country', {method: 'POST', headers, body: new URLSearchParams({country: 'BE'})}),
      ENV, switcher(shopify('BE', [euLine()])),
    );
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('Set-Cookie'), null);
  });

  it('ignores a forwarded country that is not an ISO code', () => {
    for (const bad of ['XX', 'ZZ', 'AA', 'usa', '']) {
      assert.equal(forwardedCountry(new URLSearchParams({country: bad}) as unknown as FormData), null, bad);
    }
    assert.equal(forwardedCountry(new URLSearchParams({country: 'us'}) as unknown as FormData), 'US');
  });

  it('puts the previous country back when the reprice fails after the country was set', async () => {
    const fake = shopify('BE', [euLine()]);
    const res = await handleCartCountry(switchRequest('US'), ENV, {
      ...switcher(fake),
      updateCartLines: async () => { throw new Error('shopify: cartLinesUpdate failed'); },
      logError: () => {},
    });
    assert.equal(res.status, 502);
    assert.equal(res.headers.get('Set-Cookie'), null);
    assert.equal(fake.state.country, 'BE');
    assert.deepEqual(fake.state.calls, ['country:US', 'country:BE']);
  });

  it('honours the country a checkout form forwards over the request cookie', async () => {
    const fake = shopify('US', [
      cartLine('gid://shopify/CartLine/1', FC, 'OPENFC-LITE-2020', [
        {key: 'Preorder', value: 'ships by 31 March 2027 if the target is reached by 15 December 2026, otherwise you choose a refund or to wait; if the target is reached in time, delivered by 30 April 2027'},
        {key: '_ship_region', value: 'US'},
      ]),
    ]);
    const res = await handleShopifyCartAction(checkoutRequest('BE', {country: 'US'}), ENV, actionDeps(fake));
    assert.equal(res.headers.get('Location'), CHECKOUT);
    assert.equal(fake.state.country, 'US');
  });
});
