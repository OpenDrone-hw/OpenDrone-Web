import assert from 'node:assert/strict';
import {beforeEach, describe, it} from 'node:test';
import {_resetGmailToken, createGmailClient, signAssertion, toMailMessage, type GmailClient} from './mail-gmail.ts';
import {
  authenticated,
  classify,
  cleanSubject,
  guessTopic,
  orderNumberIn,
  parseAddress,
  refInSubject,
  stripQuoted,
  bodyText,
  type MailConfig,
  type MailMessage,
} from './mail-parse.ts';
import {_resetModCache} from './moderation.ts';
import {composeTicketText, gmailQuery, mailConfig, mailIntakeMode, mailIntakeReady, runMailIntake, type MailEnv} from './mail.ts';
import {createStore} from './store.ts';
import {addCustomerReply, closeTicket, type Deps, type SupportEnv} from './tickets.ts';
import {fakeChatFpv, fakeDiscord, fakeShopify, testD1, type ShopifyScript} from './testing.ts';
import {createDraftStore} from './ai-drafts.ts';

const probe = await testD1();
const skip = probe ? false : 'node:sqlite unavailable';

const CFG: MailConfig = {
  addresses: ['contact@opendrone.be', 'hello@opendrone.be'],
  ownDomains: ['opendrone.be', 'incutec.eu'],
  allow: [],
  deny: ['supplier.example'],
};

const AUTH = 'mx.google.com; dkim=pass header.i=@example.com; spf=pass; dmarc=pass (p=NONE)';

let counter = 0;
function mail(over: {headers?: Record<string, string>; text?: string | null; html?: string | null; labels?: string[]; attachments?: number; threadId?: string; id?: string} = {}): MailMessage {
  counter++;
  const h: Record<string, string> = {
    from: 'Jan Peeters <jan@example.com>',
    to: 'contact@opendrone.be',
    subject: 'Question about order #1042',
    'message-id': `<m${counter}@example.com>`,
    'authentication-results': AUTH,
    ...over.headers,
  };
  return {
    id: over.id ?? `g${counter}`,
    threadId: over.threadId ?? `t${counter}`,
    labelIds: over.labels ?? ['INBOX', 'UNREAD'],
    headers: Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), [v]])),
    text: over.text === undefined ? 'When does my preorder ship?\n\nThanks, Jan' : over.text,
    html: over.html ?? null,
    attachmentCount: over.attachments ?? 0,
    receivedAt: Date.parse('2026-09-01T08:50:00Z'),
  };
}

describe('addresses', () => {
  it('parses From headers', () => {
    assert.deepEqual(parseAddress('Jan Peeters <Jan@Example.com>'), {email: 'jan@example.com', name: 'Jan Peeters'});
    assert.deepEqual(parseAddress('"Peeters, Jan" <jan@example.com>'), {email: 'jan@example.com', name: 'Peeters, Jan'});
    assert.deepEqual(parseAddress('jan@example.com'), {email: 'jan@example.com', name: ''});
    assert.equal(parseAddress('not an address'), null);
    assert.equal(parseAddress(undefined), null);
  });
});

describe('classify', () => {
  it('takes a plain customer mail', () => {
    const v = classify(mail(), CFG);
    assert.equal(v.ok, true);
  });

  const cases: Array<[string, Parameters<typeof mail>[0], string]> = [
    ['own domain', {headers: {from: 'Stan <stan@incutec.eu>'}}, 'own_domain'],
    ['own alias', {headers: {from: 'sales@opendrone.be'}}, 'own_domain'],
    ['no-reply sender', {headers: {from: 'noreply@shop.example'}}, 'no_reply_sender'],
    ['do-not-reply sender', {headers: {from: 'Shop <do-not-reply@shop.example>'}}, 'no_reply_sender'],
    ['mailer daemon', {headers: {from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>'}}, 'no_reply_sender'],
    ['auto-submitted', {headers: {'auto-submitted': 'auto-replied'}}, 'auto_submitted'],
    ['bulk precedence', {headers: {precedence: 'bulk'}}, 'bulk'],
    ['newsletter', {headers: {'list-unsubscribe': '<mailto:u@x.example>'}}, 'newsletter'],
    ['bounce report', {headers: {'content-type': 'multipart/report; report-type=delivery-status'}}, 'bounce'],
    ['empty return path', {headers: {'return-path': '<>'}}, 'bounce'],
    ['promotions label', {labels: ['INBOX', 'CATEGORY_PROMOTIONS']}, 'category'],
    ['spam label', {labels: ['SPAM']}, 'label'],
    ['out of office subject', {headers: {subject: 'Automatic reply: holiday'}}, 'auto_reply'],
    ['denied supplier', {headers: {from: 'rep@mail.supplier.example'}}, 'denied'],
    ['not addressed to us', {headers: {to: 'someone@else.example'}}, 'not_addressed'],
    ['no authentication', {headers: {'authentication-results': 'mx.google.com; dkim=fail; spf=fail; dmarc=fail'}}, 'unauthenticated'],
    ['no from', {headers: {from: ''}}, 'no_sender'],
  ];
  for (const [name, over, reason] of cases) {
    it(`drops ${name}`, () => {
      const v = classify(mail(over), CFG);
      assert.equal(v.ok, false);
      assert.equal(v.ok === false && v.reason, reason);
    });
  }

  it('lets the allow list lift automation heuristics but not the deny list or authentication', () => {
    const allow: MailConfig = {...CFG, allow: ['noreply@partner.example', '@list.example'], deny: ['bad.example']};
    assert.equal(classify(mail({headers: {from: 'noreply@partner.example'}}), allow).ok, true);
    assert.equal(classify(mail({headers: {from: 'x@list.example', 'list-unsubscribe': '<x>'}}), allow).ok, true);
    assert.equal(classify(mail({headers: {from: 'a@bad.example'}}), {...allow, allow: ['a@bad.example']}).ok, false);
    assert.equal(classify(mail({headers: {from: 'noreply@partner.example', 'authentication-results': 'mx; dmarc=fail'}}), allow).ok, false);
  });

  it('reads the customer from a group relay and its delivery headers', () => {
    const relayed = mail({headers: {from: 'Jan Peeters via Support <support@incutec.eu>', 'x-original-sender': 'jan@example.com', to: 'support@incutec.eu'}});
    const cfg: MailConfig = {...CFG, addresses: ['support@incutec.eu']};
    const v = classify(relayed, cfg);
    assert.equal(v.ok && v.sender.email, 'jan@example.com');
    assert.equal(v.ok && v.sender.name, 'Jan Peeters');
    const delivered = mail({headers: {to: 'undisclosed-recipients:;', 'delivered-to': 'hello@opendrone.be'}});
    assert.equal(classify(delivered, CFG).ok, true);
  });

  it('judges authentication by DMARC first', () => {
    assert.equal(authenticated(mail({headers: {'authentication-results': 'mx; dmarc=pass'}})), true);
    assert.equal(authenticated(mail({headers: {'authentication-results': 'mx; dkim=pass; dmarc=fail'}})), false);
    assert.equal(authenticated(mail({headers: {'authentication-results': 'mx; spf=pass'}})), true);
    assert.equal(authenticated(mail({headers: {'authentication-results': ''}})), false);
  });
});

describe('text', () => {
  it('removes quoted replies, attributions and signatures', () => {
    const raw = [
      'Yes, batch 2 is fine.',
      'Please keep the address.',
      '',
      '> Hi Jan, your order ships soon.',
      '> Regards',
      '',
      '-- ',
      'Jan Peeters',
      '+32 470 00 00 00',
    ].join('\n');
    assert.equal(stripQuoted(raw), 'Yes, batch 2 is fine.\nPlease keep the address.');
  });

  it('cuts at wrapped and translated attributions, Outlook blocks and mobile footers', () => {
    assert.equal(stripQuoted('Thanks!\n\nOn Mon, 31 Aug 2026 at 10:00, OpenDrone <contact@opendrone.be>\nwrote:\n> hi'), 'Thanks!');
    assert.equal(stripQuoted('Dank u\n\nOp ma 31 aug. 2026 om 10:00 schreef OpenDrone <contact@opendrone.be>:\n> hoi'), 'Dank u');
    assert.equal(stripQuoted('Merci\n\nLe 31 août 2026 à 10:00, OpenDrone a écrit :\n> salut'), 'Merci');
    assert.equal(stripQuoted('Ok\n\n-----Original Message-----\nFrom: x\nSent: y\nBody'), 'Ok');
    assert.equal(stripQuoted('Ok\n\nFrom: OpenDrone <a@b.be>\nSent: Monday\nTo: me\nSubject: Re: x\n\nold'), 'Ok');
    assert.equal(stripQuoted('See photo\n\nSent from my iPhone\n\nold'), 'See photo');
  });

  it('keeps inline replies between quoted lines and falls back when only a quote is left', () => {
    assert.equal(stripQuoted('> Did you flash it?\nYes, twice.\n> And?\nNo change.'), 'Yes, twice.\nNo change.');
    assert.equal(stripQuoted('> only a quote'), 'only a quote');
  });

  it('falls back to HTML without its quote block', () => {
    const m = mail({text: null, html: '<div>Hello&nbsp;there<br>Is it <b>in stock</b>?</div><blockquote>old &amp; gone</blockquote>'});
    assert.equal(bodyText(m), 'Hello there\nIs it in stock?');
  });

  it('cleans subjects and finds references, order numbers and topics', () => {
    assert.equal(cleanSubject('Re: Fwd: RE: Hello'), 'Hello');
    assert.equal(refInSubject('Re: New reply on your OpenDrone ticket OD-K7M4-Q2XF'), 'OD-K7M4-Q2XF');
    assert.equal(refInSubject('ticket od k7m4q2xf'), null);
    assert.equal(orderNumberIn('Question about order #1042'), '#1042');
    assert.equal(orderNumberIn('hi', 'my order number 20871 has not arrived'), '#20871');
    assert.equal(orderNumberIn('Bestelling 20871 is niet aangekomen'), '#20871');
    assert.equal(orderNumberIn('I have 3 drones and 12 motors'), null);
    assert.equal(guessTopic('ESC firmware', 'how do I flash AM32'), 'product');
    assert.equal(guessTopic('Where is my order', 'tracking please'), 'order');
    assert.equal(guessTopic('Broken arm', 'frame arrived broken, order #1042'), 'warranty');
    assert.equal(guessTopic('Hi', 'nice project'), 'other');
  });

  it('caps a new ticket text at the form limit', () => {
    const long = composeTicketText('Hello', 'x'.repeat(9000), 2);
    assert.ok(long.length <= 4000);
    assert.match(long, /\[mail truncated\]$/);
    assert.match(composeTicketText('Hello', 'body', 1), /1 attachment in the mail, not imported/);
  });
});

describe('gmail client', () => {
  beforeEach(() => _resetGmailToken());

  it('turns an API message into the fields the rules use', () => {
    const b64 = (s: string) => Buffer.from(s).toString('base64url');
    const m = toMailMessage({
      id: 'a1',
      threadId: 't1',
      labelIds: ['INBOX'],
      internalDate: '1788000000000',
      payload: {
        mimeType: 'multipart/mixed',
        headers: [{name: 'From', value: 'Jan <jan@example.com>'}, {name: 'Received', value: 'a'}, {name: 'Received', value: 'b'}],
        parts: [
          {mimeType: 'multipart/alternative', parts: [{mimeType: 'text/plain', body: {data: b64('plain text')}}, {mimeType: 'text/html', body: {data: b64('<p>html</p>')}}]},
          {mimeType: 'image/png', filename: 'a.png', body: {attachmentId: 'x', size: 10}},
        ],
      },
    });
    assert.equal(m.text, 'plain text');
    assert.equal(m.html, '<p>html</p>');
    assert.equal(m.attachmentCount, 1);
    assert.deepEqual(m.headers['received'], ['a', 'b']);
    assert.equal(m.receivedAt, 1788000000000);
  });

  it('signs a verifiable RS256 assertion and asks for the read-only scope as the mailbox', async () => {
    const pair = await crypto.subtle.generateKey({name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256'}, true, ['sign', 'verify']);
    const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
    const pem = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`;
    const key = {client_email: 'sa@proj.iam.gserviceaccount.com', private_key: pem};
    const jwt = await signAssertion(key, 'box@incutec.eu', 1_800_000_000);
    const [h, c, s] = jwt.split('.') as [string, string, string];
    const claims = JSON.parse(Buffer.from(c, 'base64url').toString()) as {sub: string; iss: string; scope: string; aud: string};
    assert.equal(claims.sub, 'box@incutec.eu');
    assert.equal(claims.iss, key.client_email);
    assert.equal(claims.scope, 'https://www.googleapis.com/auth/gmail.readonly');
    assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
    assert.equal((JSON.parse(Buffer.from(h, 'base64url').toString()) as {alg: string}).alg, 'RS256');
    assert.equal(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', pair.publicKey, Buffer.from(s, 'base64url'), new TextEncoder().encode(`${h}.${c}`)), true);

    // One token exchange serves many calls; list pages and get are plain GETs.
    const calls: string[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      calls.push(String(url).split('?')[0]!);
      if (String(url).startsWith('https://oauth2.googleapis.com/token')) return Response.json({access_token: 'tok', expires_in: 3600});
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer tok');
      if (String(url).includes('/messages?')) {
        const page2 = String(url).includes('pageToken=p2');
        return Response.json({messages: [{id: page2 ? 'b' : 'a', threadId: 't'}], ...(page2 ? {} : {nextPageToken: 'p2'})});
      }
      return Response.json({id: 'a', threadId: 't', payload: {headers: [], mimeType: 'text/plain', body: {data: Buffer.from('hi').toString('base64url')}}});
    }) as unknown as typeof fetch;
    const client = createGmailClient({SUPPORT_MAIL_SA_JSON: JSON.stringify(key), SUPPORT_MAIL_MAILBOX: 'box@incutec.eu'}, fetcher);
    assert.deepEqual((await client.list('q', 10)).map((i) => i.id), ['a', 'b']);
    assert.equal((await client.get('a')).text, 'hi');
    assert.equal(calls.filter((c) => c.includes('oauth2')).length, 1);
  });

  it('reports a rejected delegation without secrets', async () => {
    const fetcher = (async () => new Response('{"error":"unauthorized_client"}', {status: 401})) as unknown as typeof fetch;
    const pair = await crypto.subtle.generateKey({name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256'}, true, ['sign', 'verify']);
    const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
    const pem = `-----BEGIN PRIVATE KEY-----\n${der}\n-----END PRIVATE KEY-----`;
    const client = createGmailClient({SUPPORT_MAIL_SA_JSON: JSON.stringify({client_email: 'a@b', private_key: pem}), SUPPORT_MAIL_MAILBOX: 'm@x.eu'}, fetcher);
    await assert.rejects(() => client.list('q', 1), (e: Error) => /gmail token 401/.test(e.message) && !e.message.includes('PRIVATE KEY'));
  });
});

// --------------------------------------------------------------------------
// The pass
// --------------------------------------------------------------------------

const ENV: SupportEnv & MailEnv = {
  DISCORD_BOT_TOKEN: 'bot',
  DISCORD_SUPPORT_CHANNEL_ID: '42',
  DISCORD_GUILD_ID: '7',
  SUPPORT_MODERATION_MODE: 'off',
  SUPPORT_SESSION_SECRET: 'test-secret',
  SHOPIFY_STORE_DOMAIN: 'opendrone-test.myshopify.com',
  SHOPIFY_ADMIN_API_TOKEN: 'shpat_test',
  SUPPORT_SHOPIFY_WRITE_ENABLED: '1',
  SUPPORT_MAIL_INTAKE_ENABLED: '1',
  SUPPORT_MAIL_SA_JSON: '{}',
  SUPPORT_MAIL_MAILBOX: 'box@incutec.eu',
  SUPPORT_MAIL_DENY: 'supplier.example',
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
const SCRIPT: ShopifyScript = {
  customers: [{id: 'gid://shopify/Customer/1', email: 'jan@example.com', numberOfOrders: 1, orders: [JAN_ORDER]}],
  orders: [JAN_ORDER],
};

let clock = Date.parse('2026-09-01T09:00:00Z');

/** A Gmail that lists `inbox` newest first and records every call. */
function fakeGmail(inbox: MailMessage[]) {
  const calls = {list: 0, get: [] as string[], queries: [] as string[]};
  const client: GmailClient = {
    async list(query) {
      calls.list++;
      calls.queries.push(query);
      return [...inbox].reverse().map((m) => ({id: m.id, threadId: m.threadId}));
    },
    async get(id) {
      calls.get.push(id);
      const m = inbox.find((x) => x.id === id);
      if (!m) throw new Error('gmail get 404');
      return m;
    },
  };
  return {client, calls, inbox};
}

async function setup(opts: {env?: Partial<SupportEnv & MailEnv>; withChatFpv?: boolean} = {}) {
  const db = (await testD1())!;
  const discord = fakeDiscord({now: () => clock});
  const shopify = fakeShopify(SCRIPT);
  const chatfpv = fakeChatFpv();
  const deps: Deps = {
    env: {...ENV, ...opts.env},
    store: createStore(db),
    discord: discord.client,
    fetcher: shopify.fetcher,
    now: () => clock,
    origin: 'https://opendrone.test',
    chatfpv: opts.withChatFpv ? {client: chatfpv.client, drafts: createDraftStore(db)} : undefined,
  };
  return {deps, db, discord, shopify, chatfpv};
}

const threadsOf = (discord: ReturnType<typeof fakeDiscord>) => [...discord.threads.values()];

beforeEach(() => {
  clock = Date.parse('2026-09-01T09:00:00Z');
  _resetModCache();
});

describe('configuration', () => {
  it('is off unless the gate is 1 or dry, and needs credentials', () => {
    assert.equal(mailIntakeMode({}), 'off');
    assert.equal(mailIntakeMode({SUPPORT_MAIL_INTAKE_ENABLED: '0'}), 'off');
    assert.equal(mailIntakeMode({SUPPORT_MAIL_INTAKE_ENABLED: 'true'}), 'off');
    assert.equal(mailIntakeMode({SUPPORT_MAIL_INTAKE_ENABLED: ' DRY '}), 'dry');
    assert.equal(mailIntakeMode({SUPPORT_MAIL_INTAKE_ENABLED: '1'}), 'on');
    assert.equal(mailIntakeReady({SUPPORT_MAIL_INTAKE_ENABLED: '1'}), false);
    assert.equal(mailIntakeReady({SUPPORT_MAIL_INTAKE_ENABLED: '1', SUPPORT_MAIL_SA_JSON: '{}', SUPPORT_MAIL_MAILBOX: 'a@b.eu'}), true);
    assert.equal(mailIntakeReady({SUPPORT_MAIL_INTAKE_ENABLED: '0', SUPPORT_MAIL_SA_JSON: '{}', SUPPORT_MAIL_MAILBOX: 'a@b.eu'}), false);
  });

  it('defaults to the two customer addresses and builds the Gmail query from the list', () => {
    const cfg = mailConfig({});
    assert.deepEqual(cfg.addresses, ['contact@opendrone.be', 'hello@opendrone.be']);
    assert.deepEqual(cfg.ownDomains, ['opendrone.be', 'incutec.eu']);
    assert.equal(gmailQuery(cfg, 2), '{to:contact@opendrone.be deliveredto:contact@opendrone.be to:hello@opendrone.be deliveredto:hello@opendrone.be} newer_than:2d -in:sent -in:drafts');
    const custom = mailConfig({SUPPORT_MAIL_ADDRESSES: 'a@x.be, B@x.be', SUPPORT_MAIL_ALLOW: 'partner.example', SUPPORT_MAIL_DENY: 'x@y.z;q.example'});
    assert.deepEqual(custom.addresses, ['a@x.be', 'b@x.be']);
    assert.deepEqual(custom.deny, ['x@y.z', 'q.example']);
  });
});

describe('mail intake', {skip}, () => {
  it('does nothing while off or without credentials', async () => {
    const {deps, db} = await setup({env: {SUPPORT_MAIL_INTAKE_ENABLED: '0'}});
    const gmail = fakeGmail([mail()]);
    const report = await runMailIntake({deps, db, gmail: gmail.client});
    assert.equal(report.mode, 'off');
    assert.equal(gmail.calls.list, 0);
    const none = await setup({env: {SUPPORT_MAIL_SA_JSON: undefined}});
    const again = await runMailIntake({deps: none.deps, db: none.db, gmail: gmail.client});
    assert.equal(again.fetched, 0);
    assert.equal(gmail.calls.list, 0);
  });

  it('opens a ticket from a mail: thread, topic, order match through Shopify, ChatFPV draft', async () => {
    const {deps, db, discord, shopify, chatfpv} = await setup({withChatFpv: true});
    const gmail = fakeGmail([
      mail({
        headers: {subject: 'Re: ESC firmware order #1042'},
        text: 'How do I flash AM32 on the ESC from my order?\n\nJan\n\nOn Sun, 30 Aug 2026 at 12:00, OpenDrone wrote:\n> old text',
        attachments: 1,
      }),
    ]);
    const report = await runMailIntake({deps, db, gmail: gmail.client});
    assert.equal(report.tickets.length, 1);
    const ref = report.tickets[0]!;
    const ticket = (await deps.store.getTicket(ref))!;
    assert.equal(ticket.email, 'jan@example.com');
    assert.equal(ticket.name, 'Jan Peeters');
    assert.equal(ticket.topic, 'product');
    assert.equal(ticket.orderNumber, '#1042');
    assert.equal(ticket.orderVerified, true);
    assert.equal(ticket.customerMatch, 'matched');
    const messages = await deps.store.messages(ref);
    assert.match(messages[0]!.body, /^Subject: ESC firmware order #1042\n\nHow do I flash AM32/);
    assert.doesNotMatch(messages[0]!.body, /old text|wrote:/);
    assert.match(messages[0]!.body, /1 attachment in the mail, not imported/);
    const thread = threadsOf(discord)[0]!;
    assert.match(thread.name, new RegExp(ref));
    assert.ok(thread.messages.some((m) => /Source: mail\. Subject: ESC firmware order #1042/.test(m.content.replace(/\\(.)/g, '$1'))), 'source note in the thread');
    assert.ok(shopify.writes.some((w) => w.op === 'tagsAdd'), 'Shopify customer tagged only after the order matched');
    assert.equal(chatfpv.drafts.length, 1, 'a product ticket requests its draft like a web ticket');
    const row = await db.prepare('SELECT outcome, ref, gmail_thread_id FROM support_mail_messages').first<{outcome: string; ref: string; gmail_thread_id: string}>();
    assert.equal(row?.outcome, 'ticket');
    assert.equal(row?.ref, ref);
  });

  it('leaves a sender without a confirmed order unverified', async () => {
    const {deps, db, shopify} = await setup();
    const gmail = fakeGmail([mail({headers: {from: 'Eve <eve@example.com>', subject: 'Order #1042'}, text: 'Where is my order #1042? Please tell me.'})]);
    const report = await runMailIntake({deps, db, gmail: gmail.client});
    const ticket = (await deps.store.getTicket(report.tickets[0]!))!;
    assert.equal(ticket.orderVerified, false);
    assert.equal(ticket.customerId, null);
    assert.equal(shopify.writes.length, 0);
  });

  it('is idempotent: a second pass neither fetches nor duplicates', async () => {
    const {deps, db, discord} = await setup();
    const gmail = fakeGmail([mail()]);
    await runMailIntake({deps, db, gmail: gmail.client});
    const fetched = gmail.calls.get.length;
    const again = await runMailIntake({deps, db, gmail: gmail.client});
    assert.equal(again.tickets.length, 0);
    assert.equal(gmail.calls.get.length, fetched, 'decided messages are skipped before fetching');
    assert.equal(threadsOf(discord).length, 1);
  });

  it('dedupes the same Message-ID arriving under another Gmail id', async () => {
    const {deps, db, discord} = await setup();
    const a = mail({headers: {'message-id': '<same@example.com>'}});
    const b = mail({headers: {'message-id': '<same@example.com>'}});
    const report = await runMailIntake({deps, db, gmail: fakeGmail([a, b]).client});
    assert.equal(report.tickets.length, 1);
    assert.equal(threadsOf(discord).length, 1);
  });

  it('threads a follow-up by the Gmail thread and by the reference in the subject, for the same sender only', async () => {
    const {deps, db, discord} = await setup();
    const first = mail({threadId: 'thr-1', text: 'My GPS does not get a fix, what can I try?'});
    const inbox = fakeGmail([first]);
    const ref = (await runMailIntake({deps, db, gmail: inbox.client})).tickets[0]!;

    clock += 3600_000;
    inbox.inbox.push(mail({threadId: 'thr-1', headers: {subject: 'Re: Question'}, text: 'Update: it works outside.\n\n> quoted'}));
    const byThread = await runMailIntake({deps, db, gmail: inbox.client});
    assert.deepEqual(byThread.replies, [ref]);
    assert.equal(byThread.tickets.length, 0);

    clock += 3600_000;
    inbox.inbox.push(mail({threadId: 'other-thread', headers: {subject: `Re: New reply on your OpenDrone ticket ${ref}`}, text: 'One more question about the antenna.'}));
    const bySubject = await runMailIntake({deps, db, gmail: inbox.client});
    assert.deepEqual(bySubject.replies, [ref]);

    const bodies = (await deps.store.messages(ref)).filter((m) => m.role === 'customer').map((m) => m.body);
    assert.equal(bodies.length, 3);
    assert.equal(bodies[1], 'Update: it works outside.');
    assert.equal(threadsOf(discord).length, 1);

    // Someone else quoting the reference opens their own ticket instead of joining this one.
    clock += 3600_000;
    inbox.inbox.push(mail({headers: {from: 'Eve <eve@example.com>', subject: `Re: ticket ${ref}`}, text: 'I am not the ticket owner at all.'}));
    const stranger = await runMailIntake({deps, db, gmail: inbox.client});
    assert.equal(stranger.replies.length, 0);
    assert.equal(stranger.tickets.length, 1);
    assert.equal((await deps.store.messages(ref)).filter((m) => m.role === 'customer').length, 3);
  });

  it('reopens a closed ticket on a reply and opens a new one when the thread is locked', async () => {
    const {deps, db, discord} = await setup();
    const inbox = fakeGmail([mail({threadId: 'thr-2', text: 'First question about the box contents please.'})]);
    const ref = (await runMailIntake({deps, db, gmail: inbox.client})).tickets[0]!;
    await closeTicket(deps, (await deps.store.getTicket(ref))!, 'you');
    clock += 3600_000;
    inbox.inbox.push(mail({threadId: 'thr-2', text: 'Still not solved, sorry.'}));
    assert.deepEqual((await runMailIntake({deps, db, gmail: inbox.client})).replies, [ref]);
    assert.equal((await deps.store.getTicket(ref))!.status, 'open');

    await deps.store.updateTicket(ref, {locked: true});
    clock += 3600_000;
    inbox.inbox.push(mail({threadId: 'thr-2', text: 'Writing again after you locked it.'}));
    const report = await runMailIntake({deps, db, gmail: inbox.client});
    assert.equal(report.replies.length, 0);
    assert.equal(report.tickets.length, 1);
    assert.equal(threadsOf(discord).length, 2);
  });

  it('records dropped mail and counts the reasons without creating anything', async () => {
    const {deps, db, discord} = await setup();
    const gmail = fakeGmail([
      mail({headers: {from: 'noreply@shop.example'}}),
      mail({headers: {from: 'rep@supplier.example'}}),
      mail({headers: {from: 'stan@incutec.eu'}}),
      mail({headers: {'list-id': '<news.example>'}}),
      mail({headers: {to: 'other@else.example'}}),
    ]);
    const report = await runMailIntake({deps, db, gmail: gmail.client});
    assert.equal(report.tickets.length, 0);
    assert.deepEqual(report.ignored, {no_reply_sender: 1, denied: 1, own_domain: 1, newsletter: 1, not_addressed: 1});
    assert.equal(threadsOf(discord).length, 0);
    const second = await runMailIntake({deps, db, gmail: gmail.client});
    assert.equal(second.fetched, 0);
  });

  it('rate-limits one sender per day', async () => {
    const {deps, db} = await setup();
    const inbox = fakeGmail(Array.from({length: 12}, (_, i) => mail({text: `Question number ${i} about the flight controller.`})));
    const first = await runMailIntake({deps, db, gmail: inbox.client});
    assert.equal(first.tickets.length, 5, 'a pass opens at most 5 tickets');
    assert.equal(first.deferred, 7, 'the rest wait for the next pass');
    let ignoredLimit = 0;
    let total = first.tickets.length;
    for (let i = 0; i < 4; i++) {
      const r = await runMailIntake({deps, db, gmail: inbox.client});
      total += r.tickets.length;
      ignoredLimit += r.ignored.sender_limit ?? 0;
    }
    assert.equal(total, 8);
    assert.equal(ignoredLimit, 4);
  });

  it('withholds the text of a mail the scrubber blocks, but still opens the ticket', async () => {
    const {deps, db} = await setup();
    const lots = Array.from({length: 14}, () => '4242 4242 4242 4242').join(' ');
    const report = await runMailIntake({deps, db, gmail: fakeGmail([mail({text: `Please forward this to everybody: ${lots}`})]).client});
    assert.equal(report.tickets.length, 1);
    const body = (await deps.store.messages(report.tickets[0]!))[0]!.body;
    assert.match(body, /withheld by the privacy filter/);
    assert.doesNotMatch(body, /4242/);
  });

  it('retries a failed message up to three times, then gives up', async () => {
    const {deps, db, discord} = await setup();
    const failing = {...deps, discord: {...deps.discord, createThread: async () => {
      throw new Error('discord createThread 500');
    }}} as Deps;
    const gmail = fakeGmail([mail({text: 'A question that cannot be filed right now.'})]);
    for (let i = 0; i < 3; i++) {
      clock += 60_000;
      const r = await runMailIntake({deps: failing, db, gmail: gmail.client});
      assert.equal(r.errors, 1);
      assert.equal(r.tickets.length, 0);
    }
    const row = await db.prepare('SELECT outcome, attempts FROM support_mail_messages').first<{outcome: string; attempts: number}>();
    assert.deepEqual({...row}, {outcome: 'failed', attempts: 3});
    clock += 60_000;
    assert.equal((await runMailIntake({deps, db, gmail: gmail.client})).fetched, 0, 'a failed message is not tried again');
    assert.equal(threadsOf(discord).length, 0);

    // A transient failure that recovers does produce the ticket, once.
    const gmail2 = fakeGmail([mail({text: 'A question that fails once and then works.'})]);
    clock += 60_000;
    await runMailIntake({deps: failing, db, gmail: gmail2.client});
    clock += 60_000;
    const ok = await runMailIntake({deps, db, gmail: gmail2.client});
    assert.equal(ok.tickets.length, 1);
    assert.equal(threadsOf(discord).length, 1);
  });

  it('dry mode classifies and reports but writes nothing and sends nothing', async () => {
    const {deps, db, discord, shopify} = await setup({env: {SUPPORT_MAIL_INTAKE_ENABLED: 'dry'}});
    const gmail = fakeGmail([mail(), mail({headers: {from: 'noreply@shop.example'}})]);
    const report = await runMailIntake({deps, db, gmail: gmail.client});
    assert.equal(report.mode, 'dry');
    assert.equal(report.fetched, 2);
    assert.equal(report.tickets.length, 1);
    assert.deepEqual(report.ignored, {no_reply_sender: 1});
    assert.equal(threadsOf(discord).length, 0);
    assert.equal(shopify.writes.length, 0);
    const rows = await db.prepare('SELECT COUNT(*) AS n FROM support_mail_messages').first<{n: number}>();
    assert.equal(rows?.n, 0);
  });

  it('prunes undecided rows after 30 days and removes a ticket\'s rows with the ticket', async () => {
    const {deps, db} = await setup();
    const inbox = fakeGmail([mail({headers: {from: 'noreply@shop.example'}}), mail({threadId: 'thr-9'})]);
    const ref = (await runMailIntake({deps, db, gmail: inbox.client})).tickets[0]!;
    const count = async () => (await db.prepare('SELECT COUNT(*) AS n FROM support_mail_messages').first<{n: number}>())!.n;
    assert.equal(await count(), 2);
    clock += 31 * 24 * 3600_000;
    await runMailIntake({deps, db, gmail: fakeGmail([]).client});
    assert.equal(await count(), 1, 'the ignored row is pruned, the ticket row stays');
    await deps.store.deleteTicket(ref);
    assert.equal(await count(), 0, 'the trigger removes the rows of a deleted ticket');
  });

  it('stores no address, subject or body', async () => {
    const {deps, db} = await setup();
    await runMailIntake({deps, db, gmail: fakeGmail([mail({text: 'My secret question about the drone please.'})]).client});
    const dump = JSON.stringify(await db.prepare('SELECT * FROM support_mail_messages').all());
    assert.doesNotMatch(dump, /jan@example\.com|secret question|Question about order/);
  });

  it('never sends mail: the only outbound calls are Shopify GraphQL', async () => {
    const {deps, db} = await setup({env: {SUPPORT_EMAIL_NOTIFY_ENABLED: '1', RESEND_API_KEY: 're_test'}});
    const urls: string[] = [];
    const inner = deps.fetcher!;
    deps.fetcher = (async (url: string, init: RequestInit) => {
      urls.push(String(url));
      return inner(url, init);
    }) as unknown as typeof fetch;
    await runMailIntake({deps, db, gmail: fakeGmail([mail()]).client});
    assert.ok(urls.length > 0);
    assert.ok(urls.every((u) => u.includes('myshopify.com')), urls.join(','));
    assert.ok(!urls.some((u) => u.includes('resend')));
  });

  it('a customer reply via mail uses the same reply path as the site', async () => {
    const {deps, db} = await setup();
    const ref = (await runMailIntake({deps, db, gmail: fakeGmail([mail({threadId: 'thr-5'})]).client})).tickets[0]!;
    const ticket = (await deps.store.getTicket(ref))!;
    const direct = await addCustomerReply(deps, ticket, 'Direct from the site.');
    assert.equal(direct.ok, true);
  });
});
