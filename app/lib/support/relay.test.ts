import {describe, it, mock, after} from 'node:test';
import assert from 'node:assert/strict';
import {handleRelayRequest, sanitizeAuthor} from './relay.ts';

// Run with:
//   node --experimental-strip-types --test app/lib/support/relay.test.ts

type FetchStub = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function stubFetch(impl: FetchStub) {
  mock.method(globalThis, 'fetch', impl);
}

const SECRET = 'relay-secret';
const FORUM = '111111111111111111';

const CONFIGURED = {
  SUPPORT_RELAY_SECRET: SECRET,
  DISCORD_BOT_TOKEN: 'bot-token',
  DISCORD_SUPPORT_CHANNEL_ID: FORUM,
};

// Each test uses its own thread id: the rate limiter keys on the thread
// and its buckets live for the whole process.
let seq = 0;
function freshThread(): string {
  seq += 1;
  return String(900000000000000000n + BigInt(seq));
}

function relayRequest(body: unknown, opts: {auth?: string} = {}): Request {
  return new Request('https://opendrone.be/api/support/relay', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(opts.auth === undefined ? {authorization: `Bearer ${SECRET}`} : {authorization: opts.auth}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/**
 * Discord double: GET /channels/{id} answers with the given parent,
 * POST /channels/{id}/messages answers with a created message.
 */
function stubDiscord(opts: {parentId?: string | null; postStatus?: number} = {}) {
  const calls: Array<{url: string; method: string; body?: string}> = [];
  stubFetch(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({url, method, body: init?.body ? String(init.body) : undefined});
    if (method === 'GET') {
      return new Response(
        JSON.stringify({
          id: url.split('/').pop(),
          parent_id: opts.parentId === undefined ? FORUM : opts.parentId,
          thread_metadata: {archived: false, locked: false},
        }),
        {status: 200, headers: {'content-type': 'application/json'}},
      );
    }
    const status = opts.postStatus ?? 200;
    if (status >= 400) return new Response('nope', {status});
    return new Response(
      JSON.stringify({
        id: '777777777777777777',
        content: 'ok',
        timestamp: '2026-09-18T10:00:00.000Z',
        author: {id: '1', username: 'bot', bot: true},
        attachments: [],
      }),
      {status: 200, headers: {'content-type': 'application/json'}},
    );
  });
  return calls;
}

describe('sanitizeAuthor', () => {
  it('falls back to "Support" on an empty label', () => {
    assert.equal(sanitizeAuthor(''), 'Support');
    assert.equal(sanitizeAuthor('   '), 'Support');
  });

  it('strips bidi overrides and control chars', () => {
    const rlo = String.fromCodePoint(0x202e);
    assert.equal(sanitizeAuthor(`Sta${rlo}n`), 'Stan');
    assert.equal(sanitizeAuthor(`A${String.fromCodePoint(0x00)}B`), 'AB');
  });

  it('strips markdown so the label cannot break out of its prefix', () => {
    assert.equal(sanitizeAuthor('**Stan**'), 'Stan');
  });

  it('caps the label length', () => {
    assert.equal(sanitizeAuthor('A'.repeat(200)).length, 60);
  });
});

describe('handleRelayRequest: configuration and auth', () => {
  after(() => mock.restoreAll());

  it('is inert (503, no Discord call) when SUPPORT_RELAY_SECRET is unset', async () => {
    const calls = stubDiscord();
    const res = await handleRelayRequest(
      {DISCORD_BOT_TOKEN: 'bot-token', DISCORD_SUPPORT_CHANNEL_ID: FORUM},
      relayRequest({thread_id: freshThread(), body: 'hello'}),
    );
    assert.equal(res.status, 503);
    assert.deepEqual(res.body, {
      ok: false,
      message: 'Relay endpoint not configured.',
      code: 'not-configured',
    });
    assert.equal(calls.length, 0);
  });

  it('is inert when DISCORD_SUPPORT_CHANNEL_ID is unset', async () => {
    const calls = stubDiscord();
    const res = await handleRelayRequest(
      {SUPPORT_RELAY_SECRET: SECRET, DISCORD_BOT_TOKEN: 'bot-token'},
      relayRequest({thread_id: freshThread(), body: 'hello'}),
    );
    assert.equal(res.status, 503);
    assert.equal(calls.length, 0);
  });

  it('rejects a wrong bearer without calling Discord', async () => {
    const calls = stubDiscord();
    const res = await handleRelayRequest(
      CONFIGURED,
      relayRequest({thread_id: freshThread(), body: 'hello'}, {auth: 'Bearer wrong-secret'}),
    );
    assert.equal(res.status, 401);
    assert.equal((res.body as {code?: string}).code, 'unauthorized');
    assert.equal(calls.length, 0);
  });

  it('rejects a missing Authorization header', async () => {
    stubDiscord();
    const res = await handleRelayRequest(
      CONFIGURED,
      relayRequest({thread_id: freshThread(), body: 'hello'}, {auth: ''}),
    );
    assert.equal(res.status, 401);
  });

  it('rejects a non-POST method', async () => {
    const calls = stubDiscord();
    const res = await handleRelayRequest(
      CONFIGURED,
      new Request('https://opendrone.be/api/support/relay', {
        method: 'GET',
        headers: {authorization: `Bearer ${SECRET}`},
      }),
    );
    assert.equal(res.status, 405);
    assert.equal(calls.length, 0);
  });
});

describe('handleRelayRequest: input validation', () => {
  after(() => mock.restoreAll());

  it('rejects a body that is not JSON', async () => {
    stubDiscord();
    const res = await handleRelayRequest(CONFIGURED, relayRequest('not json'));
    assert.equal(res.status, 400);
    assert.equal((res.body as {code?: string}).code, 'bad-request');
  });

  it('rejects a JSON array body', async () => {
    stubDiscord();
    const res = await handleRelayRequest(CONFIGURED, relayRequest([1, 2, 3]));
    assert.equal(res.status, 400);
  });

  it('rejects a thread id that is not a snowflake', async () => {
    const calls = stubDiscord();
    for (const candidate of ['', 'abc', '123', '1'.repeat(21), '12345678901234567x']) {
      const res = await handleRelayRequest(
        CONFIGURED,
        relayRequest({thread_id: candidate, body: 'hi'}),
      );
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(candidate)}`);
    }
    assert.equal(calls.length, 0);
  });

  it('rejects an empty body', async () => {
    stubDiscord();
    const res = await handleRelayRequest(
      CONFIGURED,
      relayRequest({thread_id: freshThread(), body: '   '}),
    );
    assert.equal(res.status, 400);
  });

  it('rejects a body over the length cap', async () => {
    stubDiscord();
    const res = await handleRelayRequest(
      CONFIGURED,
      relayRequest({thread_id: freshThread(), body: 'x'.repeat(1801)}),
    );
    assert.equal(res.status, 400);
    assert.match((res.body as {message: string}).message, /too long/);
  });

  it('rejects a malformed ticket_ref', async () => {
    stubDiscord();
    const res = await handleRelayRequest(
      CONFIGURED,
      relayRequest({thread_id: freshThread(), body: 'hi', ticket_ref: 'SUP 1 <script>'}),
    );
    assert.equal(res.status, 400);
  });
});

describe('handleRelayRequest: support-forum check', () => {
  after(() => mock.restoreAll());

  it('refuses a thread whose parent is another channel, and posts nothing', async () => {
    const calls = stubDiscord({parentId: '222222222222222222'});
    const res = await handleRelayRequest(
      CONFIGURED,
      relayRequest({thread_id: freshThread(), body: 'hi'}),
    );
    assert.equal(res.status, 403);
    assert.equal((res.body as {code?: string}).code, 'wrong-channel');
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
  });

  it('refuses a top-level channel (no parent)', async () => {
    const calls = stubDiscord({parentId: null});
    const res = await handleRelayRequest(
      CONFIGURED,
      relayRequest({thread_id: freshThread(), body: 'hi'}),
    );
    assert.equal(res.status, 403);
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
  });

  it('fails closed when the thread lookup errors', async () => {
    stubFetch(async (input, init) => {
      if ((init?.method ?? 'GET') === 'GET') return new Response('gone', {status: 404});
      throw new Error('should not post');
    });
    const res = await handleRelayRequest(
      CONFIGURED,
      relayRequest({thread_id: freshThread(), body: 'hi'}),
    );
    assert.equal(res.status, 403);
  });
});

describe('handleRelayRequest: posting', () => {
  after(() => mock.restoreAll());

  it('posts to the thread with no mentions and returns the message id', async () => {
    const calls = stubDiscord();
    const thread = freshThread();
    const res = await handleRelayRequest(
      CONFIGURED,
      relayRequest({
        thread_id: thread,
        body: 'Send it back for a warranty check.',
        author: 'Stan',
        ticket_ref: 'SUP-00007',
      }),
    );
    assert.deepEqual(res.body, {ok: true, id: '777777777777777777'});
    assert.equal(res.status, 200);

    const post = calls.find((c) => c.method === 'POST');
    assert.ok(post, 'expected a POST to Discord');
    assert.equal(post.url, `https://discord.com/api/v10/channels/${thread}/messages`);
    const payload = JSON.parse(post.body ?? '{}') as {
      content: string;
      allowed_mentions: {parse: string[]};
    };
    assert.deepEqual(payload.allowed_mentions, {parse: []});
    assert.equal(payload.content, '**Stan:**\nSend it back for a warranty check.');
  });

  it('never lets a relayed @everyone become a ping', async () => {
    const calls = stubDiscord();
    const res = await handleRelayRequest(
      CONFIGURED,
      relayRequest({thread_id: freshThread(), body: '@everyone please read this'}),
    );
    assert.equal(res.status, 200);
    const post = calls.find((c) => c.method === 'POST');
    const payload = JSON.parse(post?.body ?? '{}') as {allowed_mentions: {parse: string[]}};
    assert.deepEqual(payload.allowed_mentions, {parse: []});
  });

  it('labels an author-less relay "Support"', async () => {
    const calls = stubDiscord();
    await handleRelayRequest(
      CONFIGURED,
      relayRequest({thread_id: freshThread(), body: 'hi'}),
    );
    const post = calls.find((c) => c.method === 'POST');
    const payload = JSON.parse(post?.body ?? '{}') as {content: string};
    assert.equal(payload.content, '**Support:**\nhi');
  });

  it('returns 502 when Discord refuses the message', async () => {
    stubDiscord({postStatus: 429});
    const res = await handleRelayRequest(
      CONFIGURED,
      relayRequest({thread_id: freshThread(), body: 'hi'}),
    );
    assert.equal(res.status, 502);
    assert.equal((res.body as {code?: string}).code, 'discord');
  });
});

describe('handleRelayRequest: rate limit', () => {
  after(() => mock.restoreAll());

  it('caps repeated relays into one thread', async () => {
    stubDiscord();
    const thread = freshThread();
    let limited = 0;
    for (let i = 0; i < 25; i++) {
      const res = await handleRelayRequest(
        CONFIGURED,
        relayRequest({thread_id: thread, body: `message ${i}`}),
      );
      if (res.status === 429) {
        limited++;
        assert.ok(res.headers?.['Retry-After']);
      }
    }
    assert.ok(limited > 0, 'expected the per-thread cap to bite');
  });
});
