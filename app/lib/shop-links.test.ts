import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import type {Catalog} from './catalog.ts';
import {
  buyUrl,
  commerceHandoff,
  customerAccountUrl,
} from './shop-links.ts';

function catalog(addUrl: string): Catalog {
  return {
    schema: 1,
    generated_at: '2026-09-20T00:00:00Z',
    max_age: 300,
    currency: 'EUR',
    prices_include_vat: true,
    shop_url: 'https://store.myshopify.com',
    add_url: addUrl,
    add_method: 'POST',
    cart_url: 'https://store.myshopify.com',
    products: [],
  };
}

describe('commerce handoff', () => {
  it('rejects an unexpected add endpoint', () => {
    assert.throws(
      () => commerceHandoff(catalog('https://attacker.test/add')),
      /unexpected add endpoint/,
    );
  });

  it('routes a multi-line purchase to the local Shopify action and exposes no cart before one exists', () => {
    const handoff = commerceHandoff(catalog('/api/shopify/cart'));

    assert.deepEqual(handoff, {addUrl: '/api/shopify/cart', cartUrl: null});
    assert.equal(
      buyUrl(handoff, [
        {sku: 'OPENFC-LITE-3030', quantity: 1},
        {sku: 'OPENESC-3030', quantity: 1},
      ]),
      '/api/shopify/cart?lines=OPENFC-LITE-3030%3A1%2COPENESC-3030%3A1&next=cart',
    );
  });

  it('exposes the cart page once the session holds a Shopify cart', () => {
    assert.equal(commerceHandoff(catalog('/api/shopify/cart'), true).cartUrl, '/cart');
  });
});

describe('customer account routing', () => {
  it('hides accounts until an exact URL is configured', () => {
    assert.equal(customerAccountUrl({}), null);
  });

  it('uses the configured HTTPS account URL without deriving subpaths', () => {
    assert.equal(
      customerAccountUrl({SHOPIFY_CUSTOMER_ACCOUNT_URL: 'https://account.example.com/'}),
      'https://account.example.com/',
    );
  });

  it('rejects an insecure account destination', () => {
    assert.throws(
      () => customerAccountUrl({SHOPIFY_CUSTOMER_ACCOUNT_URL: 'http://account.example.com/'}),
      /must be HTTPS/,
    );
  });
});
