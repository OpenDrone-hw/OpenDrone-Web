import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {buyerOf} from './buyer.ts';

const req = (headers: Record<string, string>) => new Request('https://opendrone.be/shop/cart', {method: 'POST', headers});

describe('buyer of a checkout', () => {
  it('passes the edge address and the browser', () => {
    assert.deepEqual(buyerOf(req({'CF-Connecting-IP': '203.0.113.9', 'User-Agent': 'Mozilla/5.0'})), {client_ip: '203.0.113.9', client_user_agent: 'Mozilla/5.0'});
  });
  it('sends nothing it does not know and cuts a long browser string', () => {
    assert.deepEqual(buyerOf(req({})), {});
    assert.equal(buyerOf(req({'User-Agent': 'x'.repeat(400)})).client_user_agent?.length, 300);
  });
});
