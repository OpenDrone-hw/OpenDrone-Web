import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import type {Catalog} from './catalog.ts';
import {
  buyUrl,
  commerceHandoff,
  customerAccountUrl,
} from './shop-links.ts';

function catalog(addUrl: string, cartUrl: string): Catalog {
  return {
    schema: 1,
    generated_at: '2026-09-20T00:00:00Z',
    max_age: 300,
    currency: 'EUR',
    prices_include_vat: true,
    shop_url: 'https://shop.example',
    add_url: addUrl,
    add_method: 'POST',
    cart_url: cartUrl,
    products: [],
  };
}

describe('commerce handoff', () => {
  it('keeps the existing Odoo add and persistent-cart targets by default', () => {
    const handoff = commerceHandoff(
      catalog('/incutec/add', '/shop/cart'),
      false,
    );

    assert.deepEqual(handoff, {
      mode: 'odoo',
      addUrl: 'https://shop.example/incutec/add',
      cartUrl: 'https://shop.example/shop/cart',
    });
    assert.equal(
      buyUrl(handoff, [{sku: 'OPENRX-GEMINI', quantity: 1}]),
      'https://shop.example/incutec/add?sku=OPENRX-GEMINI&qty=1&next=cart',
    );
  });

  it('rejects an unexpected Shopify preview add endpoint', () => {
    assert.throws(
      () => commerceHandoff(catalog('https://attacker.test/add', '/cart'), true),
      /unexpected add endpoint/,
    );
  });

  it('routes a multi-line preview purchase to the local Shopify cart', () => {
    const handoff = commerceHandoff(
      catalog('/api/shopify/cart', 'https://store.myshopify.com/cart'),
      true,
    );

    assert.deepEqual(handoff, {
      mode: 'shopify-preview',
      addUrl: '/api/shopify/cart',
      cartUrl: '/cart',
    });
    assert.equal(
      buyUrl(handoff, [
        {sku: 'OPENFC-LITE-3030', quantity: 1},
        {sku: 'OPENESC-3030', quantity: 1},
      ]),
      '/api/shopify/cart?lines=OPENFC-LITE-3030%3A1%2COPENESC-3030%3A1&next=cart',
    );
  });
});

describe('customer account routing', () => {
  it('keeps the Odoo account destination outside Shopify preview', () => {
    assert.equal(
      customerAccountUrl({}, 'https://shop.example/', false),
      'https://shop.example/my',
    );
  });

  it('hides accounts in Shopify preview until an exact URL is configured', () => {
    assert.equal(customerAccountUrl({}, 'https://shop.example', true), null);
  });

  it('uses the configured HTTPS account URL without deriving subpaths', () => {
    assert.equal(
      customerAccountUrl(
        {SHOPIFY_CUSTOMER_ACCOUNT_URL: 'https://account.example.com/'},
        'https://shop.example',
        true,
      ),
      'https://account.example.com/',
    );
  });

  it('rejects an insecure account destination', () => {
    assert.throws(
      () =>
        customerAccountUrl(
          {SHOPIFY_CUSTOMER_ACCOUNT_URL: 'http://account.example.com/'},
          'https://shop.example',
          true,
        ),
      /must be HTTPS/,
    );
  });
});
