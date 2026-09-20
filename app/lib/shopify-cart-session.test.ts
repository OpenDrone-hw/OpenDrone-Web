import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {AppSession} from './session.ts';

const CART_ID = 'gid://shopify/Cart/fake-cart?key=fake-key';

function cookieHeader(setCookie: string): string {
  return setCookie.split(';', 1)[0];
}

async function commitCart(request: Request, environment = 'test') {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = environment;
  try {
    const session = await AppSession.init(request, ['session-test-secret']);
    session.set('shopifyCartId', CART_ID);
    const setCookie = await session.commit();
    return {cookie: cookieHeader(setCookie), setCookie};
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
}

describe('Shopify cart session', () => {
  it('round-trips a cart id through the signed cookie', async () => {
    const {cookie} = await commitCart(new Request('https://opendrone.be/'));
    const restored = await AppSession.init(
      new Request('https://opendrone.be/', {headers: {Cookie: cookie}}),
      ['session-test-secret'],
    );

    assert.equal(restored.get('shopifyCartId'), CART_ID);
  });

  it('does not share a cart between requests without a cookie', async () => {
    const {cookie} = await commitCart(new Request('https://opendrone.be/'));
    const isolated = await AppSession.init(
      new Request('https://opendrone.be/'),
      ['session-test-secret'],
    );

    assert.notEqual(cookie, '');
    assert.equal(isolated.get('shopifyCartId'), undefined);
  });

  it('rejects a tampered cookie signature', async () => {
    const {cookie} = await commitCart(new Request('https://opendrone.be/'));
    const [name, value] = cookie.split('=', 2);
    const tampered = `${name}=${value.slice(0, -1)}${value.endsWith('a') ? 'b' : 'a'}`;
    const restored = await AppSession.init(
      new Request('https://opendrone.be/', {headers: {Cookie: tampered}}),
      ['session-test-secret'],
    );

    assert.equal(restored.get('shopifyCartId'), undefined);
  });

  it('serializes HttpOnly, SameSite=Lax, and Secure in production', async () => {
    const {setCookie} = await commitCart(new Request('https://opendrone.be/'), 'production');

    assert.match(setCookie, /; HttpOnly(?:;|$)/);
    assert.match(setCookie, /; SameSite=Lax(?:;|$)/);
    assert.match(setCookie, /; Secure(?:;|$)/);
  });
});
