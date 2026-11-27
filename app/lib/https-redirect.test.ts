import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {httpsRedirect} from './https-redirect.ts';

describe('httpsRedirect', () => {
  it('moves plain HTTP on the apex to HTTPS with path and query', () => {
    const res = httpsRedirect(new Request('http://opendrone.be/products/openrx?x=1'));
    assert.equal(res?.status, 301);
    assert.equal(res?.headers.get('Location'), 'https://opendrone.be/products/openrx?x=1');
  });

  it('sends plain HTTP on www straight to the HTTPS apex', () => {
    const res = httpsRedirect(new Request('http://www.opendrone.be/cart'));
    assert.equal(res?.headers.get('Location'), 'https://opendrone.be/cart');
  });

  it('keeps the method of a POST with 308', () => {
    const res = httpsRedirect(new Request('http://opendrone.be/api/shopify/cart', {method: 'POST'}));
    assert.equal(res?.status, 308);
  });

  it('leaves HTTPS, localhost and other hosts alone', () => {
    assert.equal(httpsRedirect(new Request('https://opendrone.be/')), null);
    assert.equal(httpsRedirect(new Request('http://localhost:5173/')), null);
    assert.equal(httpsRedirect(new Request('http://127.0.0.1:8787/')), null);
    assert.equal(httpsRedirect(new Request('http://opendrone-web.example.workers.dev/')), null);
  });
});
