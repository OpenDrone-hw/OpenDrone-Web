import {describe, it, mock, after} from 'node:test';
import assert from 'node:assert/strict';
import {firstNameOnly, postStaffMetadata} from './discord.ts';

// Run with:
//   node --experimental-strip-types --test app/lib/support/discord.test.ts

type FetchStub = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function stubFetch(impl: FetchStub) {
  mock.method(globalThis, 'fetch', impl);
}

describe('firstNameOnly', () => {
  it('takes the first whitespace-split token', () => {
    assert.equal(firstNameOnly('Jane Doe'), 'Jane');
  });

  it('caps at 40 chars', () => {
    assert.equal(firstNameOnly('A'.repeat(80)).length, 40);
  });

  it('falls back to "Customer" on empty input', () => {
    assert.equal(firstNameOnly(''), 'Customer');
    assert.equal(firstNameOnly('   '), 'Customer');
  });

  it('handles single-word names', () => {
    assert.equal(firstNameOnly('Vitroid'), 'Vitroid');
  });

  it('strips bidi overrides (Trojan-Source) before it hits Discord', () => {
    // U+202E RLO in a Shopify account name must not survive into the
    // public thread, where it could reverse staff's line order.
    const rlo = String.fromCodePoint(0x202e);
    const lri = String.fromCodePoint(0x2066);
    const pdi = String.fromCodePoint(0x2069);
    assert.equal(firstNameOnly(`Ali${rlo}ce`), 'Alice');
    assert.equal(firstNameOnly(`${lri}Bob${pdi}`), 'Bob');
  });

  it('strips C0/C1 control chars', () => {
    const nul = String.fromCodePoint(0x00);
    const c1 = String.fromCodePoint(0x9f);
    assert.equal(firstNameOnly(`Ja${nul}ne`), 'Jane');
    assert.equal(firstNameOnly(`A${c1}B`), 'AB');
  });
});

describe('postStaffMetadata', () => {
  after(() => mock.restoreAll());

  it('returns false (no-op) when DISCORD_STAFF_METADATA_CHANNEL_ID is unset', async () => {
    let calls = 0;
    stubFetch(async () => {
      calls++;
      return new Response('{}', {status: 200});
    });
    const ok = await postStaffMetadata(
      {DISCORD_BOT_TOKEN: 't'},
      'thread-1',
      '[Jane] check',
      {userName: 'Jane Doe', userEmail: 's@example.com'},
    );
    assert.equal(ok, false);
    assert.equal(calls, 0);
  });

  it('posts a message containing email + UA + IP + jump URL', async () => {
    let seenUrl = '';
    let seenBody = '';
    stubFetch(async (input, init) => {
      seenUrl = String(input);
      seenBody = String(init?.body ?? '');
      return new Response(JSON.stringify({id: 'm1'}), {status: 200});
    });
    const ok = await postStaffMetadata(
      {
        DISCORD_BOT_TOKEN: 't',
        DISCORD_STAFF_METADATA_CHANNEL_ID: 'staff-channel',
        DISCORD_GUILD_ID: 'g1',
      },
      'thread-42',
      '[Jane] check',
      {
        userName: 'Test Customer',
        userEmail: 'customer@example.com',
        userAgent: 'Mozilla/5.0 (Macintosh)',
        ipHint: '203.0.113.x',
      },
    );
    assert.equal(ok, true);
    assert.match(seenUrl, /\/channels\/staff-channel\/messages$/);
    const payload = JSON.parse(seenBody) as {content: string};
    assert.match(payload.content, /Test Customer/);
    assert.match(payload.content, /customer@example\.com/);
    assert.match(payload.content, /Mozilla\/5\.0 \(Macintosh\)/);
    assert.match(payload.content, /203\.0\.113\.x/);
    assert.match(
      payload.content,
      /https:\/\/discord\.com\/channels\/g1\/thread-42/,
    );
  });

  it('returns false on upstream error', async () => {
    stubFetch(async () => new Response('forbidden', {status: 403}));
    const ok = await postStaffMetadata(
      {
        DISCORD_BOT_TOKEN: 't',
        DISCORD_STAFF_METADATA_CHANNEL_ID: 'staff-channel',
      },
      'thread-1',
      'subj',
      {userName: 'X', userEmail: 'x@y.com'},
    );
    assert.equal(ok, false);
  });

  it('falls back to @me when DISCORD_GUILD_ID is unset (jump URL still parseable)', async () => {
    let seenBody = '';
    stubFetch(async (_input, init) => {
      seenBody = String(init?.body ?? '');
      return new Response(JSON.stringify({id: 'm1'}), {status: 200});
    });
    await postStaffMetadata(
      {
        DISCORD_BOT_TOKEN: 't',
        DISCORD_STAFF_METADATA_CHANNEL_ID: 'staff-channel',
      },
      'thread-9',
      'subj',
      {userName: 'X', userEmail: 'x@y.com'},
    );
    const payload = JSON.parse(seenBody) as {content: string};
    assert.match(payload.content, /channels\/@me\/thread-9/);
  });
});
