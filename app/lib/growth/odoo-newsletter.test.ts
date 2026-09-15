import {describe, it, mock, after} from 'node:test';
import assert from 'node:assert/strict';
import {hasNewsletterBridge, subscribeToNewsletter} from './odoo-newsletter.ts';

// Run with:
//   node --experimental-strip-types --test app/lib/growth/odoo-newsletter.test.ts

const CONFIGURED = {
  NEWSLETTER_ODOO_URL: 'https://staging.incutec.eu',
  NEWSLETTER_DISPATCH_SECRET: 'test-secret',
};

function stubFetch(
  impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
  mock.method(globalThis, 'fetch', impl);
}

describe('hasNewsletterBridge', () => {
  it('is false when NEWSLETTER_DISPATCH_SECRET is unset', () => {
    assert.equal(hasNewsletterBridge({}), false);
  });

  it('is true when NEWSLETTER_DISPATCH_SECRET is set', () => {
    assert.equal(hasNewsletterBridge(CONFIGURED), true);
  });
});

describe('subscribeToNewsletter', () => {
  after(() => mock.restoreAll());

  it('returns false (no-op) when NEWSLETTER_DISPATCH_SECRET is unset', async () => {
    let calls = 0;
    stubFetch(async () => {
      calls++;
      return new Response('{"ok":true}', {status: 200});
    });
    const ok = await subscribeToNewsletter(
      {NEWSLETTER_ODOO_URL: 'https://staging.incutec.eu'},
      {email: 'a@example.com'},
    );
    assert.equal(ok, false);
    assert.equal(calls, 0);
  });

  it('posts email + secret header, returns true on {ok: true}', async () => {
    let seenUrl = '';
    let seenInit: RequestInit | undefined;
    stubFetch(async (input, init) => {
      seenUrl = String(input);
      seenInit = init;
      return new Response(JSON.stringify({ok: true}), {
        status: 200,
        headers: {'content-type': 'application/json'},
      });
    });
    const ok = await subscribeToNewsletter(CONFIGURED, {email: 'subscriber@example.com'});
    assert.equal(ok, true);
    assert.equal(seenUrl, 'https://staging.incutec.eu/incutec/newsletter/subscribe');
    assert.equal(seenInit?.method, 'POST');
    assert.equal(
      (seenInit?.headers as Record<string, string>)['X-Newsletter-Dispatch-Secret'],
      'test-secret',
    );
    const body = JSON.parse(String(seenInit?.body)) as {email: string; product?: string};
    assert.equal(body.email, 'subscriber@example.com');
    assert.equal('product' in body, false);
  });

  it('includes product when given', async () => {
    let seenInit: RequestInit | undefined;
    stubFetch(async (_input, init) => {
      seenInit = init;
      return new Response(JSON.stringify({ok: true}), {status: 200});
    });
    await subscribeToNewsletter(CONFIGURED, {email: 'a@example.com', product: 'openrx'});
    const body = JSON.parse(String(seenInit?.body)) as {product?: string};
    assert.equal(body.product, 'openrx');
  });

  it('returns false on a 401 (bad secret), without retrying', async () => {
    let calls = 0;
    stubFetch(async () => {
      calls++;
      return new Response('{"ok":false}', {status: 401});
    });
    const ok = await subscribeToNewsletter(CONFIGURED, {email: 'a@example.com'});
    assert.equal(ok, false);
    assert.equal(calls, 1);
  });

  it('returns false on a 400 (invalid email), without retrying', async () => {
    let calls = 0;
    stubFetch(async () => {
      calls++;
      return new Response('{"ok":false}', {status: 400});
    });
    const ok = await subscribeToNewsletter(CONFIGURED, {email: 'not-an-email'});
    assert.equal(ok, false);
    assert.equal(calls, 1);
  });

  it('retries once on a 500, then returns false', async () => {
    let calls = 0;
    stubFetch(async () => {
      calls++;
      return new Response('boom', {status: 500});
    });
    const ok = await subscribeToNewsletter(CONFIGURED, {email: 'a@example.com'});
    assert.equal(ok, false);
    assert.equal(calls, 2);
  });

  it('retries once on a network error, then returns false', async () => {
    let calls = 0;
    stubFetch(async () => {
      calls++;
      throw new Error('network down');
    });
    const ok = await subscribeToNewsletter(CONFIGURED, {email: 'a@example.com'});
    assert.equal(ok, false);
    assert.equal(calls, 2);
  });

  it('succeeds on the retry after one transient failure', async () => {
    let calls = 0;
    stubFetch(async () => {
      calls++;
      if (calls === 1) return new Response('boom', {status: 502});
      return new Response(JSON.stringify({ok: true}), {status: 200});
    });
    const ok = await subscribeToNewsletter(CONFIGURED, {email: 'a@example.com'});
    assert.equal(ok, true);
    assert.equal(calls, 2);
  });
});
