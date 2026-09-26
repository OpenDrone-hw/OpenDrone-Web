import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {
  chunkMessage,
  cleanText,
  compareSnowflakes,
  createDiscordClient,
  customerBody,
  escapeDiscord,
  neutralizeLinks,
  rateRoute,
  sanitizeFilename,
  threadName,
} from './discord.ts';
import {_resetModCache, cursorAfter, decide, resolveMode} from './moderation.ts';
import {fakeDiscord} from './testing.ts';

type Call = {method: string; url: string; body: unknown};

function fakeFetch(routes: Array<[string, (call: Call) => unknown]>, calls: Call[] = []) {
  const table = new Map(routes);
  return (async (url: string, init: RequestInit = {}) => {
    const body = init.body instanceof FormData ? JSON.parse(String(init.body.get('payload_json'))) : init.body ? JSON.parse(String(init.body)) : null;
    const call = {method: init.method ?? 'GET', url: String(url), body};
    calls.push(call);
    const key = `${call.method} ${new URL(call.url).pathname}`;
    const handler = table.get(key);
    if (!handler) return new Response('not found', {status: 404});
    const out = handler(call);
    return out instanceof Response ? out : new Response(JSON.stringify(out), {status: 200});
  }) as unknown as typeof fetch;
}

const ENV = {DISCORD_BOT_TOKEN: 'tok', DISCORD_SUPPORT_CHANNEL_ID: '100', SUPPORT_MOD_ROLE_ID: '555'};

describe('Discord client', () => {
  it('opens a private, non-invitable thread in a text channel and adds the support role by mention', async () => {
    const calls: Call[] = [];
    const client = createDiscordClient(
      ENV,
      fakeFetch(
        [
          ['GET /api/v10/channels/100', () => ({id: '100', type: 0})],
          ['POST /api/v10/channels/100/threads', () => ({id: '200'})],
          ['POST /api/v10/channels/200/messages', () => ({id: '201'})],
        ],
        calls,
      ),
    );
    assert.equal(await client.createThread({name: 'OD-AAAA-BBBB order Jan', card: 'card <@&555>'}), '200');
    const create = calls.find((c) => c.url.endsWith('/threads'))!;
    assert.deepEqual(create.body, {name: 'OD-AAAA-BBBB order Jan', type: 12, invitable: false, auto_archive_duration: 10080});
    const card = calls.find((c) => c.url.endsWith('/200/messages'))!;
    assert.deepEqual((card.body as {allowed_mentions: unknown}).allowed_mentions, {parse: [], roles: ['555']});
  });

  it('opens a post when the support channel is a forum', async () => {
    const calls: Call[] = [];
    const client = createDiscordClient(
      ENV,
      fakeFetch(
        [
          ['GET /api/v10/channels/100', () => ({id: '100', type: 15})],
          ['POST /api/v10/channels/100/threads', () => ({id: '300'})],
        ],
        calls,
      ),
    );
    assert.equal(await client.createThread({name: 'x', card: 'card'}), '300');
    assert.equal((calls[1]!.body as {message: {content: string}}).message.content, 'card');
  });

  it('never lists a bot account as a reactor', async () => {
    const client = createDiscordClient(
      ENV,
      fakeFetch([
        [
          'GET /api/v10/channels/9/messages/10/reactions/%E2%9C%85',
          () => [{id: '1', bot: true}, {id: '2'}, {id: '3', bot: false}],
        ],
      ]),
    );
    assert.deepEqual(await client.reactors('9', '10', '✅'), ['2', '3']);
  });

  it('never lets a relayed message ping anyone and strips bidi overrides', async () => {
    const calls: Call[] = [];
    const client = createDiscordClient(ENV, fakeFetch([['POST /api/v10/channels/9/messages', () => ({id: '10'})]], calls));
    await client.post('9', '@everyone look\u202Eevil');
    assert.deepEqual(calls[0]!.body, {content: '@everyone lookevil', allowed_mentions: {parse: []}});
  });

  it('sends files as multipart with sanitised names', async () => {
    let names: string[] = [];
    const fetcher = (async (_url: string, init: RequestInit) => {
      const form = init.body as FormData;
      names = [...form.entries()].filter(([k]) => k.startsWith('files')).map(([, v]) => (v as File).name);
      return new Response(JSON.stringify({id: '1'}), {status: 200});
    }) as unknown as typeof fetch;
    await createDiscordClient(ENV, fetcher).post('9', 'x', [{name: '../../etc\u202Egpj.exe', type: 'image/png', data: new Uint8Array([1])}]);
    assert.deepEqual(names, ['.._.._etcgpj.exe']);
  });

  it('returns messages oldest first', async () => {
    const msg = (id: string) => ({id, content: id, timestamp: '2026-09-01T00:00:00Z', author: {id: 'u', username: 'u'}});
    const client = createDiscordClient(
      ENV,
      fakeFetch([['GET /api/v10/channels/9/messages', () => [msg('1000000000000000011'), msg('999999999999999999'), msg('1000000000000000002')]]]),
    );
    assert.deepEqual((await client.messagesAfter('9', null)).map((m) => m.id), ['999999999999999999', '1000000000000000002', '1000000000000000011']);
  });

  it('treats a missing thread as null and a deleted one as done', async () => {
    const client = createDiscordClient(ENV, fakeFetch([]));
    assert.equal(await client.thread('9'), null);
    await client.deleteThread('9');
  });

  it('throws on other Discord errors', async () => {
    const client = createDiscordClient(ENV, fakeFetch([['POST /api/v10/channels/9/messages', () => new Response('nope', {status: 500})]]));
    await assert.rejects(client.post('9', 'x'), /500/);
  });
});

describe('moderator lookup', () => {
  it('reads one guild member instead of listing members, and treats a missing member as no role', async () => {
    const calls: Call[] = [];
    const client = createDiscordClient(
      {...ENV, DISCORD_GUILD_ID: 'g'},
      fakeFetch([['GET /api/v10/guilds/g/members/7', () => ({roles: ['1', '555']})]], calls),
    );
    assert.equal(await client.hasRole('7', '555'), true);
    assert.equal(await client.hasRole('7', '999'), false);
    assert.equal(await client.hasRole('8', '555'), false, '404: not a member');
    assert.ok(calls.every((c) => !new URL(c.url).pathname.endsWith('/members')), 'never lists members');
  });
});

describe('Discord rate limits (finding b)', () => {
  const noSleep = {sleep: async (ms: number) => void slept.push(ms), now: () => 1_000_000};
  const slept: number[] = [];

  it('waits Retry-After once after a 429, then succeeds', async () => {
    slept.length = 0;
    let n = 0;
    const client = createDiscordClient(
      ENV,
      fakeFetch([
        ['POST /api/v10/channels/9/messages', () => (n++ === 0 ? new Response(JSON.stringify({retry_after: 0.4, global: false}), {status: 429}) : {id: '10'})],
      ]),
      noSleep,
    );
    assert.equal(await client.post('9', 'x'), '10');
    assert.deepEqual(slept, [400]);
  });

  it('gives up with a 429 when the wait is long, without retrying', async () => {
    const calls: Call[] = [];
    const client = createDiscordClient(
      ENV,
      fakeFetch([['GET /api/v10/channels/9/messages', () => new Response('{}', {status: 429, headers: {'Retry-After': '30'}})]], calls),
      noSleep,
    );
    await assert.rejects(client.messagesAfter('9', null), /429/);
    assert.equal(calls.length, 1);
    // The route stays blocked for this client: no second request.
    await assert.rejects(client.messagesAfter('9', null), /429/);
    assert.equal(calls.length, 1);
  });

  it('pauses a route whose bucket is empty before the next call', async () => {
    slept.length = 0;
    const client = createDiscordClient(
      ENV,
      fakeFetch([
        [
          'GET /api/v10/channels/9/messages/11/reactions/%E2%9C%85',
          () => new Response('[]', {status: 200, headers: {'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset-After': '0.25'}}),
        ],
        ['GET /api/v10/channels/9/messages/12/reactions/%E2%9C%85', () => []],
      ]),
      noSleep,
    );
    await client.reactors('9', '11', '✅');
    await client.reactors('9', '12', '✅');
    assert.deepEqual(slept, [250]);
  });

  it('groups routes by channel, folding message ids and emoji', () => {
    assert.equal(rateRoute('GET', '/channels/9/messages/11/reactions/%E2%9C%85?limit=25'), 'GET /channels/9/messages/:id/reactions/:emoji');
    assert.equal(rateRoute('POST', '/channels/9/messages'), 'POST /channels/9/messages');
    assert.equal(rateRoute('GET', '/guilds/7/members?limit=100'), 'GET /guilds/7/members');
  });
});

describe('text helpers', () => {
  it('chunks on line breaks under the limit', () => {
    const text = Array.from({length: 50}, (_, i) => `row ${i} ${'x'.repeat(60)}`).join('\n');
    const chunks = chunkMessage(text, 1000);
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((c) => c.length <= 1000));
    assert.equal(chunks.join('\n'), text);
  });

  it('cleans control characters but keeps newlines and tabs', () => {
    assert.equal(cleanText('a\u0000b\tc\nd⁦e'), 'ab\tc\nde');
    assert.equal(sanitizeFilename(''), 'file');
  });

  it('escapes markdown, mentions and emoji codes in customer words', () => {
    assert.equal(escapeDiscord('**Jan** @everyone <@&1>'), '\\*\\*Jan\\*\\* \\@everyone \\<\\@&1\\>');
    assert.equal(escapeDiscord('[x](y) :smile:'), '\\[x\\]\\(y\\) \\:smile\\:');
  });

  it('shows the real target of a masked link', () => {
    assert.equal(neutralizeLinks('pay [here](https://evil.example/p) now'), 'pay here (https://evil.example/p) now');
    assert.equal(neutralizeLinks('no links [just brackets]'), 'no links [just brackets]');
    assert.equal(neutralizeLinks('[bank](https://evil.example/p "Your bank")'), 'bank (https://evil.example/p)');
    assert.equal(neutralizeLinks("[bank](https://evil.example/p 'Your bank')"), 'bank (https://evil.example/p)');
    assert.equal(neutralizeLinks('[bank](<https://evil.example/a b>)'), 'bank (https://evil.example/a b)');
  });

  it('escapes every bracket in a customer body, so no link markdown survives', () => {
    assert.equal(customerBody('[x](<https://e.example/a b> "t")'), 'x \\(https://e.example/a b\\)');
    assert.equal(customerBody('[a [b]](https://e.example)'), '\\[a \\[b\\]\\]\\(https://e.example\\)');
    assert.doesNotMatch(customerBody('[[x]](y)'), /(?<!\\)[[\]()]/);
  });

  it('builds thread names without markup', () => {
    assert.equal(threadName('OD-AAAA order **Jan** <@1>'), 'OD-AAAA order Jan 1');
  });

  it('keeps the extension when shortening a long file name', () => {
    const name = sanitizeFilename(`${'é'.repeat(140)}.jpg`);
    assert.ok(name.endsWith('.jpg'));
    assert.equal(Array.from(name).length, 100);
  });

  it('orders snowflakes numerically', () => {
    assert.ok(compareSnowflakes('99', '100') < 0);
  });
});

describe('moderation gate', () => {
  it('defaults to log without a role and enforce with one', () => {
    assert.equal(resolveMode({}), 'log');
    assert.equal(resolveMode({SUPPORT_MOD_ROLE_ID: 'r'}), 'enforce');
    assert.equal(resolveMode({SUPPORT_MOD_ROLE_ID: 'r', SUPPORT_MODERATION_MODE: 'off'}), 'off');
  });

  it('approves only on a moderator reaction in enforce mode', async () => {
    _resetModCache();
    const d = fakeDiscord();
    d.setRoleMembers(['mod']);
    const env = {DISCORD_GUILD_ID: 'g', SUPPORT_MOD_ROLE_ID: 'r'};
    const thread = await d.client.createThread({name: 't', card: 'c'});
    const m = d.staff(thread, 'reply');
    assert.equal((await decide(env, d.client, thread, m)).approved, false);
    d.approve(m, 'rando');
    assert.equal((await decide(env, d.client, thread, m)).approved, false);
    d.approve(m, 'mod');
    assert.equal((await decide(env, d.client, thread, m)).approved, true);
  });

  it('looks up reactors once per reaction count, and never for the bot alone (finding b)', async () => {
    _resetModCache();
    const d = fakeDiscord();
    d.setRoleMembers(['mod']);
    const env = {DISCORD_GUILD_ID: 'g', SUPPORT_MOD_ROLE_ID: 'r'};
    const thread = await d.client.createThread({name: 't', card: 'c'});
    const m = d.staff(thread, 'reply');
    m.reactions.push({emoji: '✅', count: 1, me: true});
    assert.equal((await decide(env, d.client, thread, m)).approved, false);
    assert.equal(d.lookups.reactors, 0, 'only the bot reacted');
    d.approve(m, 'rando');
    await decide(env, d.client, thread, m);
    await decide(env, d.client, thread, m);
    await decide(env, d.client, thread, m);
    assert.equal(d.lookups.reactors, 1, 'same count: cached');
    d.approve(m, 'mod');
    assert.equal((await decide(env, d.client, thread, m)).approved, true);
    assert.equal((await decide(env, d.client, thread, m)).approved, true);
    assert.equal(d.lookups.reactors, 2);
  });

  it('log mode delivers what enforce would hold', async () => {
    const d = fakeDiscord();
    const thread = await d.client.createThread({name: 't', card: 'c'});
    const m = d.staff(thread, 'reply');
    assert.equal((await decide({SUPPORT_MODERATION_MODE: 'log'}, d.client, thread, m)).approved, true);
  });

  it('parks the cursor before the first held message', () => {
    const ms = [{id: '1'}, {id: '2'}, {id: '3'}];
    assert.equal(cursorAfter(ms, new Set(), '0'), '3');
    assert.equal(cursorAfter(ms, new Set(['2']), '0'), '1');
    assert.equal(cursorAfter(ms, new Set(['1']), '0'), '0');
    assert.equal(cursorAfter([], new Set(), '0'), '0');
  });
});
