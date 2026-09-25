import assert from 'node:assert/strict';
import {beforeEach, describe, it} from 'node:test';
import {_resetModCache} from './moderation.ts';
import {createStore} from './store.ts';
import {
  AUTO_CLOSE_MS,
  RETENTION_MS,
  addCustomerReply,
  cleanupExpired,
  closeTicket,
  createTicket,
  findTickets,
  parseNewTicket,
  publicMessage,
  publicTicket,
  resetLink,
  runScheduled,
  staffCard,
  subjectFor,
  syncTicket,
  type Deps,
  type NewTicketInput,
  type SupportEnv,
} from './tickets.ts';
import {isEmail, normalizeOrderNumber} from './shopify.ts';
import {fakeDiscord, fakeShopify, testD1, type ShopifyScript} from './testing.ts';

const probe = await testD1();
const skip = probe ? false : 'node:sqlite unavailable';

const ENV: SupportEnv = {
  DISCORD_BOT_TOKEN: 'bot',
  DISCORD_SUPPORT_CHANNEL_ID: '42',
  DISCORD_GUILD_ID: '7',
  SUPPORT_MODERATION_MODE: 'off',
  SUPPORT_SESSION_SECRET: 'test-secret',
  SHOPIFY_STORE_DOMAIN: 'opendrone-test.myshopify.com',
  SHOPIFY_ADMIN_API_TOKEN: 'shpat_test',
  SUPPORT_SHOPIFY_WRITE_ENABLED: '1',
};

const JAN_ORDER = {
  name: '#1042',
  email: 'jan@example.com',
  customer: {id: 'gid://shopify/Customer/1'},
  createdAt: '2026-08-02T10:00:00Z',
  displayFinancialStatus: 'PAID',
  displayFulfillmentStatus: 'UNFULFILLED',
  tags: ['preorder', 'batch:OD-FC-F4:2', 'vip'],
  lineItems: {nodes: [{sku: 'OD-FC-F4', title: 'OpenFC F4', quantity: 1}]},
};
const EVA_ORDER = {...JAN_ORDER, name: '#1077', email: 'eva@example.com', customer: {id: 'gid://shopify/Customer/2'}};

const SCRIPT: ShopifyScript = {
  customers: [
    {id: 'gid://shopify/Customer/1', email: 'jan@example.com', numberOfOrders: 2, orders: [JAN_ORDER]},
    {id: 'gid://shopify/Customer/2', email: 'eva@example.com', numberOfOrders: 1, orders: [EVA_ORDER]},
    // A fuzzy search hit that is not an exact email match.
    {id: 'gid://shopify/Customer/3', email: 'jan@example.company', numberOfOrders: 0},
  ],
  orders: [JAN_ORDER, EVA_ORDER],
};

let clock = Date.parse('2026-09-01T09:00:00Z');

async function setup(opts: {env?: Partial<SupportEnv>; script?: ShopifyScript; failCreate?: boolean} = {}) {
  const db = (await testD1())!;
  const discord = fakeDiscord({failCreate: opts.failCreate, now: () => clock});
  const shopify = fakeShopify(opts.script ?? SCRIPT);
  const deps: Deps = {
    env: {...ENV, ...opts.env},
    store: createStore(db),
    discord: discord.client,
    fetcher: shopify.fetcher,
    now: () => clock,
    origin: 'https://opendrone.test',
  };
  return {deps, discord, shopify};
}

function input(over: Partial<NewTicketInput> = {}): NewTicketInput {
  return {
    topic: 'order',
    name: 'Jan Peeters',
    email: 'jan@example.com',
    orderNumber: '#1042',
    product: null,
    firmware: null,
    message: 'My preorder shows batch 2. When does it ship?',
    ...over,
  };
}

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

beforeEach(() => {
  clock = Date.parse('2026-09-01T09:00:00Z');
  _resetModCache();
});

describe('parseNewTicket', () => {
  it('accepts an order ticket and normalises the order number', () => {
    const r = parseNewTicket(form({topic: 'order', name: 'Jan', email: 'JAN@Example.com', order: '1042', message: 'Where is my parcel please?'}));
    assert.ok(r.ok);
    assert.equal(r.input.email, 'jan@example.com');
    assert.equal(r.input.orderNumber, '#1042');
    assert.equal(r.input.product, null);
  });

  it('asks for the fields each topic needs', () => {
    const r = parseNewTicket(form({topic: 'warranty', name: 'Jan', email: 'jan@example.com', message: 'The ESC smoked on first plug.'}));
    assert.ok(!r.ok);
    assert.equal(r.errors.orderNumber, 'required');
    assert.equal(r.errors.product, 'required');
  });

  it('rejects an unknown topic, a bad email, a bad order number and a short message', () => {
    const r = parseNewTicket(form({topic: 'refund', name: '', email: 'nope', order: 'abc', message: 'hi'}));
    assert.ok(!r.ok);
    assert.deepEqual(Object.keys(r.errors).sort(), ['email', 'message', 'name', 'orderNumber', 'topic']);
  });

  it('refuses a message the inbound scrubber blocks', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U ';
    const r = parseNewTicket(form({topic: 'other', name: 'Jan', email: 'jan@example.com', message: jwt.repeat(12)}));
    assert.ok(!r.ok);
    assert.equal(r.errors.message, 'filtered');
  });

  it('redacts a card number before it can reach Discord', () => {
    const r = parseNewTicket(form({topic: 'other', name: 'Jan', email: 'jan@example.com', message: 'charged twice on 4111 1111 1111 1111 yesterday'}));
    assert.ok(r.ok);
    assert.match(r.input.message, /\[card redacted\]/);
  });
});

describe('createTicket', {skip}, () => {
  it('opens a thread with the staff card, relays the message and stores the ticket', async () => {
    const {deps, discord} = await setup();
    const t = await createTicket(deps, input());
    assert.match(t.ref, /^OD-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    assert.equal(t.status, 'open');
    assert.equal(t.customerMatch, 'matched');
    assert.equal(t.customerId, 'gid://shopify/Customer/1');
    const thread = discord.threads.get(t.threadId)!;
    assert.match(thread.messages[0]!.content, new RegExp(t.ref));
    assert.match(thread.messages[0]!.content, /#1042 · 2026-08-02 · PAID · UNFULFILLED · preorder · batch:OD-FC-F4:2/);
    assert.doesNotMatch(thread.messages[0]!.content, /vip/);
    assert.match(thread.messages[1]!.content, /^\*\*Jan · customer\*\*\nMy preorder/);
    const msgs = await deps.store.messages(t.ref);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0]!.role, 'customer');
  });

  it('records the ticket on the matched Shopify customer: tag and metafield', async () => {
    const {deps, shopify} = await setup();
    const t = await createTicket(deps, input());
    assert.deepEqual(shopify.writes.map((w) => w.op), ['metafieldsSet', 'tagsAdd']);
    const list = JSON.parse(shopify.metafields.get('gid://shopify/Customer/1')!) as Array<{ref: string; status: string; link: string}>;
    assert.equal(list[0]!.ref, t.ref);
    assert.equal(list[0]!.status, 'open');
    assert.equal(list[0]!.link, `https://discord.com/channels/7/${t.threadId}`);
  });

  it('writes nothing to Shopify unless SUPPORT_SHOPIFY_WRITE_ENABLED is 1', async () => {
    const {deps, shopify} = await setup({env: {SUPPORT_SHOPIFY_WRITE_ENABLED: undefined}});
    await createTicket(deps, input());
    assert.equal(shopify.writes.length, 0);
  });

  it('links nobody when no customer has the exact email', async () => {
    const {deps, discord, shopify} = await setup();
    const t = await createTicket(deps, input({email: 'new@example.com', orderNumber: null, topic: 'other'}));
    assert.equal(t.customerMatch, 'none');
    assert.equal(t.customerId, null);
    assert.equal(shopify.writes.length, 0);
    assert.match(discord.threads.get(t.threadId)!.messages[0]!.content, /no Shopify customer/);
  });

  it('ignores fuzzy search hits that are not the same email', async () => {
    const {deps} = await setup({script: {customers: [SCRIPT.customers![2]!]}});
    const t = await createTicket(deps, input({orderNumber: null, topic: 'other'}));
    assert.equal(t.customerMatch, 'none');
  });

  it('links nobody when several customers share the email', async () => {
    const twin = {id: 'gid://shopify/Customer/9', email: 'JAN@example.com'};
    const {deps, shopify, discord} = await setup({script: {customers: [SCRIPT.customers![0]!, twin], orders: [JAN_ORDER]}});
    const t = await createTicket(deps, input());
    assert.equal(t.customerMatch, 'multiple');
    assert.equal(shopify.writes.length, 0);
    assert.match(discord.threads.get(t.threadId)!.messages[0]!.content, /several Shopify customers/);
  });

  it("never shows staff another customer's order", async () => {
    const {deps, discord} = await setup();
    const t = await createTicket(deps, input({orderNumber: '#1077'}));
    const card = discord.threads.get(t.threadId)!.messages[0]!.content;
    assert.match(card, /Order #1077: not found for this email/);
    assert.doesNotMatch(card, /eva@example.com|1077 · 2026/);
  });

  it('keeps the email out of the thread when a staff metadata channel exists', async () => {
    const {deps, discord} = await setup({env: {DISCORD_STAFF_METADATA_CHANNEL_ID: '99'}});
    const t = await createTicket(deps, input());
    assert.doesNotMatch(discord.threads.get(t.threadId)!.messages[0]!.content, /jan@example.com/);
    assert.equal(discord.channelPosts.length, 1);
    assert.match(discord.channelPosts[0]!.content, /jan@example.com/);
    assert.match(discord.channelPosts[0]!.content, /admin\.shopify\.com\/store\/opendrone-test\/customers\/1/);
  });

  it('fails without storing anything when Discord is down', async () => {
    const {deps} = await setup({failCreate: true});
    await assert.rejects(createTicket(deps, input()));
    assert.equal((await deps.store.ticketsByEmail('jan@example.com')).length, 0);
  });

  it('relays attachments and keeps their Discord ids', async () => {
    const {deps} = await setup();
    const file = {name: 'crash.bbl', type: 'application/octet-stream', data: new Uint8Array([1, 2, 3])};
    const t = await createTicket(deps, input(), [file]);
    const [m] = await deps.store.messages(t.ref);
    assert.equal(m!.attachments[0]!.filename, 'crash.bbl');
    assert.match(publicMessage(m!).attachments[0]!.href!, new RegExp(`^/api/support/tickets/${t.ref}/files/\\d+/\\d+$`));
  });
});

describe('relay both ways', {skip}, () => {
  it('copies a staff reply to the ticket with a first name only, and marks it answered', async () => {
    const {deps, discord} = await setup();
    const t = await createTicket(deps, input());
    discord.staff(t.threadId, 'Batch 2 ships on 14 October. Mail me at jan.staff@opendrone.be');
    const {ticket, added} = await syncTicket(deps, t, {force: true});
    assert.equal(added, 1);
    assert.equal(ticket.status, 'answered');
    const msgs = await deps.store.messages(t.ref);
    const reply = msgs.at(-1)!;
    assert.equal(reply.role, 'staff');
    assert.equal(reply.author, 'Jan');
    assert.match(reply.body, /\[email redacted\]/);
  });

  it('never relays internal notes or its own bot posts, and consumes commands', async () => {
    const {deps, discord} = await setup();
    const t = await createTicket(deps, input());
    discord.staff(t.threadId, '// customer is a known reseller, check pricing');
    discord.staff(t.threadId, 'Could you send a photo of the label?');
    discord.staff(t.threadId, '!waiting');
    const {ticket} = await syncTicket(deps, t, {force: true});
    const bodies = (await deps.store.messages(t.ref)).map((m) => m.body);
    assert.ok(!bodies.some((b) => b.includes('reseller') || b.includes('!waiting')));
    assert.equal(ticket.status, 'waiting');
    assert.equal(discord.reactions.length, 1);
  });

  it('sends a customer reply to the thread and reopens the ticket as open', async () => {
    const {deps, discord} = await setup();
    let t = await createTicket(deps, input());
    discord.staff(t.threadId, 'Which firmware version?');
    t = (await syncTicket(deps, t, {force: true})).ticket;
    const r = await addCustomerReply(deps, t, '4.5.1, flashed yesterday');
    assert.ok(r.ok);
    assert.equal(r.ticket.status, 'open');
    const last = discord.threads.get(t.threadId)!.messages.at(-1)!;
    assert.equal(last.content, '**Jan · customer**\n4.5.1, flashed yesterday');
    // The bot's own relay is not copied back on the next sync.
    const again = await syncTicket(deps, r.ticket, {force: true});
    assert.equal(again.added, 0);
  });

  it('splits a long customer message into Discord-sized posts', async () => {
    const {deps, discord} = await setup();
    const t = await createTicket(deps, input());
    const long = Array.from({length: 80}, (_, i) => `line ${i} of the blackbox summary`).join('\n');
    await addCustomerReply(deps, t, long);
    const posts = discord.threads.get(t.threadId)!.messages.slice(2);
    assert.ok(posts.length >= 2);
    assert.ok(posts.every((p) => p.content.length <= 2000));
  });

  it('does not copy the same reply twice when two syncs overlap', async () => {
    const {deps, discord} = await setup();
    const t = await createTicket(deps, input());
    discord.staff(t.threadId, 'On it.');
    await Promise.all([syncTicket(deps, t, {force: true}), syncTicket(deps, t, {force: true})]);
    assert.equal((await deps.store.messages(t.ref)).filter((m) => m.role === 'staff').length, 1);
  });

  it('throttles syncs of one ticket', async () => {
    const {deps, discord} = await setup();
    const t = await createTicket(deps, input());
    discord.staff(t.threadId, 'Hi');
    const r = await syncTicket(deps, t);
    assert.equal(r.added, 0);
    clock += 5000;
    assert.equal((await syncTicket(deps, t)).added, 1);
  });

  it('holds replies until a moderator approves them in enforce mode', async () => {
    const {deps, discord} = await setup({env: {SUPPORT_MODERATION_MODE: 'enforce', SUPPORT_MOD_ROLE_ID: 'mods'}});
    discord.setRoleMembers(['mod-1']);
    let t = await createTicket(deps, input());
    const first = discord.staff(t.threadId, 'Draft answer');
    discord.staff(t.threadId, 'Second part');
    let r = await syncTicket(deps, t, {force: true});
    assert.equal(r.added, 0);
    assert.equal(r.held, 2);
    t = r.ticket;
    discord.approve(first, 'someone-else');
    r = await syncTicket(deps, t, {force: true});
    assert.equal(r.added, 0);
    discord.approve(first, 'mod-1');
    r = await syncTicket(deps, r.ticket, {force: true});
    assert.equal(r.added, 1);
  });
});

describe('status transitions', {skip}, () => {
  it('customer closes, a reply reopens, staff close and reopen by command', async () => {
    const {deps, discord} = await setup();
    let t = await createTicket(deps, input());
    t = await closeTicket(deps, t, 'you');
    assert.equal(t.status, 'closed');
    assert.ok(discord.threads.get(t.threadId)!.archived);
    const r = await addCustomerReply(deps, t, 'Actually it happened again.');
    assert.ok(r.ok);
    t = r.ticket;
    assert.equal(t.status, 'open');
    assert.equal(t.closedAt, null);
    discord.staff(t.threadId, '!close');
    t = (await syncTicket(deps, t, {force: true})).ticket;
    assert.equal(t.status, 'closed');
    discord.staff(t.threadId, '!open');
    t = (await syncTicket(deps, t, {force: true})).ticket;
    assert.equal(t.status, 'open');
    const events = (await deps.store.messages(t.ref)).filter((m) => m.role === 'system').map((m) => m.body);
    assert.deepEqual(events, ['closed_by_you', 'reopened_by_you', 'closed_by_team', 'reopened_by_team']);
  });

  it('locking the thread in Discord closes the ticket', async () => {
    const {deps, discord} = await setup();
    const t = await createTicket(deps, input());
    discord.threads.get(t.threadId)!.locked = true;
    const {ticket} = await syncTicket(deps, t, {force: true});
    assert.equal(ticket.status, 'closed');
  });

  it('updates the status on the Shopify customer', async () => {
    const {deps, shopify} = await setup();
    const t = await createTicket(deps, input());
    await closeTicket(deps, t, 'you');
    const list = JSON.parse(shopify.metafields.get('gid://shopify/Customer/1')!) as Array<{status: string}>;
    assert.equal(list.length, 1);
    assert.equal(list[0]!.status, 'closed');
  });

  it('auto-closes an answered ticket after 30 silent days, not an open one', async () => {
    const {deps, discord} = await setup();
    const answered = await createTicket(deps, input());
    const open = await createTicket(deps, input({email: 'other@example.com', orderNumber: null, topic: 'other'}));
    discord.staff(answered.threadId, 'Fixed in 4.5.2, please update.');
    await syncTicket(deps, answered, {force: true});
    clock += AUTO_CLOSE_MS + 60_000;
    const report = await runScheduled(deps);
    assert.deepEqual(report.autoClosed, [answered.ref]);
    assert.equal((await deps.store.getTicket(open.ref))!.status, 'open');
  });
});

describe('findTickets', {skip}, () => {
  it('finds by email and ticket reference, never across emails', async () => {
    const {deps} = await setup();
    const t = await createTicket(deps, input());
    assert.deepEqual((await findTickets(deps, 'JAN@example.com', t.ref.toLowerCase())).map((x) => x.ref), [t.ref]);
    assert.deepEqual(await findTickets(deps, 'eva@example.com', t.ref), []);
  });

  it('finds by email and an order number the ticket carries or Shopify confirms', async () => {
    const {deps} = await setup();
    const a = await createTicket(deps, input());
    const b = await createTicket(deps, input({topic: 'product', orderNumber: null, product: 'OpenESC 30x30'}));
    assert.equal((await findTickets(deps, 'jan@example.com', '1042')).length, 2);
    assert.deepEqual(await findTickets(deps, 'jan@example.com', '#1077'), []);
    assert.deepEqual(await findTickets(deps, 'eva@example.com', '1077'), []);
    assert.ok([a.ref, b.ref].every(Boolean));
  });

  it('answers nothing for malformed input', async () => {
    const {deps} = await setup();
    assert.deepEqual(await findTickets(deps, 'not-an-email', '1042'), []);
    assert.deepEqual(await findTickets(deps, 'jan@example.com', 'hello'), []);
  });
});

describe('cleanup', {skip}, () => {
  it('deletes tickets closed more than 24 months ago everywhere, and only those', async () => {
    const {deps, discord, shopify} = await setup();
    const old = await closeTicket(deps, await createTicket(deps, input()), 'you');
    clock += RETENTION_MS - 60_000;
    const recent = await closeTicket(deps, await createTicket(deps, input({orderNumber: '#1042'})), 'you');
    clock += 120_000;
    assert.deepEqual(await cleanupExpired(deps, {dryRun: true}), [old.ref]);
    assert.ok(await deps.store.getTicket(old.ref));
    assert.deepEqual(await cleanupExpired(deps), [old.ref]);
    assert.equal(await deps.store.getTicket(old.ref), null);
    assert.equal((await deps.store.messages(old.ref)).length, 0);
    assert.ok(discord.threads.get(old.threadId)!.deleted);
    assert.ok(await deps.store.getTicket(recent.ref));
    const list = JSON.parse(shopify.metafields.get('gid://shopify/Customer/1')!) as Array<{ref: string}>;
    assert.deepEqual(list.map((e) => e.ref), [recent.ref]);
  });
});

describe('notifications', {skip}, () => {
  it('sends nothing while SUPPORT_EMAIL_NOTIFY_ENABLED is off', async () => {
    const sent: string[] = [];
    const {deps, discord} = await setup();
    const base = deps.fetcher!;
    deps.fetcher = (async (url: string, init: RequestInit) => {
      if (String(url).includes('resend')) sent.push(String(init.body));
      return base(url, init);
    }) as unknown as typeof fetch;
    const t = await createTicket(deps, input());
    discord.staff(t.threadId, 'Answer');
    clock += 11 * 60_000;
    const report = await runScheduled(deps);
    assert.equal(report.notified, 0);
    assert.equal(sent.length, 0);
  });

  it('emails a link, not the message, once, when enabled and unseen', async () => {
    const sent: Array<{to: string[]; text: string}> = [];
    const {deps, discord} = await setup({env: {SUPPORT_EMAIL_NOTIFY_ENABLED: '1', RESEND_API_KEY: 're_test'}});
    const base = deps.fetcher!;
    deps.fetcher = (async (url: string, init: RequestInit) => {
      if (String(url).includes('resend')) {
        sent.push(JSON.parse(String(init.body)) as {to: string[]; text: string});
        return new Response('{}', {status: 200});
      }
      return base(url, init);
    }) as unknown as typeof fetch;
    const t = await createTicket(deps, input());
    clock += 60_000;
    discord.staff(t.threadId, 'The secret answer is 42');
    clock += 11 * 60_000;
    assert.equal((await runScheduled(deps)).notified, 1);
    assert.equal((await runScheduled(deps)).notified, 0);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]!.to, ['jan@example.com']);
    assert.match(sent[0]!.text, /https:\/\/opendrone\.test\/support\/resume\?t=/);
    assert.doesNotMatch(sent[0]!.text, /42/);
  });
});

describe('what the browser sees', {skip}, () => {
  it('carries no email, Discord or Shopify ids', async () => {
    const {deps} = await setup();
    const t = await createTicket(deps, input());
    const json = JSON.stringify(publicTicket(t));
    assert.doesNotMatch(json, /jan@example.com|Customer\/1|threadId|Peeters/);
    assert.equal(publicTicket(t).name, 'Jan');
  });

  it('a link reset bumps the version', async () => {
    const {deps} = await setup();
    const t = await createTicket(deps, input());
    const r = await resetLink(deps, t);
    assert.equal(r.linkVersion, 2);
    assert.equal((await deps.store.getTicket(t.ref))!.linkVersion, 2);
  });
});

describe('staffCard', () => {
  it('pings the support role and lists the commands', () => {
    const card = staffCard({
      env: {...ENV, SUPPORT_MOD_ROLE_ID: '555'},
      ref: 'OD-AAAA-BBBB',
      input: input(),
      customer: {match: 'unchecked'},
      order: null,
    });
    assert.match(card, /<@&555>/);
    assert.match(card, /!waiting/);
    assert.match(card, /Shopify not checked/);
  });
});

describe('small parsers', () => {
  it('build a readable subject per topic', () => {
    assert.equal(subjectFor({topic: 'order', orderNumber: '#1042', product: null}), 'Order #1042');
    assert.equal(subjectFor({topic: 'warranty', orderNumber: '#1042', product: 'OpenESC 30x30'}), 'Warranty: OpenESC 30x30, order #1042');
    assert.equal(subjectFor({topic: 'product', orderNumber: null, product: 'OpenFC F4'}), 'OpenFC F4');
    assert.equal(subjectFor({topic: 'other', orderNumber: null, product: null}), 'General question');
  });

  it('normalise order numbers and refuse emails that could break a search query', () => {
    assert.equal(normalizeOrderNumber(' # 1042 '), '#1042');
    assert.equal(normalizeOrderNumber('10a2'), null);
    assert.ok(isEmail('jan@example.com'));
    assert.ok(!isEmail('jan"@example.com'));
    assert.ok(!isEmail('jan @example.com'));
  });
});
