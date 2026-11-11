import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {handleCartCountry} from './shopify-cart-country.ts';
import {setCartCountry} from './shopify-cart-action.ts';
import {getCart} from './shopify-storefront.ts';

/**
 * A region change with items in the cart, against the Storefront API's own
 * wire shape (not the local preview's stand-in): the site moves the cart to
 * the new country with `cartBuyerIdentityUpdate`, reads it back, and what it
 * shows is the currency Shopify priced it in, one currency for every line and
 * the total. The stand-in priced every cart in euro once (2026-11-11); this
 * holds the site's half of the contract without it.
 */

const ENV = {
  SHOPIFY_CHECKOUT_WRITE_ENABLED: '1',
  PUBLIC_COMING_SOON: '0',
  PUBLIC_US_SALES: '1',
  SHOPIFY_STORE_DOMAIN: 'open-drone-test.myshopify.com',
  SHOPIFY_STOREFRONT_TOKEN: 'test-token',
  SHOPIFY_STOREFRONT_API_VERSION: '2026-07',
};
const CART_ID = 'gid://shopify/Cart/c1?key=k1';
/** Shopify's market prices of the two lines: EUR in Belgium and International, USD in the US. */
const PRICES: Record<string, Record<string, {amount: number; currency: string}>> = {
  BE: {fc: {amount: 26.1, currency: 'EUR'}, esc: {amount: 44.1, currency: 'EUR'}},
  CH: {fc: {amount: 26.1, currency: 'EUR'}, esc: {amount: 44.1, currency: 'EUR'}},
  US: {fc: {amount: 30.0, currency: 'USD'}, esc: {amount: 51.0, currency: 'USD'}},
};

/** A Storefront API that prices the cart in its buyer identity's market, as Shopify does. */
function storefront() {
  const state = {country: 'BE', mutations: [] as Array<Record<string, unknown>>};
  const line = (id: string, key: 'fc' | 'esc', sku: string, title: string) => {
    const price = PRICES[state.country][key];
    return {
      id,
      quantity: 1,
      attributes: [],
      cost: {totalAmount: {amount: price.amount.toFixed(2), currencyCode: price.currency}},
      merchandise: {id: `gid://shopify/ProductVariant/${key}`, title: '20×20', sku, image: null, selectedOptions: [{name: 'Model', value: '20×20'}], product: {handle: title, title}},
    };
  };
  const wire = () => {
    const nodes = [line('gid://shopify/CartLine/1', 'fc', 'OPENFC-LITE-2020', 'openfc-lite'), line('gid://shopify/CartLine/2', 'esc', 'OPENESC-2020', 'openesc')];
    const currency = nodes[0].cost.totalAmount.currencyCode;
    const sum = nodes.reduce((n, l) => n + Number(l.cost.totalAmount.amount), 0).toFixed(2);
    return {
      id: CART_ID,
      checkoutUrl: 'https://open-drone-test.myshopify.com/cart/c/k1',
      totalQuantity: 2,
      buyerIdentity: {countryCode: state.country},
      attributes: [],
      discountCodes: [],
      cost: {subtotalAmount: {amount: sum, currencyCode: currency}, totalAmount: {amount: sum, currencyCode: currency}},
      lines: {pageInfo: {hasNextPage: false}, nodes},
    };
  };
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {query: string; variables: Record<string, unknown>};
    if (body.query.includes('cartBuyerIdentityUpdate(')) {
      state.mutations.push(body.variables);
      state.country = String((body.variables.buyerIdentity as {countryCode: string}).countryCode);
      return Response.json({data: {cartBuyerIdentityUpdate: {cart: {id: CART_ID}, userErrors: []}}});
    }
    if (body.query.includes('cart(id: $id)')) return Response.json({data: {cart: wire()}});
    throw new Error(`unexpected Storefront call: ${body.query.slice(0, 60)}`);
  }) as typeof fetch;
  return {state, fetcher};
}

function switchTo(country: string, fetcher: typeof fetch) {
  const request = new Request('https://shop.test/api/shopify/cart-country', {
    method: 'POST',
    headers: {Origin: 'https://shop.test', 'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({country}),
  });
  return handleCartCountry(request, ENV, {
    getCartId: () => CART_ID,
    setCountry: (id, code) => setCartCountry(ENV, id, code, fetcher),
    getCart: (id) => getCart(ENV, id, fetcher),
  });
}

describe('cart: a region change reprices the cart in the new currency', () => {
  it('BE -> US -> CH -> BE: the buyer identity moves and the summary is in one currency, Shopify\'s', async () => {
    const {state, fetcher} = storefront();
    for (const [country, currency, total] of [['US', 'USD', '81.00'], ['CH', 'EUR', '70.20'], ['BE', 'EUR', '70.20']] as const) {
      const response = await switchTo(country, fetcher);
      assert.equal(response.status, 200, country);
      const body = (await response.json()) as {country: string; applied: boolean; summary?: {subtotal: {amount: string; currencyCode: string}; lines: Array<{total?: {currencyCode: string}}>}};
      assert.equal(body.applied, true, country);
      assert.equal(state.mutations.at(-1)?.buyerIdentity && (state.mutations.at(-1)!.buyerIdentity as {countryCode: string}).countryCode, country);
      assert.equal(body.summary?.subtotal.currencyCode, currency, country);
      assert.equal(Number(body.summary?.subtotal.amount).toFixed(2), total, country);
      const lineCurrencies = new Set(body.summary?.lines.map((l) => l.total?.currencyCode).filter(Boolean));
      assert.ok(lineCurrencies.size <= 1 && (!lineCurrencies.size || lineCurrencies.has(currency)), `${country}: one currency per cart`);
    }
  });

  it('a blocked country never moves the cart (prices stay as they were)', async () => {
    const {state, fetcher} = storefront();
    const response = await switchTo('RU', fetcher);
    assert.equal(((await response.json()) as {applied: boolean}).applied, false);
    assert.equal(state.mutations.length, 0);
    assert.equal(state.country, 'BE');
  });
});
