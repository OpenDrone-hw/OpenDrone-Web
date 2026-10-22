import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {discountLink} from './discount-link.ts';

const at = (path: string) => discountLink(new URL(`https://shop.example${path}`));

describe('discount links', () => {
  it('takes the code from the path and follows a redirect within the site', () => {
    assert.deepEqual(at('/discount/RETAIL-10'), {code: 'RETAIL-10', to: '/products'});
    assert.deepEqual(at('/discount/RETAIL-10?redirect=/products/openfc-lite'), {code: 'RETAIL-10', to: '/products/openfc-lite'});
    assert.deepEqual(at('/discount/SPRING%2010'), {code: 'SPRING10', to: '/products'});
  });

  it('never leaves the site and keeps nothing unsafe from the code', () => {
    assert.equal(at('/discount/X?redirect=https://evil.example/').to, '/products');
    assert.equal(at('/discount/X?redirect=//evil.example/').to, '/products');
    assert.equal(at('/discount/X?redirect=/%5Cevil.example').to, '/products');
    assert.equal(at('/discount/%E0%A4%A').code, '');
    assert.equal(at('/discount/a<b>').code, 'ab');
    assert.equal(at('/discount/').code, '');
  });
});
