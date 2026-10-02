import {beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {
  COUNTS_TTL_MS,
  MISS_TTL_MS,
  fetchDiscordCounts,
  inviteApiUrl,
  inviteCode,
  parseInviteCounts,
  resetDiscordCountsCache,
} from './discord-community.ts';

// Run with:
//   node --experimental-strip-types --test app/lib/discord-community.test.ts

const INVITE = 'https://discord.gg/v3sWmTcx3R';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'Content-Type': 'application/json'},
  });
}

describe('invite URL', () => {
  it('reads the code from the public invite', () => {
    assert.equal(inviteCode(INVITE), 'v3sWmTcx3R');
    assert.equal(inviteCode('https://discord.com/invite/abc-1'), 'abc-1');
    assert.equal(inviteCode('https://example.com/x'), null);
  });

  it('asks the v10 invite endpoint for counts', () => {
    assert.equal(
      inviteApiUrl(INVITE),
      'https://discord.com/api/v10/invites/v3sWmTcx3R?with_counts=true',
    );
  });
});

describe('parseInviteCounts', () => {
  it('returns members and online', () => {
    assert.deepEqual(
      parseInviteCounts({approximate_member_count: 515, approximate_presence_count: 101}),
      {members: 515, online: 101},
    );
  });

  it('rejects missing, zero or inconsistent counts', () => {
    assert.equal(parseInviteCounts(null), null);
    assert.equal(parseInviteCounts({code: 'x'}), null);
    assert.equal(
      parseInviteCounts({approximate_member_count: 0, approximate_presence_count: 0}),
      null,
    );
    assert.equal(
      parseInviteCounts({approximate_member_count: 10, approximate_presence_count: 11}),
      null,
    );
    assert.equal(
      parseInviteCounts({approximate_member_count: '515', approximate_presence_count: 1}),
      null,
    );
  });
});

describe('fetchDiscordCounts', () => {
  beforeEach(() => resetDiscordCountsCache());

  it('returns the counts on success and caches them for an hour', async () => {
    let calls = 0;
    let clock = 1_000;
    const fetchImpl = async (url: string) => {
      calls++;
      assert.match(url, /invites\/v3sWmTcx3R\?with_counts=true$/);
      return jsonResponse({approximate_member_count: 515, approximate_presence_count: 101});
    };
    const now = () => clock;
    assert.deepEqual(await fetchDiscordCounts({fetchImpl, now, inviteUrl: INVITE}), {
      members: 515,
      online: 101,
    });
    clock += COUNTS_TTL_MS - 1;
    await fetchDiscordCounts({fetchImpl, now, inviteUrl: INVITE});
    assert.equal(calls, 1);
    clock += 2;
    await fetchDiscordCounts({fetchImpl, now, inviteUrl: INVITE});
    assert.equal(calls, 2);
  });

  it('returns null on an HTTP error, so the page hides the numbers', async () => {
    const fetchImpl = async () => jsonResponse({message: 'rate limited'}, 429);
    assert.equal(await fetchDiscordCounts({fetchImpl, inviteUrl: INVITE}), null);
  });

  it('returns null when the request throws', async () => {
    const fetchImpl = async (): Promise<Response> => {
      throw new Error('network down');
    };
    assert.equal(await fetchDiscordCounts({fetchImpl, inviteUrl: INVITE}), null);
  });

  it('returns null on a body without counts', async () => {
    const fetchImpl = async () => jsonResponse({code: 'v3sWmTcx3R'});
    assert.equal(await fetchDiscordCounts({fetchImpl, inviteUrl: INVITE}), null);
  });

  it('remembers a miss for five minutes, then tries again', async () => {
    let calls = 0;
    let clock = 0;
    let fail = true;
    const fetchImpl = async () => {
      calls++;
      return fail
        ? jsonResponse({}, 500)
        : jsonResponse({approximate_member_count: 520, approximate_presence_count: 90});
    };
    const now = () => clock;
    assert.equal(await fetchDiscordCounts({fetchImpl, now, inviteUrl: INVITE}), null);
    fail = false;
    clock += MISS_TTL_MS - 1;
    assert.equal(await fetchDiscordCounts({fetchImpl, now, inviteUrl: INVITE}), null);
    assert.equal(calls, 1);
    clock += 2;
    assert.deepEqual(await fetchDiscordCounts({fetchImpl, now, inviteUrl: INVITE}), {
      members: 520,
      online: 90,
    });
  });

  it('shares one request between concurrent callers', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return jsonResponse({approximate_member_count: 515, approximate_presence_count: 101});
    };
    await Promise.all([
      fetchDiscordCounts({fetchImpl, inviteUrl: INVITE}),
      fetchDiscordCounts({fetchImpl, inviteUrl: INVITE}),
    ]);
    assert.equal(calls, 1);
  });
});
