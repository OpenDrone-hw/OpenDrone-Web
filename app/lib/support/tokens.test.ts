import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {
  RESUME_TTL_SECONDS,
  newTicketRef,
  parseTicketRef,
  readTicketCookie,
  resumeUrl,
  signResumeToken,
  ticketCookie,
  verifyResumeToken,
  withTicket,
} from './tokens.ts';

const ENV = {SUPPORT_SESSION_SECRET: 'secret-one'};
const NOW = Date.parse('2026-09-01T00:00:00Z');

function cookieRequest(setCookie: string): Request {
  return new Request('https://opendrone.be/support', {headers: {Cookie: setCookie.split(';')[0]!}});
}

describe('ticket references', () => {
  it('are OD-XXXX-XXXX in an unambiguous alphabet', () => {
    for (let i = 0; i < 200; i++) assert.match(newTicketRef(), /^OD-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  });

  it('parse what people type', () => {
    assert.equal(parseTicketRef('od k7m4 q2xf'), 'OD-K7M4-Q2XF');
    assert.equal(parseTicketRef('K7M4Q2XF'), 'OD-K7M4-Q2XF');
    assert.equal(parseTicketRef('OD-K7M4-Q2XI'), null);
    assert.equal(parseTicketRef('1042'), null);
    assert.equal(parseTicketRef(''), null);
  });
});

describe('resume tokens', () => {
  it('round-trip reference and link version', async () => {
    const token = await signResumeToken(ENV, 'OD-K7M4-Q2XF', 3, NOW);
    assert.deepEqual(await verifyResumeToken(ENV, token, NOW + 1000), {ref: 'OD-K7M4-Q2XF', version: 3});
    assert.match(resumeUrl('https://opendrone.be', token), /^https:\/\/opendrone\.be\/support\/resume\?t=/);
  });

  it('reject a tampered payload or signature', async () => {
    const token = await signResumeToken(ENV, 'OD-K7M4-Q2XF', 1, NOW);
    const [body, sig] = token.split('.') as [string, string];
    const forged = Buffer.from(JSON.stringify({v: 2, r: 'OD-AAAA-BBBB', k: 1, exp: 9e9, aud: 'support-resume-v2'})).toString('base64url');
    assert.equal(await verifyResumeToken(ENV, `${forged}.${sig}`, NOW), null);
    assert.equal(await verifyResumeToken(ENV, `${body}.${sig.slice(0, -2)}xx`, NOW), null);
    assert.equal(await verifyResumeToken(ENV, `${body}.${sig}.extra`, NOW), null);
    assert.equal(await verifyResumeToken(ENV, 'garbage', NOW), null);
    assert.equal(await verifyResumeToken(ENV, null, NOW), null);
  });

  it('reject another secret', async () => {
    const token = await signResumeToken(ENV, 'OD-K7M4-Q2XF', 1, NOW);
    assert.equal(await verifyResumeToken({SUPPORT_SESSION_SECRET: 'secret-two'}, token, NOW), null);
  });

  it('expire after 90 days', async () => {
    const token = await signResumeToken(ENV, 'OD-K7M4-Q2XF', 1, NOW);
    assert.ok(await verifyResumeToken(ENV, token, NOW + (RESUME_TTL_SECONDS - 60) * 1000));
    assert.equal(await verifyResumeToken(ENV, token, NOW + (RESUME_TTL_SECONDS + 60) * 1000), null);
  });

  it('never pass as a ticket cookie, nor the reverse', async () => {
    const token = await signResumeToken(ENV, 'OD-K7M4-Q2XF', 1, NOW);
    assert.deepEqual(await readTicketCookie(ENV, cookieRequest(`od_support=${token}`)), []);
    const cookie = await ticketCookie(ENV, [{r: 'OD-K7M4-Q2XF', k: 1}]);
    const value = cookie.split(';')[0]!.slice('od_support='.length);
    assert.equal(await verifyResumeToken(ENV, value, NOW), null);
  });
});

describe('ticket cookie', () => {
  it('is HttpOnly, Secure, SameSite=Lax and holds the tickets', async () => {
    const cookie = await ticketCookie(ENV, [{r: 'OD-K7M4-Q2XF', k: 2}]);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Lax/);
    assert.deepEqual(await readTicketCookie(ENV, cookieRequest(cookie)), [{r: 'OD-K7M4-Q2XF', k: 2}]);
  });

  it('puts the newest ticket first, deduplicates and caps the list', async () => {
    let cookie = await ticketCookie(ENV, []);
    for (let i = 0; i < 15; i++) {
      const current = await readTicketCookie(ENV, cookieRequest(cookie));
      cookie = await withTicket(ENV, current, {r: `OD-AAAA-${String(i).padStart(4, '0')}`.replace(/1/g, 'B'), k: 1});
    }
    const again = await readTicketCookie(ENV, cookieRequest(cookie));
    cookie = await withTicket(ENV, again, {r: again[5]!.r, k: 2});
    const list = await readTicketCookie(ENV, cookieRequest(cookie));
    assert.equal(list.length, 12);
    assert.deepEqual(list[0], {r: again[5]!.r, k: 2});
    assert.equal(new Set(list.map((t) => t.r)).size, 12);
  });

  it('is ignored when tampered', async () => {
    const cookie = await ticketCookie(ENV, [{r: 'OD-K7M4-Q2XF', k: 1}]);
    assert.deepEqual(await readTicketCookie(ENV, cookieRequest(cookie.replace(/\.(.)/, '.A$1'))), []);
  });
});
