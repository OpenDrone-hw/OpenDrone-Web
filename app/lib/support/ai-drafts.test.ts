import assert from 'node:assert/strict';
import {afterEach, beforeEach, describe, it} from 'node:test';
import {APPROVED_SUFFIX, _resetDraftCache, createDraftStore, draftPost, redactTicketText, type DraftStore} from './ai-drafts.ts';
import {createChatFpvClient, type ChatFpvEnv} from './chatfpv.ts';
import type {DraftResponse} from './chatfpv-contract.ts';
import type {DiscordMessage} from './discord.ts';
import {_resetModCache} from './moderation.ts';
import {supportDeps} from './server.ts';
import {createStore} from './store.ts';
import {fakeChatFpv, fakeDiscord, fakeShopify, testD1} from './testing.ts';
import {
  addCustomerReply,
  closeTicket,
  createTicket,
  runScheduled,
  syncTicket,
  type Deps,
  type NewTicketInput,
  type SupportEnv,
} from './tickets.ts';

const probe = await testD1();
const skip = probe ? false : 'node:sqlite unavailable';

const CHATFPV: ChatFpvEnv = {
  CHATFPV_URL: 'https://chatfpv.test',
  CHATFPV_KEY: 'store-key',
  CHATFPV_DRAFTS_ENABLED: '1',
};

const ENV: SupportEnv = {
  DISCORD_BOT_TOKEN: 'bot',
  DISCORD_SUPPORT_CHANNEL_ID: '42',
  DISCORD_GUILD_ID: '7',
  SUPPORT_MOD_ROLE_ID: '99',
  SUPPORT_MODERATION_MODE: 'off',
  SUPPORT_SESSION_SECRET: 'test-secret',
};

let clock = Date.parse('2026-09-01T09:00:00Z');

type Server = {
  calls: Array<{path: string; key: string | null; body: Record<string, unknown>}>;
  draftStatus: number;
  outcomeStatus: number;
  hang: boolean;
  next: (n: number) => DraftResponse;
};

/** ChatFPV over HTTP, for the real client: records every request body. */
function chatfpvServer(over: Partial<Server> = {}) {
  const server: Server = {
    calls: [],
    draftStatus: 200,
    outcomeStatus: 200,
    hang: false,
    next: (n) => ({
      draftId: `dr_${n}`,
      draft: 'Flash the latest firmware, then recalibrate the gyro [1].',
      citations: [{n: 1, title: 'Flashing', url: 'https://docs.opendrone.be/flash', source: 'OpenDrone docs', kind: 'doc'}],
      confidence: 0.82,
      note: 'grounded in the OpenDrone docs',
    }),
    ...over,
  };
  let drafts = 0;
  const fetcher = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    server.calls.push({path, key: new Headers(init.headers).get('X-ChatFPV-Key'), body: JSON.parse(String(init.body)) as Record<string, unknown>});
    if (server.hang) {
      return new Promise((_, reject) =>
        init.signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'}))),
      );
    }
    if (path === '/v1/draft') {
      if (server.draftStatus !== 200) return new Response('{"error":"x"}', {status: server.draftStatus});
      return Response.json(server.next(++drafts));
    }
    if (path === '/v1/draft/outcome') return new Response(server.outcomeStatus === 200 ? '{"ok":true}' : 'no', {status: server.outcomeStatus});
    return new Response('not found', {status: 404});
  }) as unknown as typeof fetch;
  return {server, fetcher};
}

async function setup(opts: {env?: Partial<SupportEnv>; server?: Partial<Server>} = {}) {
  const db = (await testD1())!;
  const discord = fakeDiscord({now: () => clock});
  const shopify = fakeShopify({});
  const {server, fetcher} = chatfpvServer(opts.server);
  const drafts = createDraftStore(db);
  const deps: Deps = {
    env: {...ENV, ...opts.env},
    store: createStore(db),
    discord: discord.client,
    fetcher: shopify.fetcher,
    now: () => clock,
    origin: 'https://opendrone.test',
    chatfpv: {client: createChatFpvClient(CHATFPV, fetcher, {timeoutMs: 30}), drafts},
  };
  discord.setRoleMembers(['mod1']);
  return {deps, discord, server, drafts, db};
}

function input(over: Partial<NewTicketInput> = {}): NewTicketInput {
  return {
    topic: 'product',
    name: 'Jan Peeters',
    email: 'jan@example.com',
    orderNumber: '#1042',
    product: 'OpenFC F4',
    firmware: 'Betaflight 4.5',
    message: 'Hi, Jan Peeters here (jan@example.com, +32 470 12 34 56), order #1042. My OpenFC F4 gyro drifts after flashing.',
    ...over,
  };
}

function messageOf(discord: ReturnType<typeof fakeDiscord>, threadId: string, id: string): DiscordMessage {
  return discord.threads.get(threadId)!.messages.find((m) => m.id === id)!;
}

async function onlyDraft(drafts: DraftStore, ref: string) {
  const pending = await drafts.pending(ref);
  assert.equal(pending.length, 1);
  return pending[0]!;
}

async function customerView(deps: Deps, ref: string) {
  return (await deps.store.messages(ref)).filter((m) => m.role === 'staff');
}

beforeEach(() => {
  clock = Date.parse('2026-09-01T09:00:00Z');
  _resetModCache();
  _resetDraftCache();
});

describe('draft requests', {skip}, () => {
  it('never send the customer email, name, phone or order number', async () => {
    const {deps, server} = await setup();
    const ticket = await createTicket(deps, input());
    const call = server.calls.find((c) => c.path === '/v1/draft')!;
    assert.ok(call, 'a draft was requested');
    assert.equal(call.key, 'store-key');
    const sent = JSON.stringify(call.body);
    for (const secret of ['jan@example.com', 'Jan', 'Peeters', '1042', '470', '12 34 56']) {
      assert.ok(!sent.includes(secret), `request leaks ${secret}: ${sent}`);
    }
    assert.equal(call.body.ticketRef, ticket.ref);
    assert.equal(call.body.topic, 'product');
    assert.equal(call.body.product, 'OpenFC F4');
    assert.equal(call.body.firmware, 'Betaflight 4.5');
    assert.deepEqual(Object.keys(call.body).sort(), ['conversation', 'firmware', 'product', 'ticketRef', 'topic']);
    assert.match(sent, /gyro drifts after flashing/);
  });

  it('are made only for product and other tickets', async () => {
    const {deps, server} = await setup();
    await createTicket(deps, input({topic: 'order', product: null}));
    await createTicket(deps, input({topic: 'warranty'}));
    assert.equal(server.calls.length, 0);
    await createTicket(deps, input({topic: 'other', product: null}));
    assert.equal(server.calls.length, 1);
  });

  it('redacts order references and every name part, with or without accents', () => {
    const t = {name: 'Élodie van Dam', email: 'e@x.be', orderNumber: '#1042'};
    assert.equal(redactTicketText('élodie: order 1042 and #1099, mail E@X.be', t), '[name]: order [order] and [order], mail [email]');
  });
});

describe('draft post', {skip}, () => {
  it('is one bot message under 1990 characters, marked as an AI draft', async () => {
    const {deps, discord, drafts} = await setup();
    const ticket = await createTicket(deps, input());
    const draft = await onlyDraft(drafts, ticket.ref);
    const post = messageOf(discord, ticket.threadId, draft.discordMessageId!);
    assert.equal(post.author.bot, true);
    assert.ok(post.content.length < 1990);
    assert.match(post.content, /^\*\*AI draft by ChatFPV, not sent to the customer\.\*\* React with ✅ to send it, or reply normally to send your own\./);
    assert.match(post.content, /recalibrate the gyro \[1\]/);
    assert.match(post.content, /\[1\] Flashing <https:\/\/docs\.opendrone\.be\/flash>/);
    assert.match(post.content, /confidence 82%/);
    // Nothing reached the customer.
    assert.equal((await customerView(deps, ticket.ref)).length, 0);
  });

  it('drops sources before it would cut the body, and offers no draft that does not fit', () => {
    const many = Array.from({length: 40}, (_, i) => ({n: i + 1, title: `Source ${i + 1}`, url: `https://docs.opendrone.be/${i}`, source: 's', kind: 'doc' as const}));
    const post = draftPost('✅', {draft: 'x'.repeat(1500), citations: many, note: 'n', confidence: 0.5})!;
    assert.ok(post.length < 1990);
    assert.ok(post.includes('x'.repeat(1500)));
    assert.equal(draftPost('✅', {draft: 'x'.repeat(1980), citations: [], note: '', confidence: 0.5}), null);
  });

  it('a null draft posts at most the one-line note', async () => {
    const {deps, discord, drafts} = await setup({
      server: {next: (n) => ({draftId: `dr_${n}`, draft: null, citations: [], confidence: 0, note: 'refund question: hand off'})},
    });
    const ticket = await createTicket(deps, input());
    const posts = discord.threads.get(ticket.threadId)!.messages.filter((m) => /ChatFPV/.test(m.content));
    assert.equal(posts.length, 1);
    assert.equal(posts[0]!.content.split('\n').length, 1);
    assert.equal((await drafts.pending(ticket.ref)).length, 0);
  });
});

describe('approval', {skip}, () => {
  for (const mode of ['enforce', 'log', 'off']) {
    it(`needs a support-role reaction in ${mode} mode; another reaction relays nothing`, async () => {
      const {deps, discord, drafts, server} = await setup({env: {SUPPORT_MODERATION_MODE: mode}});
      const ticket = await createTicket(deps, input());
      const draft = await onlyDraft(drafts, ticket.ref);
      const post = messageOf(discord, ticket.threadId, draft.discordMessageId!);

      discord.approve(post, 'stranger');
      clock += 10_000;
      await syncTicket(deps, (await deps.store.getTicket(ticket.ref))!, {force: true});
      assert.equal((await customerView(deps, ticket.ref)).length, 0, 'a non-holder reaction relays nothing');
      assert.equal((await drafts.pending(ticket.ref)).length, 1);

      // What the thread shows is not what is sent: the stored body is.
      discord.edit(ticket.threadId, post.id, 'tampered text');
      discord.approve(post, 'mod1');
      clock += 10_000;
      const {ticket: after} = await syncTicket(deps, (await deps.store.getTicket(ticket.ref))!, {force: true});
      const sent = await customerView(deps, ticket.ref);
      assert.equal(sent.length, 1);
      assert.equal(sent[0]!.author, 'OpenDrone');
      assert.match(sent[0]!.body, /^Flash the latest firmware, then recalibrate the gyro \[1\]\./);
      assert.ok(sent[0]!.body.includes(APPROVED_SUFFIX));
      assert.match(sent[0]!.body, /\[1\] Flashing: https:\/\/docs\.opendrone\.be\/flash/);
      assert.ok(!sent[0]!.body.includes('tampered'));
      assert.equal(after.status, 'answered');

      const outcome = server.calls.filter((c) => c.path === '/v1/draft/outcome');
      assert.deepEqual(outcome.map((c) => c.body), [{draftId: 'dr_1', status: 'approved', decidedBy: 'mod1'}]);
      assert.equal((await drafts.get('dr_1'))!.outcomePosted, true);

      // Once only, whatever syncs follow.
      clock += 10_000;
      await syncTicket(deps, (await deps.store.getTicket(ticket.ref))!, {force: true});
      assert.equal((await customerView(deps, ticket.ref)).length, 1);
    });
  }

  it('never approves without SUPPORT_MOD_ROLE_ID', async () => {
    const {deps, discord, drafts} = await setup({env: {SUPPORT_MOD_ROLE_ID: undefined, SUPPORT_MODERATION_MODE: 'off'}});
    const ticket = await createTicket(deps, input());
    const draft = await onlyDraft(drafts, ticket.ref);
    discord.approve(messageOf(discord, ticket.threadId, draft.discordMessageId!), 'mod1');
    await syncTicket(deps, (await deps.store.getTicket(ticket.ref))!, {force: true});
    assert.equal((await customerView(deps, ticket.ref)).length, 0);
  });

  it('does not stall the moderation cursor on the draft post', async () => {
    const {deps, discord} = await setup({env: {SUPPORT_MODERATION_MODE: 'enforce'}});
    const ticket = await createTicket(deps, input());
    const reply = discord.staff(ticket.threadId, 'Try a lower gyro filter first.');
    discord.approve(reply, 'mod1');
    clock += 10_000;
    const {ticket: after} = await syncTicket(deps, (await deps.store.getTicket(ticket.ref))!, {force: true});
    assert.equal(after.cursor, reply.id);
    assert.deepEqual((await customerView(deps, ticket.ref)).map((m) => m.body), ['Try a lower gyro filter first.']);
  });

  it('rejects a draft whose post was deleted', async () => {
    const {deps, discord, drafts, server} = await setup();
    const ticket = await createTicket(deps, input());
    const draft = await onlyDraft(drafts, ticket.ref);
    discord.remove(ticket.threadId, draft.discordMessageId!);
    await syncTicket(deps, (await deps.store.getTicket(ticket.ref))!, {force: true});
    assert.equal((await drafts.get('dr_1'))!.status, 'rejected');
    assert.equal(server.calls.at(-1)!.body.status, 'rejected');
  });
});

describe('replaced, superseded, closed', {skip}, () => {
  it('a staff reply while a draft is pending posts replaced with the scrubbed delivered text', async () => {
    const {deps, discord, drafts, server} = await setup();
    const ticket = await createTicket(deps, input());
    await onlyDraft(drafts, ticket.ref);
    const reply = discord.staff(ticket.threadId, 'Reflash with 4.5.1 and mail returns@opendrone.be or me at jan.staff@gmail.com.', {
      id: 'staff7',
      username: 'eva',
      globalName: 'Eva',
    });
    clock += 10_000;
    await syncTicket(deps, (await deps.store.getTicket(ticket.ref))!, {force: true});
    const outcome = server.calls.filter((c) => c.path === '/v1/draft/outcome').map((c) => c.body);
    assert.deepEqual(outcome, [
      {
        draftId: 'dr_1',
        status: 'replaced',
        finalText: 'Reflash with 4.5.1 and mail returns@opendrone.be or me at [email redacted].',
        decidedBy: 'staff7',
      },
    ]);
    assert.equal((await drafts.get('dr_1'))!.status, 'replaced');
    assert.equal((await customerView(deps, ticket.ref)).length, 1);
    assert.ok(reply.id);
  });

  it('a customer follow-up supersedes the older draft (outcome rejected) and gets a new one', async () => {
    const {deps, drafts, server} = await setup();
    const ticket = await createTicket(deps, input());
    clock += 60_000;
    const r = await addCustomerReply(deps, ticket, 'Still drifting after the recalibration.');
    assert.ok(r.ok);
    assert.equal((await drafts.get('dr_1'))!.status, 'superseded');
    assert.deepEqual(
      server.calls.filter((c) => c.path === '/v1/draft/outcome').map((c) => c.body),
      [{draftId: 'dr_1', status: 'rejected', decidedBy: 'system'}],
    );
    const pending = await onlyDraft(drafts, ticket.ref);
    assert.equal(pending.draftId, 'dr_2');
    const second = server.calls.filter((c) => c.path === '/v1/draft')[1]!.body as {conversation: Array<{role: string; text: string}>};
    assert.equal(second.conversation.at(-1)!.text, 'Still drifting after the recalibration.');
  });

  it('closing the ticket rejects the pending draft: by command, and by the customer', async () => {
    const {deps, discord, drafts, server} = await setup();
    const ticket = await createTicket(deps, input());
    discord.staff(ticket.threadId, '!close', {id: 'staff7', username: 'eva', globalName: 'Eva'});
    clock += 10_000;
    await syncTicket(deps, (await deps.store.getTicket(ticket.ref))!, {force: true});
    assert.equal((await drafts.get('dr_1'))!.status, 'rejected');
    assert.deepEqual(server.calls.at(-1)!.body, {draftId: 'dr_1', status: 'rejected', decidedBy: 'staff7'});

    const other = await createTicket(deps, input());
    const closed = await closeTicket(deps, other, 'you');
    const draft = await onlyDraft(drafts, other.ref);
    // An approve reaction after the close sends nothing; the next sync rejects it.
    discord.approve(messageOf(discord, other.threadId, draft.discordMessageId!), 'mod1');
    clock += 10_000;
    await syncTicket(deps, closed, {force: true});
    assert.equal((await customerView(deps, other.ref)).length, 0);
    assert.equal((await drafts.get(draft.draftId))!.status, 'rejected');
  });
});

describe('ChatFPV failures', {skip}, () => {
  for (const [label, server] of [
    ['a 5xx', {draftStatus: 503, outcomeStatus: 503}],
    ['a timeout', {hang: true}],
  ] as const) {
    it(`${label} never breaks ticket creation, replies or sync`, async () => {
      const {deps, discord} = await setup({server});
      const ticket = await createTicket(deps, input());
      assert.equal(ticket.status, 'open');
      const r = await addCustomerReply(deps, ticket, 'Any news?');
      assert.ok(r.ok);
      discord.staff(ticket.threadId, 'Looking into it.');
      clock += 10_000;
      const {added} = await syncTicket(deps, (await deps.store.getTicket(ticket.ref))!, {force: true});
      assert.equal(added, 1);
      // No draft post reached the thread.
      assert.ok(!discord.threads.get(ticket.threadId)!.messages.some((m) => /AI draft/.test(m.content)));
    });
  }

  it('an outcome ChatFPV did not take is retried by the cron', async () => {
    const {deps, discord, drafts, server} = await setup();
    const ticket = await createTicket(deps, input());
    const draft = await onlyDraft(drafts, ticket.ref);
    server.outcomeStatus = 500;
    discord.approve(messageOf(discord, ticket.threadId, draft.discordMessageId!), 'mod1');
    clock += 10_000;
    await syncTicket(deps, (await deps.store.getTicket(ticket.ref))!);
    assert.equal((await customerView(deps, ticket.ref)).length, 1, 'the customer still gets the approved reply');
    assert.equal((await drafts.get('dr_1'))!.outcomePosted, false);

    server.outcomeStatus = 200;
    clock += 5 * 60_000;
    await runScheduled(deps);
    assert.equal((await drafts.get('dr_1'))!.outcomePosted, true);
    const posted = server.calls.filter((c) => c.path === '/v1/draft/outcome');
    assert.equal(posted.length, 2);
    assert.deepEqual(posted[1]!.body, {draftId: 'dr_1', status: 'approved', decidedBy: 'mod1'});
  });
});

describe('flags off', {skip}, () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('wires no ChatFPV client and makes no ChatFPV call', async () => {
    const db = (await testD1())!;
    const seen: string[] = [];
    globalThis.fetch = (async (url: string) => {
      seen.push(String(url));
      return new Response('{}', {status: 200});
    }) as unknown as typeof fetch;
    const env = {...ENV, ...CHATFPV, CHATFPV_DRAFTS_ENABLED: '0', SUPPORT_DB: db};
    const deps = supportDeps(env, 'https://opendrone.test');
    assert.equal(deps.chatfpv, undefined);
    assert.ok(supportDeps({...env, CHATFPV_DRAFTS_ENABLED: '1'}, 'https://opendrone.test').chatfpv);
    assert.equal(supportDeps({...env, CHATFPV_DRAFTS_ENABLED: '1', CHATFPV_KEY: undefined}, 'https://opendrone.test').chatfpv, undefined);

    const discord = fakeDiscord({now: () => clock});
    const off: Deps = {...deps, discord: discord.client, fetcher: fakeShopify({}).fetcher, now: () => clock};
    const ticket = await createTicket(off, input());
    await addCustomerReply(off, ticket, 'More detail.');
    await syncTicket(off, (await off.store.getTicket(ticket.ref))!, {force: true});
    await runScheduled(off);
    assert.deepEqual(seen.filter((u) => u.includes('chatfpv')), []);
    assert.ok(!discord.threads.get(ticket.threadId)!.messages.some((m) => /ChatFPV/.test(m.content)));
  });

  it('the fake client records calls for route tests', async () => {
    const fake = fakeChatFpv();
    assert.ok(await fake.client.draft({ticketRef: 'X', topic: 'product', conversation: [{role: 'customer', text: 'hi'}]}));
    fake.state.failOutcome = true;
    assert.equal(await fake.client.outcome({draftId: 'd', status: 'rejected', decidedBy: 'system'}), null);
    assert.equal(fake.outcomes.length, 1);
  });
});
