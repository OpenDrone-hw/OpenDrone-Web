import assert from 'node:assert/strict';
import {afterEach, beforeEach, describe, it} from 'node:test';
import {APPROVED_SUFFIX, STAFF_NOTE_LABEL, _resetDraftCache, createDraftStore, draftPost, redactTicketText, requestDraft, type DraftStore} from './ai-drafts.ts';
import {createChatFpvClient, type ChatFpvEnv} from './chatfpv.ts';
import type {DraftResponse} from './chatfpv-contract.ts';
import type {DiscordMessage} from './discord.ts';
import {_resetModCache} from './moderation.ts';
import {supportDeps} from './server.ts';
import {createStore} from './store.ts';
import {fakeChatFpv, fakeDiscord, fakeShopify, testD1, type ShopifyScript} from './testing.ts';
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

async function setup(opts: {env?: Partial<SupportEnv>; server?: Partial<Server>; shopify?: ShopifyScript} = {}) {
  const db = (await testD1())!;
  const discord = fakeDiscord({now: () => clock});
  const shopify = fakeShopify(opts.shopify ?? {});
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
  return {deps, discord, server, drafts, db, shopify};
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

  it('are made for every topic, so warranty and order tickets can get a staff note', async () => {
    const {deps, server} = await setup();
    await createTicket(deps, input({topic: 'order', product: null}));
    await createTicket(deps, input({topic: 'warranty'}));
    await createTicket(deps, input({topic: 'other', product: null}));
    assert.deepEqual(server.calls.map((c) => c.body.topic), ['order', 'warranty', 'other']);
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

  it('lists a source once when the draft already carries its own Sources block', async () => {
    const body = 'Recalibrate the gyro [1].\n\nSources:\n[1] Flashing: https://docs.opendrone.be/flash';
    const post = draftPost('✅', {
      draft: body,
      citations: [{n: 1, title: 'Flashing', url: 'https://docs.opendrone.be/flash', source: 'OpenDrone docs', kind: 'doc'}],
      note: '',
      confidence: 0.5,
    })!;
    assert.equal(post.split('https://docs.opendrone.be/flash').length - 1, 1);
    const {approvedText} = await import('./ai-drafts.ts');
    const text = approvedText({body, citations: [{n: 1, title: 'Flashing', url: 'https://docs.opendrone.be/flash', source: 'x', kind: 'doc'}]});
    assert.equal(text.split('https://docs.opendrone.be/flash').length - 1, 1);
    assert.equal(text.split('Sources:').length - 1, 1);
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

  it('a support-role reaction that replaced another reaction still approves', async () => {
    const {deps, discord, drafts} = await setup({env: {SUPPORT_MODERATION_MODE: 'enforce'}});
    const ticket = await createTicket(deps, input());
    const draft = await onlyDraft(drafts, ticket.ref);
    const post = messageOf(discord, ticket.threadId, draft.discordMessageId!);
    discord.approve(post, 'stranger');
    clock += 10_000;
    await syncTicket(deps, (await deps.store.getTicket(ticket.ref))!, {force: true});
    assert.equal((await customerView(deps, ticket.ref)).length, 0);
    // The stranger's reaction goes, a moderator's comes: the count stays 1.
    discord.approve(post, 'mod1');
    post.reactions.find((r) => r.emoji === '✅')!.count = 1;
    const realNow = Date.now;
    Date.now = () => realNow() + 10 * 60_000;
    try {
      clock += 10_000;
      await syncTicket(deps, (await deps.store.getTicket(ticket.ref))!, {force: true});
    } finally {
      Date.now = realNow;
    }
    assert.equal((await customerView(deps, ticket.ref)).length, 1);
  });

  for (const mode of ['enforce', 'log', 'off']) {
    it(`a bot-only approve reaction never sends the draft (${mode} mode)`, async () => {
      const {deps, discord, drafts, server} = await setup({env: {SUPPORT_MODERATION_MODE: mode}});
      // The support bot and another bot both hold the support role.
      discord.setRoleMembers(['mod1', 'bot', 'otherbot']);
      const ticket = await createTicket(deps, input());
      const draft = await onlyDraft(drafts, ticket.ref);
      const post = messageOf(discord, ticket.threadId, draft.discordMessageId!);

      discord.approve(post, 'bot', '✅', {self: true});
      clock += 10_000;
      await syncTicket(deps, (await deps.store.getTicket(ticket.ref))!, {force: true});
      assert.equal(discord.lookups.reactors, 0, "the bot's own reaction needs no lookup");
      assert.equal((await customerView(deps, ticket.ref)).length, 0);

      discord.approve(post, 'otherbot', '✅', {bot: true});
      clock += 10_000;
      await syncTicket(deps, (await deps.store.getTicket(ticket.ref))!, {force: true});
      assert.equal((await customerView(deps, ticket.ref)).length, 0, 'a bot holding the support role approves nothing');
      assert.equal((await drafts.pending(ticket.ref)).length, 1);
      assert.ok(!server.calls.some((c) => c.path === '/v1/draft/outcome'));
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
  it('a support-role reply while a draft is pending posts replaced with the delivered text, customer identity redacted', async () => {
    const {deps, discord, drafts, server} = await setup();
    const ticket = await createTicket(deps, input());
    await onlyDraft(drafts, ticket.ref);
    const reply = discord.staff(ticket.threadId, 'Hi Jan, for order #1042: reflash with 4.5.1 and mail returns@opendrone.be or me at eva.staff@gmail.com.', {
      id: 'mod1',
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
        finalText: 'Hi [name], for order [order]: reflash with 4.5.1 and mail returns@opendrone.be or me at [email redacted].',
        decidedBy: 'mod1',
      },
    ]);
    assert.equal((await drafts.get('dr_1'))!.status, 'replaced');
    // The customer still gets the reply itself, name and order included.
    const sent = await customerView(deps, ticket.ref);
    assert.equal(sent.length, 1);
    assert.match(sent[0]!.body, /^Hi Jan, for order #1042/);
    assert.ok(reply.id);
  });

  for (const mode of ['log', 'off']) {
    it(`a reply by someone without the support role is never a correction (${mode} mode)`, async () => {
      const {deps, discord, drafts, server} = await setup({env: {SUPPORT_MODERATION_MODE: mode}});
      const ticket = await createTicket(deps, input());
      await onlyDraft(drafts, ticket.ref);
      discord.staff(ticket.threadId, 'The gyro on the OpenFC F4 is an ICM-42688-P.', {id: 'staff7', username: 'eva', globalName: 'Eva'});
      clock += 10_000;
      await syncTicket(deps, (await deps.store.getTicket(ticket.ref))!, {force: true});
      assert.equal((await customerView(deps, ticket.ref)).length, 1, 'the mode still relays the reply');
      assert.deepEqual(
        server.calls.filter((c) => c.path === '/v1/draft/outcome').map((c) => c.body),
        [{draftId: 'dr_1', status: 'rejected', decidedBy: 'staff7'}],
      );
      assert.equal((await drafts.get('dr_1'))!.status, 'rejected');
    });
  }

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

  it('an outcome ChatFPV refuses for good (409, 404, 400) is not retried', async () => {
    for (const status of [409, 404, 400]) {
      _resetDraftCache();
      const {deps, discord, drafts, server} = await setup();
      server.outcomeStatus = status;
      const ticket = await createTicket(deps, input());
      const draft = await onlyDraft(drafts, ticket.ref);
      discord.approve(messageOf(discord, ticket.threadId, draft.discordMessageId!), 'mod1');
      clock += 10_000;
      await syncTicket(deps, (await deps.store.getTicket(ticket.ref))!);
      assert.equal((await drafts.get(draft.draftId))!.outcomePosted, true, `status ${status}`);
      clock += 5 * 60_000;
      await runScheduled(deps);
      assert.equal(server.calls.filter((c) => c.path === '/v1/draft/outcome').length, 1, `status ${status}`);
    }
  });

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

// --------------------------------------------------------------------------
// Order-aware drafts and the staff-only note
// --------------------------------------------------------------------------

const SHOP_ENV: Partial<SupportEnv> = {SHOPIFY_STORE_DOMAIN: 'opendrone-test.myshopify.com', SHOPIFY_ADMIN_API_TOKEN: 'shpat_test'};

const SHOP_ORDER = {
  name: '#1042',
  email: 'jan@example.com',
  createdAt: '2026-08-02T10:00:00Z',
  cancelledAt: null,
  displayFinancialStatus: 'PAID',
  displayFulfillmentStatus: 'UNFULFILLED',
  tags: ['preorder', 'batch:OD-FC-F4:2'],
  shippingAddress: {countryCodeV2: 'NO'},
  totalPriceSet: {shopMoney: {amount: '189.00', currencyCode: 'EUR'}},
  lineItems: {nodes: [{sku: 'OD-FC-F4', title: 'OpenFC F4', quantity: 2, customAttributes: [{key: 'Preorder', value: 'ships by 31 March 2027'}]}]},
  fulfillments: [{trackingInfo: [{company: 'DHL', url: 'https://dhl.example/t/1'}, {company: 'GLS', url: 'http://insecure.example/t'}]}],
  // Fields the storefront must never forward even if Shopify returned them.
  billingAddress: {address1: '1 Secret Street'},
  phone: '+32 470 12 34 56',
  customer: {id: 'gid://shopify/Customer/1', firstName: 'Jan'},
};
const SHOP: ShopifyScript = {
  customers: [{id: 'gid://shopify/Customer/1', email: 'jan@example.com', numberOfOrders: 1, orders: []}],
  orders: [SHOP_ORDER],
  holds: {'#1042': [{status: 'ON_HOLD', fulfillmentHolds: [{handle: 'opendrone-preorder', reason: 'OTHER', reasonNotes: 'internal staff text'}]}]},
};

describe('order facts in the draft request', {skip}, () => {
  it('a verified order is read and sent without address, phone, email, name or payment details', async () => {
    const {deps, server} = await setup({env: SHOP_ENV, shopify: SHOP});
    const ticket = await createTicket(deps, input({topic: 'order', product: null, message: 'When will my order #1042 ship to Norway?'}));
    assert.equal(ticket.orderVerified, true);
    const call = server.calls.find((c) => c.path === '/v1/draft')!;
    assert.deepEqual(call.body.order, {
      name: '#1042',
      createdAt: '2026-08-02T10:00:00Z',
      lineItems: [{title: 'OpenFC F4', quantity: 2, preorderBatch: 'Batch 2', shipBy: 'ships by 31 March 2027'}],
      financialStatus: 'paid',
      fulfillmentStatus: 'unfulfilled',
      shippingCountry: 'NO',
      totalPrice: '189.00',
      currency: 'EUR',
      tracking: [{carrier: 'DHL', url: 'https://dhl.example/t/1'}, {carrier: 'GLS'}],
      holds: {preorderHold: true, reason: 'preorder batch not yet released'},
    });
    const sent = JSON.stringify(call.body);
    for (const secret of ['jan@example.com', 'Jan', 'Secret', '470', 'internal staff text', 'insecure']) {
      assert.ok(!sent.includes(secret), `request leaks ${secret}`);
    }
  });

  it('only reads order fields, never an address line, phone, customer name or payment gateway', async () => {
    const {deps, shopify} = await setup({env: SHOP_ENV, shopify: SHOP});
    await createTicket(deps, input({topic: 'order', product: null}));
    const q = shopify.queries.filter((x) => /DraftOrder/.test(x.query)).map((x) => x.query).join('\n');
    assert.ok(q.includes('countryCodeV2'));
    for (const banned of ['address1', 'phone', 'firstName', 'lastName', 'billingAddress', 'paymentGatewayNames', 'transactions', 'note', 'reasonNotes']) {
      assert.ok(!q.includes(banned), `query asks for ${banned}`);
    }
  });

  it('an unverified ticket never sends an order, and never queries the order facts', async () => {
    const wrong = {...SHOP, orders: [{...SHOP_ORDER, email: 'someone.else@example.com'}]};
    const {deps, server} = await setup({env: SHOP_ENV, shopify: wrong});
    const ticket = await createTicket(deps, input({topic: 'order', product: null}));
    assert.equal(ticket.orderVerified, false);
    assert.equal('order' in server.calls.find((c) => c.path === '/v1/draft')!.body, false);
    // Shopify unconfigured: same.
    const bare = await setup({shopify: SHOP});
    await createTicket(bare.deps, input({topic: 'order', product: null}));
    assert.equal('order' in bare.server.calls.find((c) => c.path === '/v1/draft')!.body, false);
  });

  it('a flagged-verified ticket is checked again against Shopify: another customer order is never sent', async () => {
    const {deps, server} = await setup({env: SHOP_ENV, shopify: SHOP});
    const ticket = await createTicket(deps, input({topic: 'order', product: null}));
    // The ticket email changes after creation (or the flag is stale): the order no longer belongs to it.
    const stale = {...ticket, email: 'other@example.com'};
    server.calls.length = 0;
    await requestDraft(deps, stale);
    assert.equal('order' in server.calls.find((c) => c.path === '/v1/draft')!.body, false);
  });

  it('a product ticket never sends an order, even a verified one', async () => {
    const {deps, server} = await setup({env: SHOP_ENV, shopify: SHOP});
    await createTicket(deps, input());
    assert.equal('order' in server.calls.find((c) => c.path === '/v1/draft')!.body, false);
  });

  it('failing hold lookup (token without the scope) only leaves holds out', async () => {
    const noHolds = {...SHOP, holds: undefined};
    const {deps, server} = await setup({env: SHOP_ENV, shopify: noHolds});
    await createTicket(deps, input({topic: 'order', product: null}));
    const order = server.calls.find((c) => c.path === '/v1/draft')!.body.order as Record<string, unknown>;
    assert.equal(order.name, '#1042');
    assert.equal('holds' in order, false);
  });
});

describe('needsHumanAction and the staff-only note', {skip}, () => {
  const flagged = (n: number): DraftResponse => ({
    draftId: `dr_${n}`,
    draft: 'Hi! A team member will confirm whether the address can still change.',
    citations: [],
    confidence: 0.6,
    note: 'Order draft from the verified order and 1 policy source.',
    needsHumanAction: true,
    humanActionReason: 'Address change: a team member confirms.',
    staffNote: 'Customer wants the address changed. Order is a Batch 2 preorder on hold. Check the address in Shopify. @everyone',
  });

  it('shows the human-action reason on the draft post and posts the staff note as a separate labelled message', async () => {
    const {deps, discord, drafts} = await setup({server: {next: flagged}});
    const ticket = await createTicket(deps, input({topic: 'order', product: null}));
    const posts = discord.threads.get(ticket.threadId)!.messages.filter((m) => m.author.bot && /ChatFPV|Staff only/.test(m.content));
    assert.equal(posts.length, 2);
    assert.match(posts[0]!.content, /^\*\*AI draft by ChatFPV/);
    assert.match(posts[0]!.content, /\*\*Needs a team member:\*\* Address change/);
    assert.ok(!posts[0]!.content.includes('Check the address in Shopify'), 'the note is not part of the draft post');
    assert.ok(posts[1]!.content.startsWith(STAFF_NOTE_LABEL));
    assert.match(posts[1]!.content, /Staff only, not sent to the customer/);
    assert.match(posts[1]!.content, /Check the address in Shopify/);
    assert.ok(!/(^|[^\\])@everyone/.test(posts[1]!.content), 'mentions are escaped');
    // Only the draft is a stored draft.
    const pending = await drafts.pending(ticket.ref);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.discordMessageId, posts[0]!.id);
    assert.ok(!pending[0]!.body.includes('Check the address'));
  });

  it('the approve reaction relays the draft body only; reacting on the staff note relays nothing, whoever reacts', async () => {
    const {deps, discord, drafts} = await setup({server: {next: flagged}});
    const ticket = await createTicket(deps, input({topic: 'order', product: null}));
    const thread = discord.threads.get(ticket.threadId)!;
    const note = thread.messages.find((m) => m.content.startsWith(STAFF_NOTE_LABEL))!;
    discord.approve(note, 'mod1');
    clock += 10_000;
    await syncTicket(deps, (await deps.store.getTicket(ticket.ref))!, {force: true});
    assert.equal((await customerView(deps, ticket.ref)).length, 0, 'a reaction on the note relays nothing');
    assert.equal((await drafts.pending(ticket.ref)).length, 1);

    const draft = await onlyDraft(drafts, ticket.ref);
    discord.approve(messageOf(discord, ticket.threadId, draft.discordMessageId!), 'mod1');
    clock += 10_000;
    await syncTicket(deps, (await deps.store.getTicket(ticket.ref))!, {force: true});
    const sent = await customerView(deps, ticket.ref);
    assert.equal(sent.length, 1);
    assert.ok(sent[0]!.body.startsWith('Hi! A team member will confirm'));
    for (const m of await deps.store.messages(ticket.ref)) {
      assert.ok(!m.body.includes('Check the address in Shopify'), 'the staff note never reaches the customer view');
      assert.ok(!m.body.includes('Staff only'), 'nor its label');
    }
  });

  it('a draft whose message is a staff note is rejected, never approved, even with a support-role reaction', async () => {
    const {deps, discord, drafts} = await setup({server: {next: flagged}});
    const ticket = await createTicket(deps, input({topic: 'order', product: null}));
    const note = discord.threads.get(ticket.threadId)!.messages.find((m) => m.content.startsWith(STAFF_NOTE_LABEL))!;
    // Forge the worst case: a draft row whose message id is the staff note.
    await drafts.insert({draftId: 'forged', ref: ticket.ref, discordMessageId: note.id, body: 'forged body', citations: [], createdAt: clock});
    discord.approve(note, 'mod1');
    clock += 10_000;
    await syncTicket(deps, (await deps.store.getTicket(ticket.ref))!, {force: true});
    assert.equal((await drafts.get('forged'))!.status, 'rejected');
    assert.ok(!(await deps.store.messages(ticket.ref)).some((m) => m.body.includes('forged body')));
  });

  it('a null draft with needsHumanAction posts the reason, and the staff note, and stores no draft', async () => {
    const {deps, discord, drafts} = await setup({
      server: {
        next: (n) => ({
          draftId: `dr_${n}`,
          draft: null,
          citations: [],
          confidence: 0,
          note: 'No draft: warranty needs staff; the bot never states store policy for it.',
          needsHumanAction: true,
          humanActionReason: 'warranty: a team member handles it.',
          staffNote: 'Customer reports a dead board.',
        }),
      },
    });
    const ticket = await createTicket(deps, input({topic: 'warranty'}));
    const posts = discord.threads.get(ticket.threadId)!.messages.filter((m) => m.author.bot && /ChatFPV|Staff only|Needs a team/.test(m.content));
    assert.equal(posts.length, 2);
    assert.match(posts[0]!.content, /no draft/);
    assert.match(posts[0]!.content, /Needs a team member:\*\* warranty/);
    assert.ok(posts[1]!.content.startsWith(STAFF_NOTE_LABEL));
    assert.equal((await drafts.pending(ticket.ref)).length, 0);
  });

  it('an approved order draft that names the order number reaches the customer through the scrubber', async () => {
    const {deps, discord, drafts} = await setup({
      server: {next: (n) => ({draftId: `dr_${n}`, draft: 'Hi! Your order #1042 is a preorder in Batch 2, shipping to NO. A team member will confirm any change.', citations: [], confidence: 0.6, note: 'Order draft.'})},
    });
    const ticket = await createTicket(deps, input({topic: 'order', product: null}));
    const draft = await onlyDraft(drafts, ticket.ref);
    discord.approve(messageOf(discord, ticket.threadId, draft.discordMessageId!), 'mod1');
    clock += 10_000;
    await syncTicket(deps, (await deps.store.getTicket(ticket.ref))!, {force: true});
    const sent = await customerView(deps, ticket.ref);
    assert.equal(sent.length, 1);
    assert.match(sent[0]!.body, /Your order #1042 is a preorder in Batch 2/);
  });

  it('a response without staffNote or needsHumanAction posts exactly as before', async () => {
    const {deps, discord} = await setup();
    const ticket = await createTicket(deps, input());
    const posts = discord.threads.get(ticket.threadId)!.messages.filter((m) => m.author.bot && /ChatFPV|Staff only/.test(m.content));
    assert.equal(posts.length, 1);
    assert.ok(!posts[0]!.content.includes('Needs a team member'));
  });

  it('the client keeps staffNote and the flag from the response and drops the rest', async () => {
    const {deps, server} = await setup({server: {next: (n) => ({...flagged(n), extra: 'x'} as DraftResponse)}});
    const res = await deps.chatfpv!.client.draft({ticketRef: 'T', topic: 'order', conversation: [{role: 'customer', text: 'hello there'}]});
    assert.equal(res?.needsHumanAction, true);
    assert.match(res?.staffNote ?? '', /Customer wants/);
    assert.ok(!('extra' in (res ?? {})));
    void server;
  });
});
