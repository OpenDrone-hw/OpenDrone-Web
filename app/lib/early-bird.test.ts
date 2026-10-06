import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {
  claimUrl,
  DEFAULT_CLAIM_URL,
  ineligibility,
  mailKeyMatches,
  orderGid,
  readCustomerOrders,
  readOrder,
  signClaimToken,
  statusKey,
  type EarlyBirdOrder,
} from './early-bird.ts';

const ENDS_ON = '2026-12-15';
const STATUS = 'https://opendrone.store/103266419033/orders/abc123/authenticate?key=secret-key-1';

function order(partial: Partial<EarlyBirdOrder> = {}): EarlyBirdOrder {
  return {
    id: 'gid://shopify/Order/13395853017433',
    name: '#1297',
    createdAt: '2026-10-06T12:33:34Z',
    cancelledAt: null,
    displayFinancialStatus: 'PAID',
    tags: ['preorder', 'batch:OPENFRAME-5:1'],
    statusPageUrl: STATUS,
    customer: {id: 'gid://shopify/Customer/1'},
    lineItems: {nodes: [{customAttributes: []}]},
    ...partial,
  };
}

describe('ineligibility', () => {
  it('accepts a paid preorder before the run closes', () => {
    assert.equal(ineligibility(order(), ENDS_ON), null);
    assert.equal(ineligibility(order({displayFinancialStatus: 'PARTIALLY_REFUNDED'}), ENDS_ON), null);
  });

  it('accepts an order the tag job has not reached when a line carries the Preorder attribute', () => {
    const fresh = order({tags: [], lineItems: {nodes: [{customAttributes: [{key: 'Preorder', value: 'ships by 31 March 2027'}]}]}});
    assert.equal(ineligibility(fresh, ENDS_ON), null);
  });

  it('refuses unpaid, cancelled, non-preorder and late orders', () => {
    assert.equal(ineligibility(order({displayFinancialStatus: 'PENDING'}), ENDS_ON), 'not-paid');
    assert.equal(ineligibility(order({displayFinancialStatus: 'REFUNDED'}), ENDS_ON), 'not-paid');
    assert.equal(ineligibility(order({cancelledAt: '2026-10-07T00:00:00Z'}), ENDS_ON), 'cancelled');
    assert.equal(ineligibility(order({tags: []}), ENDS_ON), 'not-preorder');
    // 15 December ends at midnight Brussels time: 23:00 UTC.
    assert.equal(ineligibility(order({createdAt: '2026-12-15T22:59:59Z'}), ENDS_ON), null);
    assert.equal(ineligibility(order({createdAt: '2026-12-15T23:00:00Z'}), ENDS_ON), 'too-late');
  });
});

describe('mail link', () => {
  it('builds the GID only from a numeric id', () => {
    assert.equal(orderGid('13395853017433'), 'gid://shopify/Order/13395853017433');
    assert.equal(orderGid('1 OR 1'), null);
    assert.equal(orderGid(null), null);
  });

  it('matches only the status page key', () => {
    assert.equal(statusKey(STATUS), 'secret-key-1');
    assert.equal(mailKeyMatches(order(), 'secret-key-1'), true);
    assert.equal(mailKeyMatches(order(), 'secret-key-2'), false);
    assert.equal(mailKeyMatches(order(), null), false);
    assert.equal(mailKeyMatches(order({statusPageUrl: null}), 'secret-key-1'), false);
    assert.equal(mailKeyMatches(order({statusPageUrl: 'https://opendrone.store/orders/x'}), ''), false);
  });
});

describe('claim token', () => {
  it('signs the format the bot verifies', async () => {
    const token = await signClaimToken('k', order(), 2000);
    const [version, body, mac] = token.split('.');
    assert.equal(version, 'v1');
    const json = JSON.parse(Buffer.from(body!, 'base64url').toString('utf8'));
    assert.deepEqual(json, {o: 'gid://shopify/Order/13395853017433', n: '#1297', exp: 2000});
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('k'), {name: 'HMAC', hash: 'SHA-256'}, false, ['verify']);
    const ok = await crypto.subtle.verify('HMAC', key, Buffer.from(mac!, 'base64url'), new TextEncoder().encode(`v1.${body}`));
    assert.equal(ok, true);
  });

  it('points at the bot with a 10 minute token, and refuses without the key', async () => {
    const url = new URL(await claimUrl({EARLY_BIRD_CLAIM_KEY: 'k'} as never, order(), 1_000_000));
    assert.equal(`${url.origin}${url.pathname}`, DEFAULT_CLAIM_URL);
    const json = JSON.parse(Buffer.from(url.searchParams.get('t')!.split('.')[1]!, 'base64url').toString('utf8')) as {exp: number};
    assert.equal(json.exp, 1000 + 600);
    await assert.rejects(claimUrl({} as never, order()), /EARLY_BIRD_CLAIM_KEY/);
  });
});

describe('Shopify reads', () => {
  const env = {SHOPIFY_STORE_DOMAIN: 'shop.myshopify.com', SHOPIFY_ADMIN_API_TOKEN: 't', SHOPIFY_ADMIN_API_VERSION: '2026-07'} as never;
  const reply = (data: unknown) => (async () => new Response(JSON.stringify({data}), {status: 200})) as unknown as typeof fetch;

  it('reads one order and a customer order list', async () => {
    assert.equal((await readOrder(env, order().id, reply({order: order()})))?.name, '#1297');
    assert.equal(await readOrder(env, order().id, reply({order: null})), null);
    assert.equal((await readCustomerOrders(env, 'gid://shopify/Customer/1', reply({customer: {orders: {nodes: [order()]}}})))?.length, 1);
    assert.equal(await readCustomerOrders(env, 'gid://shopify/Customer/1', reply({customer: null})), null);
  });
});
