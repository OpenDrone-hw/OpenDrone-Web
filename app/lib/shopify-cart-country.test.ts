import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {handleCartCountry} from './shopify-cart-country.ts';

const OPEN = {SHOPIFY_CHECKOUT_WRITE_ENABLED: '1', PUBLIC_COMING_SOON: '0'} as const;
const URL_ = 'https://shop.test/api/shopify/cart-country';

function post(country: string, headers: Record<string, string> = {}): Request {
  return new Request(URL_, {
    method: 'POST',
    headers: {
      Origin: 'https://shop.test',
      'Content-Type': 'application/x-www-form-urlencoded',
      ...headers,
    },
    body: new URLSearchParams({country}),
  });
}

function deps(cartId: string | null = 'gid://shopify/Cart/abc') {
  const calls: Array<[string, string]> = [];
  return {
    calls,
    getCartId: () => cartId ?? undefined,
    setCountry: async (id: string, code: string) => {
      calls.push([id, code]);
    },
  };
}

describe('handleCartCountry', () => {
  it('puts the picked country on the session cart', async () => {
    const d = deps();
    const res = await handleCartCountry(post('de'), OPEN, d);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {country: 'DE', applied: true});
    assert.deepEqual(d.calls, [['gid://shopify/Cart/abc', 'DE']]);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
  });

  it('never puts a blocked country on the cart', async () => {
    const d = deps();
    const res = await handleCartCountry(post('RU'), OPEN, d);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {country: 'RU', applied: false});
    assert.equal(d.calls.length, 0);
  });

  it('never puts a country sold through shops on the cart', async () => {
    const d = deps();
    for (const c of ['US', 'GB', 'CH', 'NO']) {
      const res = await handleCartCountry(post(c), OPEN, d);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {country: c, applied: false});
    }
    assert.equal(d.calls.length, 0);
  });

  it('does nothing without a cart', async () => {
    const d = deps(null);
    const res = await handleCartCountry(post('DE'), OPEN, d);
    assert.deepEqual(await res.json(), {country: 'DE', applied: false});
    assert.equal(d.calls.length, 0);
  });

  it('refuses a malformed country', async () => {
    for (const bad of ['', 'USA', '1', 'u$']) {
      const res = await handleCartCountry(post(bad), OPEN, deps());
      assert.equal(res.status, 400, bad);
    }
  });

  it('refuses a cross-origin post', async () => {
    const res = await handleCartCountry(post('US', {Origin: 'https://evil.test'}), OPEN, deps());
    assert.equal(res.status, 403);
  });

  it('stays closed while checkout is closed', async () => {
    const d = deps();
    const closed = {SHOPIFY_CHECKOUT_WRITE_ENABLED: '1', PUBLIC_COMING_SOON: '1'};
    assert.equal((await handleCartCountry(post('US'), closed, d)).status, 404);
    const noWrites = {SHOPIFY_CHECKOUT_WRITE_ENABLED: '0', PUBLIC_COMING_SOON: '0'};
    assert.equal((await handleCartCountry(post('US'), noWrites, d)).status, 404);
    assert.equal(d.calls.length, 0);
  });

  it('answers only POST', async () => {
    const res = await handleCartCountry(new Request(URL_), OPEN, deps());
    assert.equal(res.status, 405);
  });

  it('reports a Shopify refusal without throwing', async () => {
    const logged: string[] = [];
    const res = await handleCartCountry(post('FR'), OPEN, {
      getCartId: () => 'gid://shopify/Cart/abc',
      setCountry: async () => {
        throw new Error('shopify: cartBuyerIdentityUpdate failed');
      },
      logError: (m) => logged.push(m),
    });
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), {country: 'FR', applied: false});
    assert.equal(logged.length, 1);
  });
});
