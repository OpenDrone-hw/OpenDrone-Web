import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {describe, it} from 'node:test';

describe('/products.json', () => {
  it('advertises no cart hand-off the cart action would refuse', () => {
    const route = readFileSync(new URL('../routes/[products.json].tsx', import.meta.url), 'utf8');
    assert.doesNotMatch(route, /cart_add_url|cart_add_method/);
  });
});
