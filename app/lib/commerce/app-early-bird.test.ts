import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {ineligibility} from '../early-bird.ts';
import {appKey, appOrderNumber, readAppOrder, toEarlyBirdOrder, type EarlyBirdFacts} from './app-early-bird.ts';

const FACTS: EarlyBirdFacts = {number: 'W1042', created: '2026-11-02T10:00:00Z', enabled: true, paid: true, canceled: false, qualifying: true};
const ENV = {COMMERCE_SOURCE: 'app', APP_API_URL: 'https://app.example', APP_ACCESS_CLIENT_ID: 'i', APP_ACCESS_CLIENT_SECRET: 's', APP_STOREFRONT_TOKEN: 't', APP_PROJECT: 'p', SESSION_SECRET: 'x'};

describe('app early bird', () => {
  it('maps the app facts so the one rule applies, with the close date from the site', () => {
    const order = toEarlyBirdOrder(FACTS)!;
    assert.equal(order.id, 'app:order/W1042');
    assert.equal(order.name, '#W1042');
    assert.equal(ineligibility(order, '2026-12-31'), null);
    assert.equal(ineligibility(order, '2026-11-01'), 'too-late');
    assert.equal(ineligibility(toEarlyBirdOrder({...FACTS, paid: false})!, '2026-12-31'), 'not-paid');
    assert.equal(ineligibility(toEarlyBirdOrder({...FACTS, canceled: true})!, '2026-12-31'), 'cancelled');
    assert.equal(ineligibility(toEarlyBirdOrder({...FACTS, qualifying: false})!, '2026-12-31'), 'not-preorder');
  });

  it('knows no order while the app has the claim off', () => {
    assert.equal(toEarlyBirdOrder({...FACTS, enabled: false}), null);
  });

  it('reads only well-formed numbers and keys', () => {
    assert.equal(appOrderNumber('W1042'), 'W1042');
    assert.equal(appOrderNumber('1042; drop'), null);
    assert.equal(appOrderNumber(null), null);
    assert.equal(appKey('a'.repeat(32)), 'a'.repeat(32));
    assert.equal(appKey('nope'), null);
  });

  it('asks the app with the key and returns null for an order it refuses', async () => {
    const calls: Array<{url: string; body: Record<string, unknown>}> = [];
    const answer = (body: unknown) => async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown>});
      return new Response(JSON.stringify(body), {headers: {'content-type': 'application/json'}});
    };
    const key = 'a'.repeat(32);
    assert.equal((await readAppOrder(ENV, 'W1042', key, answer({ok: true, data: FACTS}) as typeof fetch))?.id, 'app:order/W1042');
    assert.equal(calls[0]!.url, 'https://app.example/api/ops/storefront.early_bird');
    assert.deepEqual(calls[0]!.body, {project: 'p', number: 'W1042', key});
    assert.equal(await readAppOrder(ENV, 'W1042', key, answer({ok: false, error: {code: 'not_found', detail: 'no such order'}}) as typeof fetch), null);
  });
});
