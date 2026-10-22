import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {ineligibility} from '../early-bird.ts';
import type {AccountOrder} from './app-account.ts';
import {accountClaimRows, appKey, proveAccountRows, settleRow, appOrderNumber, readAppOrder, toEarlyBirdOrder, type EarlyBirdFacts} from './app-early-bird.ts';

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

  it('lists the signed-in customer orders that are paid, not cancelled and in time', () => {
    const o = (number: string, payment: string, created: string, canceled = false) =>
      ({number, created, canceled, state: {payment, fulfilment: 'none'}}) as unknown as AccountOrder;
    const rows = accountClaimRows(
      [o('W1', 'paid', '2026-11-02T10:00:00Z'), o('W2', 'none', '2026-11-02T10:00:00Z'), o('W3', 'paid', '2026-11-02T10:00:00Z', true), o('W4', 'paid', '2027-02-01T10:00:00Z'), o('W5', 'partially_refunded', '2026-11-03T10:00:00Z')],
      '2026-12-31',
    );
    assert.deepEqual(rows.map((r) => r.name), ['#W1', '#W5']);
  });

  it('proves account rows with the session and falls back to the reminder', async () => {
    const row = (number: string) => ({id: `app:order/${number}`, number, name: `#${number}`, createdAt: '2026-11-02T10:00:00Z', state: 'unchecked' as const});
    const bodies: Array<Record<string, unknown>> = [];
    const fetcher = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      const n = body.number;
      const reply =
        n === 'W1' ? {ok: true, data: FACTS} : n === 'W2' ? {ok: true, data: {...FACTS, qualifying: false}} : {ok: false, error: {code: 'not_found', detail: 'no such order'}};
      return new Response(JSON.stringify(reply), {headers: {'content-type': 'application/json'}});
    }) as typeof fetch;
    const rows = await proveAccountRows(ENV, 'S'.repeat(20), [row('W1'), row('W2'), row('W3')], '2026-12-31', fetcher);
    assert.deepEqual(rows.map((r) => [r.number, r.state]), [['W1', 'claim'], ['W3', 'unchecked']]);
    assert.deepEqual(bodies[0], {project: 'p', number: 'W1', session: 'S'.repeat(20)});
    assert.equal(settleRow(row('W9'), null, '2026-12-31')?.state, 'unchecked');
  });
});
