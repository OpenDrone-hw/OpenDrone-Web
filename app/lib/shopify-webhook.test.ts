import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {verifyShopifyHmac} from './shopify-webhook.ts';

const SECRET = 'shopify-webhook-secret';
const BODY = '{"id":1,"line_items":[{"sku":"OPENESC-2020","quantity":1}]}';

async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    {name: 'HMAC', hash: 'SHA-256'},
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}

describe('verifyShopifyHmac', () => {
  it('accepts Shopify’s own signature', async () => {
    assert.equal(await verifyShopifyHmac(SECRET, BODY, await sign(SECRET, BODY)), true);
  });

  it('refuses a body that changed after signing', async () => {
    const header = await sign(SECRET, BODY);
    assert.equal(await verifyShopifyHmac(SECRET, BODY.replace('1', '9'), header), false);
  });

  it('refuses another secret, a missing header and an empty one', async () => {
    assert.equal(await verifyShopifyHmac(SECRET, BODY, await sign('other', BODY)), false);
    assert.equal(await verifyShopifyHmac(SECRET, BODY, null), false);
    assert.equal(await verifyShopifyHmac(SECRET, BODY, ''), false);
  });
});
