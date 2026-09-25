import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {describe, it} from 'node:test';
import {supportHeaders} from './server.ts';

const route = (name: string) => readFileSync(new URL(`../../routes/${name}`, import.meta.url), 'utf8');

describe('support route headers (security finding 3)', () => {
  it('every support page exports headers', () => {
    for (const f of ['support.tsx', 'support_.t.$ref.tsx', 'support_.find.tsx', 'support_.resume.tsx']) {
      assert.match(route(f), /export const headers = supportHeaders;/, f);
    }
  });

  it('keeps no-store and noindex, merges action cookies', () => {
    const h = supportHeaders({
      loaderHeaders: new Headers({'Cache-Control': 'public, max-age=60'}),
      actionHeaders: new Headers([
        ['Set-Cookie', 'od_support=a; Path=/'],
        ['Set-Cookie', 'other=b; Path=/'],
      ]),
    });
    assert.equal(h.get('Cache-Control'), 'private, no-store');
    assert.equal(h.get('X-Robots-Tag'), 'noindex, nofollow');
    assert.deepEqual(h.getSetCookie(), ['od_support=a; Path=/', 'other=b; Path=/']);
  });
});

describe('per-ticket limits run after authorisation (findings 4 and 6)', () => {
  const after = (src: string, first: string, second: string) => {
    const a = src.indexOf(first);
    const b = src.indexOf(second);
    assert.ok(a >= 0 && b >= 0, `${first} / ${second}`);
    return b > a;
  };

  it('refresh and attachment limits count only for the ticket holder', () => {
    assert.ok(after(route('api.support.tickets.$ref.tsx'), 'authorizedTicket(', "ticketRateLimit('poll'"));
    assert.ok(after(route('api.support.tickets.$ref.files.$message.$attachment.tsx'), 'authorizedTicket(', "ticketRateLimit('file'"));
  });

  it('reply, solve and replace-link share one write limit, after authorisation', () => {
    const src = route('support_.t.$ref.tsx');
    assert.ok(after(src, 'authorizedTicket(', "ticketRateLimit('write'"));
    assert.ok(after(src, "ticketRateLimit('write'", "intent === 'solve'"));
    assert.ok(after(src, "ticketRateLimit('write'", "intent === 'reset'"));
  });

  it('anonymous doors count in D1 by IP and IP plus email, never email alone', () => {
    assert.match(route('support.tsx'), /\['createPerIp', ip\],\s*\['createPerIpEmail', ip, parsed\.input\.email\]/);
    assert.match(route('support_.find.tsx'), /\['findPerIp', ip\],\s*\['findPerIpEmail', ip, email\]/);
  });
});
