import {describe, it, mock, after} from 'node:test';
import assert from 'node:assert/strict';
import {contactExists} from './resend.ts';

// Run with:
//   node --experimental-strip-types --test app/lib/growth/resend.test.ts

const CONFIGURED = {RESEND_API_KEY: 'test-key'};

function stubFetch(
  impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
  mock.method(globalThis, 'fetch', impl);
}

describe('contactExists', () => {
  after(() => mock.restoreAll());

  it('returns null when RESEND_API_KEY is unset (degrade-soft)', async () => {
    let calls = 0;
    stubFetch(async () => {
      calls++;
      return new Response('{}', {status: 200});
    });
    const result = await contactExists({}, 'a@example.com');
    assert.equal(result, null);
    assert.equal(calls, 0);
  });

  it('returns false on a 404 (contact does not exist)', async () => {
    stubFetch(async () => new Response('{}', {status: 404}));
    const result = await contactExists(CONFIGURED, 'new@example.com');
    assert.equal(result, false);
  });

  it('returns true when the contact is found', async () => {
    stubFetch(async () =>
      new Response(JSON.stringify({id: '1', email: 'a@example.com'}), {
        status: 200,
        headers: {'content-type': 'application/json'},
      }),
    );
    const result = await contactExists(CONFIGURED, 'a@example.com');
    assert.equal(result, true);
  });

  it('returns null (not thrown) on a transient error', async () => {
    stubFetch(async () => {
      throw new Error('network down');
    });
    const result = await contactExists(CONFIGURED, 'a@example.com');
    assert.equal(result, null);
  });

  it('returns null on an unexpected non-404 error status', async () => {
    stubFetch(async () => new Response('boom', {status: 500}));
    const result = await contactExists(CONFIGURED, 'a@example.com');
    assert.equal(result, null);
  });
});
