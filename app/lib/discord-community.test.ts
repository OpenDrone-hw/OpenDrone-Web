import {beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {
  COUNTS_TTL_MS,
  MISS_TTL_MS,
  STALE_MAX_MS,
  COUNTS_CACHE_KEY,
  type CountsCache,
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
    assert.deepEqual(await fetchDiscordCounts({fetchImpl, now, inviteUrl: INVITE, cache: null}), {
      members: 515,
      online: 101,
    });
    clock += COUNTS_TTL_MS - 1;
    await fetchDiscordCounts({fetchImpl, now, inviteUrl: INVITE, cache: null});
    assert.equal(calls, 1);
    clock += 2;
    await fetchDiscordCounts({fetchImpl, now, inviteUrl: INVITE, cache: null});
    assert.equal(calls, 2);
  });

  it('returns null on an HTTP error, so the page hides the numbers', async () => {
    const fetchImpl = async () => jsonResponse({message: 'rate limited'}, 429);
    assert.equal(await fetchDiscordCounts({fetchImpl, inviteUrl: INVITE, cache: null}), null);
  });

  it('returns null when the request throws', async () => {
    const fetchImpl = async (): Promise<Response> => {
      throw new Error('network down');
    };
    assert.equal(await fetchDiscordCounts({fetchImpl, inviteUrl: INVITE, cache: null}), null);
  });

  it('returns null on a body without counts', async () => {
    const fetchImpl = async () => jsonResponse({code: 'v3sWmTcx3R'});
    assert.equal(await fetchDiscordCounts({fetchImpl, inviteUrl: INVITE, cache: null}), null);
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
    assert.equal(await fetchDiscordCounts({fetchImpl, now, inviteUrl: INVITE, cache: null}), null);
    fail = false;
    clock += MISS_TTL_MS - 1;
    assert.equal(await fetchDiscordCounts({fetchImpl, now, inviteUrl: INVITE, cache: null}), null);
    assert.equal(calls, 1);
    clock += 2;
    assert.deepEqual(await fetchDiscordCounts({fetchImpl, now, inviteUrl: INVITE, cache: null}), {
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
      fetchDiscordCounts({fetchImpl, inviteUrl: INVITE, cache: null}),
      fetchDiscordCounts({fetchImpl, inviteUrl: INVITE, cache: null}),
    ]);
    assert.equal(calls, 1);
  });

  it('serves the stored counts while fresh, without calling Discord', async () => {
    const cache = memoryCache();
    let clock = 10_000;
    const now = () => clock;
    const ok = async () =>
      jsonResponse({approximate_member_count: 515, approximate_presence_count: 101});
    await fetchDiscordCounts({fetchImpl: ok, now, inviteUrl: INVITE, cache});
    resetDiscordCountsCache();
    let calls = 0;
    const counting = async () => {
      calls++;
      return ok();
    };
    clock += COUNTS_TTL_MS - 10;
    assert.deepEqual(await fetchDiscordCounts({fetchImpl: counting, now, inviteUrl: INVITE, cache}), {
      members: 515,
      online: 101,
    });
    assert.equal(calls, 0);
  });

  it('serves stored counts up to a day old when Discord rate-limits', async () => {
    const cache = memoryCache();
    let clock = 0;
    const now = () => clock;
    await fetchDiscordCounts({
      fetchImpl: async () =>
        jsonResponse({approximate_member_count: 515, approximate_presence_count: 101}),
      now,
      inviteUrl: INVITE,
      cache,
    });
    const limited = async () => jsonResponse({message: 'You are being rate limited.'}, 429);
    resetDiscordCountsCache();
    clock = STALE_MAX_MS - 1;
    assert.deepEqual(await fetchDiscordCounts({fetchImpl: limited, now, inviteUrl: INVITE, cache}), {
      members: 515,
      online: 101,
    });
    resetDiscordCountsCache();
    clock = STALE_MAX_MS + 1;
    assert.equal(await fetchDiscordCounts({fetchImpl: limited, now, inviteUrl: INVITE, cache}), null);
  });

  it('picks up counts another isolate stored during a remembered miss', async () => {
    const cache = memoryCache();
    let calls = 0;
    const limited = async () => {
      calls++;
      return jsonResponse({}, 429);
    };
    assert.equal(await fetchDiscordCounts({fetchImpl: limited, inviteUrl: INVITE, cache}), null);
    await cache.put(
      COUNTS_CACHE_KEY,
      new Response(JSON.stringify({members: 515, online: 101, at: Date.now()})),
    );
    assert.deepEqual(await fetchDiscordCounts({fetchImpl: limited, inviteUrl: INVITE, cache}), {
      members: 515,
      online: 101,
    });
    assert.equal(calls, 1);
  });
});

function memoryCache(): CountsCache {
  const store = new Map<string, string>();
  return {
    async match(key) {
      const v = store.get(key);
      return v === undefined ? undefined : new Response(v);
    },
    async put(key, res) {
      store.set(key, await res.text());
    },
  };
}
