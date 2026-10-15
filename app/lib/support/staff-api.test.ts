import assert from 'node:assert/strict';
import {beforeEach, describe, it} from 'node:test';
import {createDraftStore} from './ai-drafts.ts';
import {STAFF_BASE, handleStaff} from './staff-api.ts';
import {createStore} from './store.ts';
import {addCustomerReply, cleanupExpired, createTicket, publicMessage, runScheduled, RETENTION_MS, type Deps, type NewTicketInput, type SupportEnv} from './tickets.ts';
import {fakeChatFpv, fakeDiscord, fakeR2, fakeShopify, testD1} from './testing.ts';

const skip = (await testD1()) ? false : 'node:sqlite unavailable';

const TOKEN = 'staff-token-1234567890';
const ENV: SupportEnv & {SUPPORT_STAFF_API_TOKEN: string} = {
  DISCORD_BOT_TOKEN: 'bot',
  DISCORD_SUPPORT_CHANNEL_ID: '42',
  DISCORD_GUILD_ID: '7',
  DISCORD_HELP_CHANNEL_ID: '99',
  SUPPORT_SESSION_SECRET: 'test-secret',
  SUPPORT_CRM_API: '1',
  SUPPORT_COMMUNITY_ROUTE: '1',
  SUPPORT_STAFF_API_TOKEN: TOKEN,
  SUPPORT_EMAIL_NOTIFY_ENABLED: '1',
  RESEND_API_KEY: 're_test',
  SUPPORT_FROM_EMAIL: 'OpenDrone <support@opendrone.test>',
  SHOPIFY_STORE_DOMAIN: 'opendrone-test.myshopify.com',
  SHOPIFY_ADMIN_API_TOKEN: 'shpat_test',
};

const JAN_ORDER = {
  name: '#1042',
  email: 'jan@example.com',
  customer: {id: 'gid://shopify/Customer/1'},
  createdAt: '2026-08-02T10:00:00Z',
  displayFinancialStatus: 'PAID',
  displayFulfillmentStatus: 'UNFULFILLED',
  tags: ['preorder', 'batch:OD-FC-F4:2'],
  lineItems: {nodes: [{sku: 'OD-FC-F4', title: 'OpenFC F4', quantity: 1}]},
};
const SCRIPT = {customers: [{id: 'gid://shopify/Customer/1', email: 'jan@example.com', numberOfOrders: 1, orders: [JAN_ORDER]}], orders: [JAN_ORDER]};

let clock = Date.parse('2026-10-12T09:00:00Z');

async function setup(env: Partial<typeof ENV> = {}) {
  const db = (await testD1())!;
  const discord = fakeDiscord({now: () => clock});
  const shopify = fakeShopify(SCRIPT);
  const r2 = fakeR2();
  const ai = fakeChatFpv({draft: (_r, n) => ({draftId: `dr_${n}`, draft: 'Recalibrate the gyro first.', citations: [], confidence: 0.8, note: '', route: 'team'})});
  const sent: Array<{to: string; body: string}> = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    if (String(url).includes('resend')) {
      sent.push({to: String(url), body: String(init.body)});
      return new Response('{}', {status: 200});
    }
    return shopify.fetcher(url, init);
  }) as unknown as typeof fetch;
  const merged = {...ENV, ...env};
  const deps: Deps = {
    env: merged,
    store: createStore(db),
    discord: discord.client,
    files: r2.bucket,
    chatfpv: {client: ai.client, drafts: createDraftStore(db)},
    fetcher,
    now: () => clock,
    origin: 'https://opendrone.test',
  };
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const isForm = body instanceof FormData;
    const res = await handleStaff(
      new Request(`https://opendrone.test${STAFF_BASE}${path}`, {
        method,
        headers: {Authorization: `Bearer ${TOKEN}`, 'X-Staff-Login': 'stan', ...(body && !isForm ? {'Content-Type': 'application/json'} : {}), ...headers},
        body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
      }),
      merged,
      {origin: 'https://opendrone.test', deps},
    );
    const type = res.headers.get('Content-Type') ?? '';
    return {status: res.status, json: type.includes('json') ? ((await res.json()) as any) : null, res};
  };
  return {deps, discord, r2, ai, sent, call};
}

const input = (over: Partial<NewTicketInput> = {}): NewTicketInput => ({
  topic: 'order',
  name: 'Jan Peeters',
  email: 'jan@example.com',
  orderNumber: '#1042',
  product: null,
  firmware: null,
  message: 'My preorder shows batch 2. When does it ship?',
  ...over,
});

beforeEach(() => {
  clock = Date.parse('2026-10-12T09:00:00Z');
});

describe('tickets with the CRM on', {skip}, () => {
  it('opens no Discord thread and keeps attachments in R2', async () => {
    const { deps, discord, r2 } = await setup({DISCORD_STAFF_METADATA_CHANNEL_ID: '55'});
    const file = {name: 'gyro log.png', type: 'image/png', data: new Uint8Array([137, 80, 78, 71])};
    const t = await createTicket(deps, input(), [file]);
    assert.equal(t.threadId, '');
    assert.equal(discord.threads.size, 0);
    assert.equal(discord.channelPosts.length, 0, 'no staff metadata post either');
    const [m] = await deps.store.messages(t.ref);
    assert.equal(m!.attachments.length, 1);
    assert.match(m!.attachments[0]!.id, /^r2_[a-f0-9]{20}$/);
    assert.deepEqual([...r2.objects.keys()], [`${t.ref}/${m!.attachments[0]!.id}`]);
    assert.equal(publicMessage(m!).attachments[0]!.href, `/api/support/tickets/${t.ref}/files/r2/${m!.attachments[0]!.id}`);
  });

  it('takes a customer reply without a thread and reopens', async () => {
    const { deps, discord } = await setup();
    let t = await createTicket(deps, input());
    t = (await deps.store.getTicket(t.ref))!;
    await deps.store.updateTicket(t.ref, {status: 'closed', closedAt: clock});
    const r = await addCustomerReply(deps, (await deps.store.getTicket(t.ref))!, 'Still the same problem here, thanks.');
    assert.ok(r.ok);
    assert.equal(r.ok && r.ticket.status, 'open');
    assert.equal(discord.threads.size, 0);
  });

  it('deletes the stored files with the ticket after 24 months', async () => {
    const { deps, r2 } = await setup();
    const t = await createTicket(deps, input(), [{name: 'a.png', type: 'image/png', data: new Uint8Array([1, 2, 3])}]);
    await deps.store.updateTicket(t.ref, {status: 'closed', closedAt: clock});
    clock += RETENTION_MS + 1000;
    assert.deepEqual(await cleanupExpired(deps), [t.ref]);
    assert.equal(r2.objects.size, 0);
    assert.equal(await deps.store.getTicket(t.ref), null);
  });

  it('cron: a ticket without a thread does not block the sync queue and still mails the customer', async () => {
    const { deps, call, sent } = await setup();
    const t = await createTicket(deps, input());
    clock += 60_000;
    await call('POST', `/tickets/${t.ref}/reply`, {body: 'Batch 2 ships in November.'});
    clock += 11 * 60_000;
    const report = await runScheduled(deps);
    assert.equal(report.synced, 1);
    assert.equal(report.notified, 1);
    assert.equal(sent.length, 1);
  });
});

describe('staff API access', {skip}, () => {
  it('is a 404 while SUPPORT_CRM_API is off', async () => {
    const { call } = await setup({SUPPORT_CRM_API: '0'});
    assert.equal((await call('GET', '/tickets')).status, 404);
  });

  it('refuses a missing or wrong token, and a write without a staff login', async () => {
    const { call } = await setup();
    assert.equal((await call('GET', '/tickets', undefined, {Authorization: ''})).status, 401);
    assert.equal((await call('GET', '/tickets', undefined, {Authorization: 'Bearer nope'})).status, 401);
    const noLogin = await call('PATCH', '/tickets/OD-XXXXXX', {priority: 'high'}, {'X-Staff-Login': ''});
    assert.equal(noLogin.status, 400);
    assert.equal(noLogin.json.error, 'staff_login_required');
    assert.equal((await call('GET', '/status')).json.communityRoute, true);
  });
});

describe('staff API tickets', {skip}, () => {
  it('lists and filters, newest activity first, with a cursor', async () => {
    const { deps, call } = await setup();
    const a = await createTicket(deps, input({topic: 'product', orderNumber: null, product: 'OpenFC F4', message: 'First question about tuning the filters.'}));
    clock += 60_000;
    const b = await createTicket(deps, input({email: 'eva@example.com', name: 'Eva', orderNumber: null, topic: 'other', message: 'Second general question about stock.'}));
    await call('PATCH', `/tickets/${a.ref}`, {assignee: 'stan', priority: 'high', tags: ['Tuning', 'tuning']});
    const all = await call('GET', '/tickets');
    assert.deepEqual(all.json.tickets.map((t: any) => t.ref), [b.ref, a.ref]);
    assert.deepEqual((await call('GET', '/tickets?assignee=stan')).json.tickets.map((t: any) => t.ref), [a.ref]);
    assert.deepEqual((await call('GET', '/tickets?assignee=none')).json.tickets.map((t: any) => t.ref), [b.ref]);
    assert.deepEqual((await call('GET', '/tickets?priority=high&tag=tuning')).json.tickets.map((t: any) => t.ref), [a.ref]);
    assert.deepEqual((await call('GET', '/tickets?topic=other&q=stock')).json.tickets.map((t: any) => t.ref), [b.ref]);
    assert.deepEqual((await call('GET', '/tickets?q=eva@example')).json.tickets.map((t: any) => t.ref), [b.ref]);
    assert.equal((await call('GET', '/tickets?route=community')).json.tickets.length, 0);
    const page = await call('GET', '/tickets?limit=1');
    assert.equal(page.json.tickets.length, 1);
    assert.ok(page.json.next);
    assert.equal((await call('GET', `/tickets?limit=1&before=${page.json.next}`)).json.tickets.length, 1);
    assert.equal((await call('GET', '/tickets?q=%25')).json.tickets.length, 0, 'LIKE wildcards are escaped');
  });

  it('shows the full conversation, notes, drafts and audit', async () => {
    const { deps, call } = await setup();
    const t = await createTicket(deps, input({topic: 'product', orderNumber: null, product: 'OpenFC F4', message: 'The gyro drifts after a power cycle. Help?'}));
    await call('POST', `/tickets/${t.ref}/notes`, {body: 'Looks like a calibration issue.'});
    const d = await call('GET', `/tickets/${t.ref}`);
    assert.equal(d.status, 200);
    assert.equal(d.json.ticket.email, 'jan@example.com');
    assert.deepEqual(d.json.messages.map((m: any) => m.role), ['customer']);
    assert.equal(d.json.notes[0].author, 'stan');
    assert.equal(d.json.drafts[0].draftId, 'dr_1');
    assert.ok(d.json.drafts[0].text.includes('drafted with AI'));
    assert.equal(d.json.audit[0].action, 'note');
    assert.equal((await call('GET', `/tickets/${t.ref}/draft`)).json.draft.draftId, 'dr_1');
    assert.equal((await call('GET', '/tickets/OD-ZZZZZZ')).status, 404);
  });

  it('changes status, assignee, priority and tags, and audits it', async () => {
    const { deps, call } = await setup();
    const t = await createTicket(deps, input());
    const r = await call('PATCH', `/tickets/${t.ref}`, {status: 'waiting', assignee: 'eva', priority: 'urgent', tags: ['preorder']});
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.ticket.status, r.json.ticket.assignee, r.json.ticket.priority, r.json.ticket.tags], ['waiting', 'eva', 'urgent', ['preorder']]);
    const closed = await call('PATCH', `/tickets/${t.ref}`, {status: 'closed'});
    assert.equal(closed.json.ticket.status, 'closed');
    const reopened = await call('PATCH', `/tickets/${t.ref}`, {status: 'open', assignee: null});
    assert.equal(reopened.json.ticket.assignee, null);
    const msgs = (await deps.store.messages(t.ref)).map((m) => m.body);
    assert.ok(msgs.includes('closed_by_team') && msgs.includes('reopened_by_team'));
    for (const bad of [{priority: 'now'}, {status: 'done'}, {assignee: 'a b'}, {tags: ['UPPER CASE!!']}, {tags: new Array(11).fill('x')}, {}]) {
      assert.equal((await call('PATCH', `/tickets/${t.ref}`, bad)).status, 400, JSON.stringify(bad));
    }
    const audit = await deps.store.auditFor(t.ref);
    assert.ok(audit.every((a) => a.actor === 'stan'));
    assert.equal(audit.filter((a) => a.action === 'update').length, 3);
  });

  it('runs saved replies CRUD', async () => {
    const { call } = await setup();
    const c = await call('POST', '/saved-replies', {title: 'Calibrate gyro', body: 'Hold the board still, then run calibrate.'});
    assert.equal(c.status, 201);
    const id = c.json.reply.id;
    assert.equal((await call('PUT', `/saved-replies/${id}`, {title: 'Calibrate', body: 'Updated text'})).json.reply.body, 'Updated text');
    assert.equal((await call('GET', '/saved-replies')).json.replies.length, 1);
    assert.equal((await call('POST', '/saved-replies', {title: '', body: 'x'})).status, 400);
    assert.equal((await call('DELETE', `/saved-replies/${id}`)).status, 200);
    assert.equal((await call('DELETE', `/saved-replies/${id}`)).status, 404);
  });
});

describe('staff replies', {skip}, () => {
  it('writes the reply for the customer page, scrubs it, settles the draft and audits it', async () => {
    const { deps, call, ai } = await setup();
    const t = await createTicket(deps, input({topic: 'product', orderNumber: null, product: 'OpenFC F4', message: 'The gyro drifts after a power cycle. Help?'}));
    const draft = (await call('GET', `/tickets/${t.ref}/draft`)).json.draft;
    const sentDraft = await call('POST', `/tickets/${t.ref}/reply`, {body: draft.text, draftId: draft.draftId, authorName: 'Stan'});
    assert.equal(sentDraft.status, 201);
    assert.equal(sentDraft.json.ticket.status, 'answered');
    assert.equal(sentDraft.json.ticket.assignee, 'stan');
    const row = (await deps.store.getTicket(t.ref))!;
    assert.equal(row.lastStaffAt, clock);
    const staff = (await deps.store.messages(t.ref)).find((m) => m.role === 'staff')!;
    assert.equal(staff.author, 'Stan');
    assert.equal(ai.outcomes[0]!.status, 'approved');
    assert.equal(ai.outcomes[0]!.decidedBy, 'stan');
    assert.ok((await deps.store.auditFor(t.ref)).some((a) => a.action === 'reply' && a.detail.includes(`draft=${draft.draftId}`)));

    // An edited text is a replacement; personal data is scrubbed; empty and oversized are refused.
    const second = await createTicket(deps, input({topic: 'product', orderNumber: null, email: 'eva@example.com', message: 'The motor stutters on throttle punch outs.'}));
    const edited = await call('POST', `/tickets/${second.ref}/reply`, {body: 'Mail us at someone@example.com or try a lower gain.', draftId: 'dr_2', status: 'waiting'});
    assert.equal(edited.json.ticket.status, 'waiting');
    assert.ok(!edited.json.message.body.includes('someone@example.com'));
    assert.equal(ai.outcomes[1]!.status, 'replaced');
    assert.equal((await call('POST', `/tickets/${second.ref}/reply`, {body: '  '})).status, 422);
    assert.equal((await call('POST', `/tickets/${second.ref}/reply`, {body: 'x'.repeat(8001)})).status, 422);
  });

  it('mails the customer through the existing reply notice', async () => {
    const { deps, call, sent } = await setup();
    const t = await createTicket(deps, input());
    clock += 60_000;
    await call('POST', `/tickets/${t.ref}/reply`, {body: 'Batch 2 ships in November.'});
    clock += 11 * 60_000;
    await runScheduled(deps);
    assert.equal(sent.length, 1);
    assert.ok(sent[0]!.body.includes('jan@example.com'));
    assert.ok(!sent[0]!.body.includes('Batch 2 ships'), 'the notice carries no message content');
  });

  it('stores staff attachments in R2 and streams them back', async () => {
    const { deps, call, r2 } = await setup();
    const t = await createTicket(deps, input());
    const form = new FormData();
    form.set('body', 'Photo of the right wiring attached.');
    form.append('files', new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])], 'wiring.png', {type: 'image/png'}));
    const r = await call('POST', `/tickets/${t.ref}/reply`, form);
    assert.equal(r.status, 201);
    const att = r.json.message.attachments[0];
    assert.equal(att.filename, 'wiring.png');
    assert.equal(r2.objects.size, 1);
    const file = await call('GET', att.href.replace(STAFF_BASE, ''));
    assert.equal(file.status, 200);
    assert.equal(file.res.headers.get('Content-Disposition'), 'attachment; filename="wiring.png"');
    assert.equal(file.res.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal((await call('GET', `/tickets/${t.ref}/files/r2_00000000000000000000`)).status, 404);
  });

  it('mirrors the reply into a thread that predates the CRM, text only', async () => {
    const { deps, call, discord } = await setup();
    const t = await createTicket({...deps, env: {...deps.env, SUPPORT_CRM_API: '0'}}, input());
    assert.ok(t.threadId);
    const r = await call('POST', `/tickets/${t.ref}/reply`, {body: 'We will look into it.'}); 
    assert.equal(r.status, 201);
    const posts = discord.threads.get(t.threadId)!.messages.map((m) => m.content);
    assert.ok(posts.some((p) => p.includes('staff (CRM)') && p.includes('We will look into it.')));
  });

  it('refuses a reply on a locked ticket', async () => {
    const { deps, call } = await setup();
    const t = await createTicket(deps, input());
    await deps.store.updateTicket(t.ref, {locked: true});
    assert.equal((await call('POST', `/tickets/${t.ref}/reply`, {body: 'Hello there'})).status, 409);
  });
});

describe('community tickets in the staff API', {skip}, () => {
  it('marks member replies, takes a ticket over and shows the replies as community', async () => {
    const db = (await testD1())!;
    const s = await setup();
    s.deps.store = createStore(db);
    s.deps.chatfpv = {client: fakeChatFpv({draft: (_r, n) => ({draftId: `dr_${n}`, draft: 'Recalibrate first.', citations: [], confidence: 0.8, note: '', route: 'community'})}).client, drafts: createDraftStore(db)};
    const t = await createTicket(s.deps, input({topic: 'product', orderNumber: null, product: 'OpenFC F4', communityConsent: true, message: 'The gyro drifts after a power cycle. How do I recalibrate?'}));
    await new Promise((r) => setTimeout(r, 20));
    const row = (await s.deps.store.getTicket(t.ref))!;
    assert.equal(row.route, 'community');
    s.discord.member(row.communityPostId!, 'Keep the quad still for five seconds, then run the calibration.');
    clock += 60_000;
    const detail = await s.call('GET', `/tickets/${t.ref}`);
    const reply = detail.json.messages.find((m: any) => m.role === 'community');
    assert.ok(reply, 'detail syncs the forum post');
    assert.equal((await s.call('GET', '/tickets?route=community')).json.tickets.length, 1);

    const marked = await s.call('POST', `/tickets/${t.ref}/messages/${reply.seq}/answer`);
    assert.equal(marked.status, 200);
    assert.equal(marked.json.ticket.status, 'answered');
    assert.equal((await s.deps.store.messageBySeq(t.ref, reply.seq))!.answer, true);
    assert.equal((await s.call('POST', `/tickets/${t.ref}/messages/1/answer`)).json.error, 'not_a_community_reply');
    assert.equal(publicMessage((await s.deps.store.messageBySeq(t.ref, reply.seq))!).answer, true);
    assert.equal((await s.call('DELETE', `/tickets/${t.ref}/messages/${reply.seq}/answer`)).status, 200);

    const taken = await s.call('POST', `/tickets/${t.ref}/takeover`);
    assert.equal(taken.json.ticket.route, 'team');
    assert.equal(taken.json.ticket.assignee, 'stan');
    assert.equal((await s.call('POST', `/tickets/${t.ref}/takeover`)).status, 409);
    const actions = (await s.deps.store.auditFor(t.ref)).map((a) => a.action);
    assert.ok(['takeover', 'mark_answer', 'unmark_answer', 'route_decision'].every((a) => actions.includes(a)));
  });
});

describe('customer card', {skip}, () => {
  it('shows orders and the preorder batch only for an order Shopify confirmed', async () => {
    const { deps, call } = await setup();
    const matched = await createTicket(deps, input());
    const card = (await call('GET', `/tickets/${matched.ref}/customer`)).json.customer;
    assert.equal(card.orderMatched, true);
    assert.equal(card.orders[0].name, '#1042');
    assert.deepEqual(card.orders[0].preorderBatches, ['batch 2 of OD-FC-F4']);
    assert.ok(!JSON.stringify(card).match(/address|phone|iban/i));

    const unverified = await createTicket(deps, input({orderNumber: '#9999'}));
    const bare = (await call('GET', `/tickets/${unverified.ref}/customer`)).json.customer;
    assert.equal(bare.orders.length, 0);
    assert.equal(bare.orderMatched, false);
    assert.ok(bare.earlierTickets.some((t: any) => t.ref === matched.ref));
  });
});
