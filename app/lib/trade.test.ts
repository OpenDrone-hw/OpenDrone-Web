import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {validateTradeApplication, submitTradeApplication, type TradeApplication} from './trade.ts';

const ENV = {TRADE_MAIL_ENABLED: '1', RESEND_API_KEY: 'test-key'};
const fields = {company: 'Test shop', contactName: 'Test Buyer', email: 'buyer@example.com', country: 'BE', site: 'shop.example', note: 'Interested in frames.'};
function form(values = fields) { const f = new FormData(); for (const [key, value] of Object.entries(values)) f.set(key, value); return f; }
function application(): TradeApplication { const result = validateTradeApplication(form()); if (!result.ok) throw new Error('Invalid fixture'); return result.application; }

describe('wholesale application validation', () => {
  it('accepts a physical shop without a website and without order or tax details', () => {
    assert.equal(validateTradeApplication(form({...fields, site: '', note: ''})).ok, true);
  });
  it('rejects unsupported destinations and malformed or overlong fields', () => {
    for (const [key, value] of [['country', 'GB'], ['company', 'x'], ['company', 'shop\nother'], ['contactName', ''], ['email', 'wrong'], ['note', 'x'.repeat(2001)], ['site', 'javascript:alert(1)'], ['site', 'https://user:password@shop.example']]) {
      assert.equal(validateTradeApplication(form({...fields, [key]: value})).ok, false, key);
    }
  });
});

describe('wholesale application mail', () => {
  type MailCall = {url: string; headers: Record<string, string>; body: {from: string; to: string[]; reply_to: string; subject: string; text: string}};
  function recorder(status = 200) {
    const calls: MailCall[] = [];
    const api = (async (url, init) => {
      calls.push({url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) as MailCall['body']});
      return new Response('{}', {status});
    }) as typeof fetch;
    return {calls, api};
  }

  it('fails closed without the explicit switch or the Resend key', async () => {
    const never = (async () => { throw new Error('must not call Resend'); }) as typeof fetch;
    assert.deepEqual(await submitTradeApplication({...ENV, TRADE_MAIL_ENABLED: '0'}, application(), never), {ok: false, reason: 'not_configured'});
    assert.deepEqual(await submitTradeApplication({...ENV, RESEND_API_KEY: ''}, application(), never), {ok: false, reason: 'not_configured'});
  });
  it('mails the company inbox only, with reply-to the applicant and every field', async () => {
    const {calls, api} = recorder();
    assert.deepEqual(await submitTradeApplication(ENV, application(), api), {ok: true});
    assert.equal(calls.length, 1);
    const [{url, body}] = calls;
    assert.equal(url, 'https://api.resend.com/emails');
    assert.deepEqual(body.to, ['contact@opendrone.be']);
    assert.equal(body.reply_to, 'buyer@example.com');
    assert.equal(body.subject, 'Wholesale application: Test shop (BE)');
    for (const part of ['Test Buyer', 'buyer@example.com', 'Belgium (BE)', 'https://shop.example/', 'Interested in frames.']) assert.match(body.text, new RegExp(part.replace(/[.()]/g, '\\$&')));
  });
  it('uses one idempotency key for a repeated application', async () => {
    const {calls, api} = recorder();
    await submitTradeApplication(ENV, application(), api);
    const retry = validateTradeApplication(form({...fields, company: ' TEST   SHOP ', email: 'BUYER@EXAMPLE.COM', note: 'Updated message'}));
    assert.ok(retry.ok);
    await submitTradeApplication(ENV, retry.application, api);
    assert.match(calls[0].headers['Idempotency-Key'], /^wholesale-[0-9a-f]{64}$/);
    assert.equal(calls[0].headers['Idempotency-Key'], calls[1].headers['Idempotency-Key']);
  });
  it('never confirms an application Resend rejected or did not answer', async () => {
    assert.deepEqual(await submitTradeApplication(ENV, application(), recorder(422).api), {ok: false, reason: 'unavailable'});
    const down = (async () => { throw new Error('timeout'); }) as typeof fetch;
    assert.deepEqual(await submitTradeApplication(ENV, application(), down), {ok: false, reason: 'unavailable'});
  });
});
