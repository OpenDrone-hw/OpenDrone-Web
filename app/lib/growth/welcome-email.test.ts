import {describe, it, mock} from 'node:test';
import assert from 'node:assert/strict';
import {renderWelcomeEmail, sendWelcomeEmail} from './welcome-email.ts';
import {unsubscribeTokenFrom, verifyUnsubscribeToken} from './unsubscribe-token.ts';

// Run with:
//   node --experimental-strip-types --test app/lib/growth/welcome-email.test.ts

const UNSUB = 'https://opendrone.be/newsletter/unsubscribe?t=tok';

describe('renderWelcomeEmail', () => {
  it('carries the unsubscribe link in both bodies', () => {
    const {html, text} = renderWelcomeEmail({unsubscribeUrl: UNSUB});
    assert.ok(html.includes(UNSUB), 'html has the link');
    assert.ok(text.includes(UNSUB), 'text has the link');
  });

  it('names the product when one was asked for, and stays silent otherwise', () => {
    const withProduct = renderWelcomeEmail({
      unsubscribeUrl: UNSUB,
      product: 'openfc-lite',
    });
    assert.ok(withProduct.html.includes('OpenFC Lite'), 'display title, not the handle');
    assert.ok(!withProduct.html.includes('openfc-lite<'), 'handle is not shown raw');

    const plain = renderWelcomeEmail({unsubscribeUrl: UNSUB});
    assert.ok(!plain.html.includes('launch email for'), 'no launch line without a product');
  });

  it('de-slugs an unknown handle rather than printing it raw', () => {
    const {html} = renderWelcomeEmail({unsubscribeUrl: UNSUB, product: 'new-thing'});
    assert.ok(html.includes('New Thing'));
  });
});

describe('sendWelcomeEmail', () => {
  it('skips without RESEND_API_KEY and never throws', async () => {
    assert.equal(await sendWelcomeEmail({}, {email: 'pilot@example.com'}), false);
  });

  it('posts to Resend with a one-click unsubscribe header', async () => {
    let body: any = null;
    mock.method(globalThis, 'fetch', async (_i: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return Response.json({id: 'msg_1'});
    });
    const ok = await sendWelcomeEmail(
      {RESEND_API_KEY: 'test', SESSION_SECRET: 'sekret'},
      {email: 'pilot@example.com'},
    );
    mock.restoreAll();
    assert.equal(ok, true);
    assert.deepEqual(body.to, ['pilot@example.com']);
    assert.equal(body.subject, 'Welcome to Engineering Essentials');
    assert.equal(body.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
    assert.match(body.headers['List-Unsubscribe'], /newsletter\/unsubscribe\?t=/);
  });

  it('the RFC 8058 one-click POST to the List-Unsubscribe URL carries a valid token', async () => {
    let body: any = null;
    mock.method(globalThis, 'fetch', async (_i: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return Response.json({id: 'msg_1'});
    });
    const env = {RESEND_API_KEY: 'test', SESSION_SECRET: 'sekret'};
    await sendWelcomeEmail(env, {email: 'pilot@example.com'});
    mock.restoreAll();
    const url = String(body.headers['List-Unsubscribe']).slice(1, -1);
    // What Gmail, Outlook and Apple Mail POST: only this body, the token stays in the URL.
    const form = new FormData();
    form.set('List-Unsubscribe', 'One-Click');
    const token = unsubscribeTokenFrom(form, url);
    assert.deepEqual(await verifyUnsubscribeToken(env, token), {email: 'pilot@example.com'});
    // The confirm button on the page posts `t` in the form, which wins.
    form.set('t', 'from-form');
    assert.equal(unsubscribeTokenFrom(form, url), 'from-form');
  });

  it('reports failure on a Resend error instead of throwing', async () => {
    mock.method(globalThis, 'fetch', async () => new Response('nope', {status: 422}));
    const ok = await sendWelcomeEmail({RESEND_API_KEY: 'test'}, {email: 'pilot@example.com'});
    mock.restoreAll();
    assert.equal(ok, false);
  });
});
