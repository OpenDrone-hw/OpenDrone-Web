import assert from 'node:assert/strict';
import {beforeEach, describe, it} from 'node:test';
import {_resetGmailToken, createGmailClient, gmailScopes, signAssertion, toMailMessage, type GmailClient} from './mail-gmail.ts';
import {
  authenticated,
  classify,
  cleanSubject,
  guessTopic,
  orderNumberIn,
  parseAddress,
  stripQuoted,
  bodyText,
  type MailConfig,
  type MailMessage,
} from './mail-parse.ts';
import {_resetModCache} from './moderation.ts';
import {gmailQuery, headsUp, mailConfig, mailIntakeMode, mailIntakeReady, runMailIntake, type MailEnv} from './mail.ts';
import {UNVERIFIED_LINE, draftMessage, encodeWords, replySubject} from './mail-draft.ts';
import {createStore} from './store.ts';
import type {Deps, SupportEnv} from './tickets.ts';
import {fakeChatFpv, fakeDiscord, testD1} from './testing.ts';
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
    ['DMARC fail under p=reject', {headers: {'authentication-results': 'mx.google.com; dmarc=fail (p=REJECT sp=REJECT dis=NONE) header.from=example.com'}}, 'spoofed'],
    ['DMARC fail under p=quarantine', {headers: {'authentication-results': 'mx.google.com; dkim=pass header.i=@example.com; dmarc=fail (p=QUARANTINE sp=NONE dis=NONE) header.from=example.com'}}, 'spoofed'],
    ['no from', {headers: {from: ''}}, 'no_sender'],
  ];
  for (const [name, over, reason] of cases) {
    it(`drops ${name}`, () => {
      const v = classify(mail(over), CFG);
      assert.equal(v.ok, false);
      assert.equal(v.ok === false && v.reason, reason);
    });
  }

  it('lets the allow list lift automation heuristics but not the deny list, own domains or the spoof check', () => {
    const allow: MailConfig = {...CFG, allow: ['noreply@partner.example', '@list.example'], deny: ['bad.example']};
    assert.equal(classify(mail({headers: {from: 'noreply@partner.example'}}), allow).ok, true);
    assert.equal(classify(mail({headers: {from: 'x@list.example', 'list-unsubscribe': '<x>'}}), allow).ok, true);
    assert.equal(classify(mail({headers: {from: 'a@bad.example'}}), {...allow, allow: ['a@bad.example']}).ok, false);
    const spoof = mail({headers: {from: 'noreply@partner.example', 'authentication-results': 'mx.google.com; dmarc=fail (p=REJECT) header.from=partner.example'}});
    assert.equal(classify(spoof, allow).ok, false);
  });

  it('keeps genuine customers that fail authentication, flagged unverified', () => {
    // A DKIM-delegated sender (gappssmtp.com signs, no DMARC for the domain, no aligned pass).
    const delegated = mail({headers: {from: 'Jan <jan@customer-shop.example>', 'authentication-results': 'mx.google.com; dkim=pass header.i=@customer-shop-example.20230601.gappssmtp.com header.s=20230601; spf=pass smtp.mailfrom=bounce@gappssmtp.com'}});
    const v = classify(delegated, CFG);
    assert.equal(v.ok && v.verified, false);
    // Mail our own group relayed: group headers, DMARC fail for the customer's domain.
    const relayed = mail({headers: {from: 'Jan <jan@example.com>', to: 'support@incutec.eu', 'x-google-group-id': '123', 'mailing-list': 'list support@incutec.eu; contact support+owners@incutec.eu', 'list-id': '<support.incutec.eu>', precedence: 'list', 'authentication-results': 'mx.google.com; dmarc=fail (p=REJECT sp=REJECT dis=NONE) header.from=example.com'}});
    const r = classify(relayed, {...CFG, addresses: ['support@incutec.eu']});
    assert.equal(r.ok && r.verified, false);
    // The same DMARC failure with no group headers is a spoof.
    const direct = mail({headers: {to: 'support@incutec.eu', 'authentication-results': 'mx.google.com; dmarc=fail (p=REJECT sp=REJECT dis=NONE) header.from=example.com'}});
    assert.equal(classify(direct, {...CFG, addresses: ['support@incutec.eu']}).ok, false);
    // Unverified mail still goes through every other filter.
    for (const over of [{headers: {from: 'noreply@x.example', 'authentication-results': ''}}, {headers: {to: 'other@else.example', 'authentication-results': ''}}, {headers: {'authentication-results': '', 'auto-submitted': 'auto-generated'}}, {headers: {from: 'a@incutec.eu', 'authentication-results': ''}}] as Array<Parameters<typeof mail>[0]>) {
      assert.equal(classify(mail(over), CFG).ok, false);
    }
    assert.equal(classify(mail({headers: {'authentication-results': ''}}), CFG).ok && true, true);
  });

  it('reads the sender from From only and accepts delivery headers', () => {
    const viaGroup = mail({headers: {from: 'Jan Peeters via Support <support@incutec.eu>', 'x-original-sender': 'jan@example.com', to: 'support@incutec.eu'}});
    assert.equal(classify(viaGroup, {...CFG, addresses: ['support@incutec.eu']}).ok, false, 'own-domain From: X-Original-Sender is not read');
    const delivered = mail({headers: {to: 'undisclosed-recipients:;', 'delivered-to': 'hello@opendrone.be'}});
    assert.equal(classify(delivered, CFG).ok, true);
  });

  it('does not count x-forwarded-for as addressing', () => {
    assert.equal(classify(mail({headers: {to: 'other@else.example', 'x-forwarded-for': 'contact@opendrone.be'}}), CFG).ok, false);
  });

  const auth = (value: string | null, from = 'jan@example.com') => authenticated(mail({headers: {'authentication-results': value ?? ''}}), from.split('@')[1]!);

  it('judges authentication by Gmail\'s topmost result: DMARC with header.from, else an aligned DKIM or SPF pass', () => {
    assert.equal(auth('mx.google.com; dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=example.com'), true);
    assert.equal(auth('mx.google.com; dmarc=pass (p=NONE) header.from=other.example'), false, 'header.from must be the From domain');
    assert.equal(auth('mx.google.com; dmarc=pass'), false, 'a DMARC pass without header.from is not trusted');
    assert.equal(auth('mx.google.com; dkim=pass; dmarc=fail (p=NONE) header.from=example.com'), false);
    assert.equal(auth('mx.google.com; dkim=pass header.i=@example.com header.s=x'), true);
    assert.equal(auth('mx.google.com; dkim=pass header.d=mail.example.com'), true);
    assert.equal(auth('mx.google.com; spf=pass (google.com: domain of jan@example.com designates 1.2.3.4 as permitted sender) smtp.mailfrom=jan@example.com'), true);
    assert.equal(auth(''), false);
  });

  it('fails closed on planted, ARC, foreign or unaligned results', () => {
    // A sender-planted header below Gmail's real result is never read.
    const planted = mail({headers: {'authentication-results': 'mx.google.com; dmarc=fail (p=NONE) header.from=example.com'}});
    planted.headers['authentication-results']!.push('mx.google.com; dmarc=pass header.from=example.com');
    assert.equal(authenticated(planted, 'example.com'), false, 'pass below a fail');
    const plantedFirst = mail();
    plantedFirst.headers['authentication-results'] = ['mail.attacker.example; dmarc=pass header.from=example.com', 'mx.google.com; dmarc=pass header.from=example.com'];
    assert.equal(authenticated(plantedFirst, 'example.com'), false, 'a foreign authserv-id on top is not Gmail');
    assert.equal(auth('mx.google.com; dmarc=pass header.from=example.com; dmarc=fail header.from=example.com'), false);
    // The ARC header itself is ignored.
    const arc = mail();
    arc.headers['authentication-results'] = [];
    arc.headers['arc-authentication-results'] = ['i=1; mx.google.com; dmarc=pass header.from=example.com'];
    assert.equal(authenticated(arc, 'example.com'), false);
    // An attacker-sealed ARC result inside the top result, and no top-level DMARC entry.
    const sealed = 'mx.google.com; dkim=pass header.i=@attacker.example; arc=pass (i=2 spf=pass spf.mailfrom=x dkim=pass dkim.d=x dmarc=pass fromdomain=example.com); spf=pass smtp.mailfrom=bounce@attacker.example';
    assert.equal(auth(sealed), false);
    assert.equal(auth('mx.google.com; arc=pass (i=1); dmarc=pass header.from=example.com; dkim=none') , true, 'a real DMARC pass beside an ARC entry still counts');
    // A comment that tries to smuggle a result, and an arc entry without comment.
    assert.equal(auth('mx.google.com; spf=none (dmarc=pass header.from=example.com dkim=pass header.d=example.com)'), false);
    assert.equal(auth('mx.google.com; arc=pass dmarc=pass header.from=example.com'), false);
    // DKIM or SPF pass for someone else's domain is not the From domain.
    assert.equal(auth('mx.google.com; dkim=pass header.i=@attacker.example'), false);
    assert.equal(auth('mx.google.com; spf=pass smtp.mailfrom=bounce@attacker.example'), false);
    assert.equal(auth('mx.google.com; dkim=pass header.d=notexample.com'), false);
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
    const huge = mail({text: null, html: '<a'.repeat(30_000)});
    const t0 = Date.now();
    bodyText(huge);
    bodyText(mail({text: null, html: '<a href="x" '.repeat(30_000)}));
    bodyText(mail({text: null, html: '<blockquote>'.repeat(30_000)}));
    bodyText(mail({text: null, html: '<<<<<<'.repeat(30_000) + '>'}));
    assert.ok(Date.now() - t0 < 500, 'unclosed tags are scanned in linear time');
    assert.equal(bodyText(mail({text: null, html: `<p>kept</p><script>var x = "<p>drop</p>"</script><p>after</p>${'x'.repeat(100_000)}`})).startsWith('kept\nafter'), true);
    assert.ok(bodyText(mail({text: null, html: 'y'.repeat(200_000)})).length <= 50_000, 'HTML is cut at 50,000 characters');
    const m = mail({text: null, html: '<div>Hello&nbsp;there<br>Is it <b>in stock</b>?</div><blockquote>old &amp; gone</blockquote>'});
    assert.equal(bodyText(m), 'Hello there\nIs it in stock?');
  });

  it('cleans subjects and finds order numbers and topics', () => {
    assert.equal(cleanSubject('Re: Fwd: RE: Hello'), 'Hello');
    assert.equal(orderNumberIn('Question about order #1042'), '#1042');
    assert.equal(orderNumberIn('hi', 'my order number 20871 has not arrived'), '#20871');
    assert.equal(orderNumberIn('Bestelling 20871 is niet aangekomen'), '#20871');
    assert.equal(orderNumberIn('I have 3 drones and 12 motors'), null);
    assert.equal(guessTopic('ESC firmware', 'how do I flash AM32'), 'product');
    assert.equal(guessTopic('Where is my order', 'tracking please'), 'order');
    assert.equal(guessTopic('Broken arm', 'frame arrived broken, order #1042'), 'warranty');
    assert.equal(guessTopic('Hi', 'nice project'), 'other');
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

  it('cuts a long body before decoding and skips oversized parts', () => {
    const b64 = (n: number) => Buffer.from('a'.repeat(n)).toString('base64url');
    const long = toMailMessage({id: 'a', threadId: 't', payload: {mimeType: 'text/plain', body: {data: b64(900_000), size: 900_000}}});
    assert.equal(long.text!.length, 200_000);
    const huge = toMailMessage({id: 'a', threadId: 't', payload: {mimeType: 'text/plain', body: {data: b64(1000), size: 5_000_000}}});
    assert.equal(huge.text, '');
  });

  it('signs a verifiable RS256 assertion and asks for the read-only scope as the mailbox, and compose only when drafting', async () => {
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
    const both = JSON.parse(Buffer.from((await signAssertion(key, 'box@incutec.eu', 1_800_000_000, gmailScopes(true))).split('.')[1]!, 'base64url').toString()) as {scope: string};
    assert.equal(both.scope, 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose');
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
  DISCORD_STAFF_METADATA_CHANNEL_ID: '77',
  DISCORD_GUILD_ID: '7',
  SUPPORT_MODERATION_MODE: 'off',
  SUPPORT_SESSION_SECRET: 'test-secret',
  SHOPIFY_STORE_DOMAIN: 'opendrone-test.myshopify.com',
  SHOPIFY_ADMIN_API_TOKEN: 'shpat_test',
  SUPPORT_MAIL_INTAKE_ENABLED: '1',
  SUPPORT_MAIL_SA_JSON: '{}',
  SUPPORT_MAIL_MAILBOX: 'box@incutec.eu',
  SUPPORT_MAIL_DENY: 'supplier.example',
};

const UNAUTH = 'mx.google.com; dkim=none; spf=none';

let clock = Date.parse('2026-09-01T09:00:00Z');

type Created = {threadId: string; raw: string};

/** A Gmail that lists `inbox` newest first, records every call and keeps the drafts it was asked for. */
function fakeGmail(inbox: MailMessage[], opts: {failDraft?: () => boolean} = {}) {
  const calls = {list: 0, get: [] as string[], queries: [] as string[]};
  const drafts: Created[] = [];
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
    async createDraft(threadId, raw) {
      if (opts.failDraft?.()) throw new Error('gmail /drafts 500');
      drafts.push({threadId, raw});
      return `draft${drafts.length}`;
    },
  };
  return {client, calls, inbox, drafts};
}

/** The decoded RFC 2822 message of a created draft: headers (unfolded) and the plain text body. */
function decode(d: Created): {headers: Record<string, string>; body: string} {
  const msg = Buffer.from(d.raw, 'base64url').toString('utf8');
  const [head, ...rest] = msg.split('\r\n\r\n');
  const headers: Record<string, string> = {};
  for (const line of head!.replace(/\r\n[ \t]+/g, ' ').split('\r\n')) {
    const i = line.indexOf(':');
    headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
  }
  assert.equal(headers['content-transfer-encoding'], 'base64');
  return {headers, body: Buffer.from(rest.join('\r\n\r\n').replace(/\r\n/g, ''), 'base64').toString('utf8').replace(/\r\n/g, '\n')};
}

async function setup(opts: {env?: Partial<SupportEnv & MailEnv>; withChatFpv?: boolean | Parameters<typeof fakeChatFpv>[0]} = {}) {
  const db = (await testD1())!;
  const discord = fakeDiscord({now: () => clock});
  const chatfpv = fakeChatFpv(typeof opts.withChatFpv === 'object' ? opts.withChatFpv : {});
  const urls: string[] = [];
  const deps: Deps = {
    env: {...ENV, ...opts.env},
    store: createStore(db),
    discord: discord.client,
    // Any outbound call from the pass itself (Shopify, mail) is recorded and refused.
    fetcher: (async (url: string) => {
      urls.push(String(url));
      throw new Error('no network in tests');
    }) as unknown as typeof fetch,
    now: () => clock,
    origin: 'https://opendrone.test',
    chatfpv: opts.withChatFpv === false ? undefined : {client: chatfpv.client, drafts: createDraftStore(db)},
  };
  return {deps, db, discord, chatfpv, urls};
}

const posts = (discord: ReturnType<typeof fakeDiscord>) => discord.channelPosts.map((p) => p.content);

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

describe('draft message', () => {
  it('encodes non-ASCII words within 75 characters and never doubles Re:', () => {
    assert.equal(replySubject('Hello'), 'Re: Hello');
    assert.equal(replySubject('RE: Hello'), 'RE: Hello');
    assert.equal(replySubject('re:Hello'), 're:Hello');
    assert.equal(encodeWords('Plain subject'), 'Plain subject');
    const subject = 'Vraag over mijn bestelling: één motor werkt niet meer, kan iemand helpen? 日本語のテスト';
    const encoded = encodeWords(subject);
    for (const word of encoded.split('\r\n ')) assert.ok(word.length <= 75 && /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/.test(word), word);
    const back = encoded
      .split('\r\n ')
      .map((w) => Buffer.from(w.slice(10, -2), 'base64').toString('utf8'))
      .join('');
    assert.equal(back, subject);
  });

  it('builds a threaded plain text reply: To, Subject, In-Reply-To, References, quoted original', () => {
    const m = mail({headers: {from: 'Zoë Müller <zoe@example.com>', subject: 'Vraag: één motor', references: '<a@x> <b@x>', date: 'Tue, 1 Sep 2026 08:50:00 +0000'}});
    const msg = draftMessage({mail: m, reply: 'Hello Zoë,\nLine two.', original: 'Eerste regel\n\nTweede regel', verified: true})!;
    assert.ok(msg.includes('\r\n\r\n') && !/[^\r]\n/.test(msg.split('\r\n\r\n')[0]!));
    const d = decode({threadId: 't', raw: Buffer.from(msg).toString('base64url')});
    assert.match(d.headers.to!, /^=\?UTF-8\?B\?.+\?= <zoe@example\.com>$/);
    assert.equal(d.headers['in-reply-to'], m.headers['message-id']![0]);
    assert.equal(d.headers.references, `<a@x> <b@x> ${m.headers['message-id']![0]}`);
    assert.match(d.headers['content-type']!, /text\/plain; charset=UTF-8/);
    assert.equal(
      d.body,
      'Hello Zoë,\nLine two.\n\nOn Tue, 1 Sep 2026 08:50:00 +0000, Zoë Müller <zoe@example.com> wrote:\n> Eerste regel\n>\n> Tweede regel',
    );
  });

  it('caps the quote at 4000 characters and keeps the draft first', () => {
    const body = draftMessage({mail: mail(), reply: 'Answer.', original: 'x'.repeat(9000), verified: true})!;
    const text = decode({threadId: 't', raw: Buffer.from(body).toString('base64url')}).body;
    assert.ok(text.startsWith('Answer.\n\nOn '));
    assert.ok(text.length < 4300, String(text.length));
  });

  it('puts the check line first for an unauthenticated sender', () => {
    const msg = draftMessage({mail: mail(), reply: 'Answer.', original: 'Hi', verified: false})!;
    const text = decode({threadId: 't', raw: Buffer.from(msg).toString('base64url')}).body;
    assert.ok(text.startsWith(`${UNVERIFIED_LINE}\n\nAnswer.`));
    assert.equal(UNVERIFIED_LINE, '[CHECK BEFORE SENDING: sender not authenticated by the mail system. Delete this line.]');
  });

  it('cannot be header-injected through the subject or sender name', () => {
    const m = mail({headers: {subject: 'Hi\r\nBcc: attacker@evil.example', from: '"Eve\r\nBcc: x@y.z" <eve@example.com>'}});
    const msg = draftMessage({mail: m, reply: 'a', original: 'b', verified: true})!;
    assert.ok(!/^Bcc:/im.test(msg));
  });

  it('addresses only the real sender: never an address from a display name, comment, list or group', () => {
    const to = (from: string) => {
      const msg = draftMessage({mail: mail({headers: {from}}), reply: 'a', original: 'b', verified: true});
      return msg === null ? null : msg.split('\r\n').find((l) => l.startsWith('To: '));
    };
    assert.equal(to('"attacker@evil.example" <jan@example.com>'), 'To: "attacker@evil.example" <jan@example.com>');
    assert.equal(to('jan@example.com (attacker@evil.example)'), 'To: jan@example.com');
    assert.equal(to('<x,attacker@evil.example>'), null);
    assert.equal(to('<group:attacker@evil.example;>'), null);
    assert.deepEqual(parseAddress('"a@evil.example" <jan@example.com>'), {email: 'jan@example.com', name: 'a@evil.example'});
  });

  it('keeps every header line short and only real Message-IDs in the threading headers', () => {
    const m = mail({
      headers: {
        subject: 'x'.repeat(5000),
        from: `${'N'.repeat(500)} <jan@example.com>`,
        'message-id': 'junk Bcc: attacker@evil.example <id@example.com>',
        references: Array.from({length: 500}, (_, i) => `<r${i}@example.com>`).join(' '),
      },
    });
    const msg = draftMessage({mail: m, reply: 'a', original: 'b', verified: true})!;
    const head = msg.slice(0, msg.indexOf('\r\n\r\n')).split('\r\n');
    assert.ok(head.every((l) => l.length < 400), String(Math.max(...head.map((l) => l.length))));
    assert.ok(head.includes('In-Reply-To: <id@example.com>'));
    assert.ok(!msg.includes('attacker@evil.example'));
    assert.ok(head.includes('References: <r0@example.com>'));
    assert.ok(head.includes(' <r499@example.com>'));
    assert.equal(head.filter((l) => /^ <r\d+@example\.com>$/.test(l)).length, 9);
  });
});

describe('mail drafts', {skip}, () => {
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

  it('leaves the mail alone while ChatFPV drafts are not configured', async () => {
    const {deps, db} = await setup({withChatFpv: false});
    const gmail = fakeGmail([mail()]);
    const report = await runMailIntake({deps, db, gmail: gmail.client});
    assert.equal(gmail.calls.list, 0);
    assert.equal(report.drafted, 0);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM support_mail_messages').first<{n: number}>())!.n, 0);
  });

  it('drafts a threaded reply from the ChatFPV draft and tells the staff channel, with no order data to ChatFPV and no Shopify', async () => {
    const {deps, db, discord, chatfpv, urls} = await setup();
    const m = mail({
      threadId: 'thr-1',
      headers: {subject: 'Re: ESC firmware order #1042'},
      text: 'How do I flash AM32 on the ESC from my order 1042? Jan Peeters, jan@example.com\n\nJan\n\nOn Sun, 30 Aug 2026 at 12:00, OpenDrone wrote:\n> old text',
    });
    const gmail = fakeGmail([m]);
    const report = await runMailIntake({deps, db, gmail: gmail.client});
    assert.equal(report.drafted, 1);
    assert.equal(report.unverified, 0);
    assert.equal(gmail.drafts.length, 1);
    assert.equal(gmail.drafts[0]!.threadId, 'thr-1');
    const d = decode(gmail.drafts[0]!);
    assert.equal(d.headers.to, '"Jan Peeters" <jan@example.com>');
    assert.equal(d.headers.subject, 'Re: ESC firmware order #1042');
    assert.equal(d.headers['in-reply-to'], m.headers['message-id']![0]);
    assert.ok(d.body.startsWith('Flash the latest firmware with the configurator'));
    assert.match(d.body, /\n> How do I flash AM32/);
    assert.doesNotMatch(d.body, /old text/);
    assert.doesNotMatch(d.body, /CHECK BEFORE SENDING/);

    assert.equal(chatfpv.drafts.length, 1);
    const asked = JSON.stringify(chatfpv.drafts[0]);
    assert.doesNotMatch(asked, /jan@example\.com|Jan Peeters|#1042|1042/);
    assert.match(asked, /AM32/);
    assert.equal(chatfpv.drafts[0]!.topic, 'product');
    assert.deepEqual(urls, [], 'no Shopify or other outbound call');

    const row = await db.prepare('SELECT outcome, gmail_draft_id, gmail_thread_id FROM support_mail_messages').first<{outcome: string; gmail_draft_id: string; gmail_thread_id: string}>();
    assert.deepEqual({...row}, {outcome: 'drafted', gmail_draft_id: 'draft1', gmail_thread_id: 'thr-1'});
    assert.deepEqual(discord.channelPosts.map((p) => [p.channel, p.content]), [['77', 'Mail: 1 draft reply waiting in Gmail.']]);
    assert.equal(discord.threads.size, 0, 'no ticket, no thread');
  });

  it('still drafts for an unauthenticated sender, flagged on the first line, and counts it in the heads-up', async () => {
    const {deps, db, discord} = await setup();
    const gmail = fakeGmail([mail({headers: {'authentication-results': UNAUTH}}), mail()]);
    const report = await runMailIntake({deps, db, gmail: gmail.client});
    assert.equal(report.drafted, 2);
    assert.equal(report.unverified, 1);
    const flagged = gmail.drafts.map((d) => decode(d).body).filter((b) => b.startsWith(UNVERIFIED_LINE));
    assert.equal(flagged.length, 1);
    assert.deepEqual(posts(discord), ['Mail: 2 draft replies waiting in Gmail (1 sender not authenticated).']);
  });

  it('creates no draft when ChatFPV is unavailable or refuses, retries, then gives up and says so once', async () => {
    const {deps, db, discord} = await setup({withChatFpv: {draft: () => null}});
    const gmail = fakeGmail([mail({text: 'A question ChatFPV cannot answer right now.'})]);
    const reports = [];
    for (let i = 0; i < 4; i++) {
      clock += 60_000;
      reports.push(await runMailIntake({deps, db, gmail: gmail.client}));
    }
    assert.deepEqual(reports.map((r) => [r.noDraft, r.gaveUp]), [[1, 0], [1, 0], [0, 1], [0, 0]]);
    assert.equal(gmail.drafts.length, 0);
    const row = await db.prepare('SELECT outcome, attempts, gmail_draft_id FROM support_mail_messages').first<{outcome: string; attempts: number; gmail_draft_id: string | null}>();
    assert.deepEqual({...row}, {outcome: 'failed', attempts: 3, gmail_draft_id: null});
    assert.deepEqual(posts(discord), ['Mail: 1 mail without a draft.']);
    const charged = await db.prepare(`SELECT COUNT(*) AS n FROM support_find_misses WHERE key LIKE 'mailsender:%'`).first<{n: number}>();
    assert.equal(charged?.n, 0, 'a mail without a draft does not count against the sender');
  });

  it('a Gmail failure is retried and then drafted once', async () => {
    const {deps, db, discord} = await setup();
    let fail = true;
    const gmail = fakeGmail([mail()], {failDraft: () => fail});
    const first = await runMailIntake({deps, db, gmail: gmail.client});
    assert.equal(first.errors, 1);
    assert.equal(first.noDraft, 1);
    assert.equal(posts(discord).length, 0, 'a retrying mail is not announced');
    fail = false;
    clock += 60_000;
    const second = await runMailIntake({deps, db, gmail: gmail.client});
    assert.equal(second.drafted, 1);
    assert.equal(gmail.drafts.length, 1);
    clock += 60_000;
    assert.equal((await runMailIntake({deps, db, gmail: gmail.client})).drafted, 0);
    assert.equal(gmail.drafts.length, 1);
  });

  it('a follow-up in the same Gmail thread gets a fresh draft for the newest message', async () => {
    const {deps, db} = await setup();
    const inbox = fakeGmail([mail({threadId: 'thr-f', text: 'My GPS does not get a fix, what can I try?'})]);
    await runMailIntake({deps, db, gmail: inbox.client});
    clock += 3600_000;
    const second = mail({threadId: 'thr-f', headers: {subject: 'Re: Question'}, text: 'Update: it works outside.\n\n> quoted'});
    inbox.inbox.push(second);
    const report = await runMailIntake({deps, db, gmail: inbox.client});
    assert.equal(report.drafted, 1);
    assert.equal(inbox.drafts.length, 2);
    assert.equal(inbox.drafts[1]!.threadId, 'thr-f');
    assert.equal(decode(inbox.drafts[1]!).headers['in-reply-to'], second.headers['message-id']![0]);
    assert.match(decode(inbox.drafts[1]!).body, /\n> Update: it works outside\./);
  });

  it('is idempotent: a second pass neither fetches nor drafts again', async () => {
    const {deps, db} = await setup();
    const gmail = fakeGmail([mail()]);
    await runMailIntake({deps, db, gmail: gmail.client});
    const fetched = gmail.calls.get.length;
    const again = await runMailIntake({deps, db, gmail: gmail.client});
    assert.equal(again.drafted, 0);
    assert.equal(gmail.calls.get.length, fetched, 'decided messages are skipped before fetching');
    assert.equal(gmail.drafts.length, 1);
  });

  it('dedupes the same Message-ID arriving under another Gmail id', async () => {
    const {deps, db} = await setup();
    const a = mail({headers: {'message-id': '<same@example.com>'}});
    const b = mail({headers: {'message-id': '<same@example.com>'}});
    const gmail = fakeGmail([a, b]);
    const report = await runMailIntake({deps, db, gmail: gmail.client});
    assert.equal(report.drafted, 1);
    assert.equal(gmail.drafts.length, 1);
    const fetched = gmail.calls.get.length;
    await runMailIntake({deps, db, gmail: gmail.client});
    assert.equal(gmail.calls.get.length, fetched, 'the other Gmail copy is remembered and not fetched again');
  });

  it('records dropped mail and counts the reasons without drafting or announcing anything', async () => {
    const {deps, db, discord} = await setup();
    const gmail = fakeGmail([
      mail({headers: {from: 'noreply@shop.example'}}),
      mail({headers: {from: 'rep@supplier.example'}}),
      mail({headers: {from: 'stan@incutec.eu'}}),
      mail({headers: {'list-id': '<news.example>'}}),
      mail({headers: {to: 'other@else.example'}}),
    ]);
    const report = await runMailIntake({deps, db, gmail: gmail.client});
    assert.equal(report.drafted, 0);
    assert.deepEqual(report.ignored, {no_reply_sender: 1, denied: 1, own_domain: 1, newsletter: 1, not_addressed: 1});
    assert.equal(gmail.drafts.length, 0);
    assert.equal(posts(discord).length, 0);
    const second = await runMailIntake({deps, db, gmail: gmail.client});
    assert.equal(second.fetched, 0);
  });

  it('rate-limits one sender per day and drafts at most 5 per pass', async () => {
    const {deps, db} = await setup();
    const inbox = fakeGmail(Array.from({length: 12}, (_, i) => mail({text: `Question number ${i} about the flight controller.`})));
    const first = await runMailIntake({deps, db, gmail: inbox.client});
    assert.equal(first.drafted, 5, 'a pass drafts at most 5 mails');
    assert.equal(first.deferred, 7, 'the rest wait for the next pass');
    let ignoredLimit = 0;
    let total = first.drafted;
    for (let i = 0; i < 4; i++) {
      const r = await runMailIntake({deps, db, gmail: inbox.client});
      total += r.drafted;
      ignoredLimit += r.ignored.sender_limit ?? 0;
    }
    assert.equal(total, 8);
    assert.equal(ignoredLimit, 4);
  });

  it('dry mode classifies and reports but writes and drafts nothing', async () => {
    const {deps, db, discord, chatfpv} = await setup({env: {SUPPORT_MAIL_INTAKE_ENABLED: 'dry'}});
    // A row older than the 30-day prune: dry mode must not delete it either.
    await db
      .prepare(`INSERT INTO support_mail_messages (message_hash, gmail_id, gmail_thread_id, outcome, attempts, received_at, updated_at) VALUES ('old', 'g-old', 't-old', 'ignored', 1, 0, 0)`)
      .run();
    const gmail = fakeGmail([mail(), mail({headers: {from: 'noreply@shop.example'}})]);
    const report = await runMailIntake({deps, db, gmail: gmail.client});
    assert.equal(report.mode, 'dry');
    assert.equal(report.fetched, 2);
    assert.equal(report.eligible, 1);
    assert.equal(report.drafted, 0);
    assert.deepEqual(report.ignored, {no_reply_sender: 1});
    assert.equal(gmail.drafts.length, 0);
    assert.equal(chatfpv.drafts.length, 0);
    assert.equal(posts(discord).length, 0);
    const rows = await db.prepare(`SELECT COUNT(*) AS n FROM support_mail_messages WHERE message_hash != 'old'`).first<{n: number}>();
    assert.equal(rows?.n, 0);
    const old = await db.prepare(`SELECT COUNT(*) AS n FROM support_mail_messages WHERE message_hash = 'old'`).first<{n: number}>();
    assert.equal(old?.n, 1, 'dry mode does not prune');
  });

  it('prunes rows after 30 days', async () => {
    const {deps, db} = await setup();
    const inbox = fakeGmail([mail({headers: {from: 'noreply@shop.example'}}), mail({threadId: 'thr-9'})]);
    await runMailIntake({deps, db, gmail: inbox.client});
    const count = async () => (await db.prepare('SELECT COUNT(*) AS n FROM support_mail_messages').first<{n: number}>())!.n;
    assert.equal(await count(), 2);
    clock += 31 * 24 * 3600_000;
    await runMailIntake({deps, db, gmail: fakeGmail([]).client});
    assert.equal(await count(), 0);
  });

  it('stores no address, subject or body', async () => {
    const {deps, db} = await setup();
    await runMailIntake({deps, db, gmail: fakeGmail([mail({text: 'My secret question about the drone please.'})]).client});
    const dump = JSON.stringify(await db.prepare('SELECT * FROM support_mail_messages').all());
    assert.doesNotMatch(dump, /jan@example\.com|secret question|Question about order|Jan Peeters/);
  });

  it('the heads-up carries counts only and never mentions anyone', () => {
    assert.equal(headsUp({drafted: 0, unverified: 0, gaveUp: 0}), null);
    assert.equal(headsUp({drafted: 2, unverified: 1, gaveUp: 1}), 'Mail: 2 draft replies waiting in Gmail (1 sender not authenticated), 1 mail without a draft.');
    assert.equal(headsUp({drafted: 0, unverified: 0, gaveUp: 3}), 'Mail: 3 mails without a draft.');
  });

  it('the heads-up goes to the staff channel without mentions, and a Discord failure does not fail the pass', async () => {
    const {deps, db} = await setup();
    const sent: Array<[string, string]> = [];
    deps.discord = {...deps.discord, postToChannel: async (c: string, t: string) => {
      sent.push([c, t]);
      throw new Error('discord postChannel 500');
    }} as Deps['discord'];
    const report = await runMailIntake({deps, db, gmail: fakeGmail([mail()]).client});
    assert.equal(report.drafted, 1);
    assert.deepEqual(sent, [['77', 'Mail: 1 draft reply waiting in Gmail.']]);
  });
});

describe('no send', {skip}, () => {
  it('the Gmail client has list, get and createDraft only', () => {
    const client = createGmailClient({SUPPORT_MAIL_SA_JSON: '{}', SUPPORT_MAIL_MAILBOX: 'box@incutec.eu'}, (async () => new Response('{}')) as unknown as typeof fetch, Date.now, {compose: true});
    assert.deepEqual(Object.keys(client).sort(), ['createDraft', 'get', 'list']);
  });

  it('a whole pass over the real client calls only the token endpoint, GET reads and POST .../drafts', async () => {
    _resetGmailToken();
    const pair = await crypto.subtle.generateKey({name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256'}, true, ['sign', 'verify']);
    const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
    const pem = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`;
    const key = JSON.stringify({client_email: 'sa@proj.iam.gserviceaccount.com', private_key: pem});
    const {deps, db} = await setup({env: {SUPPORT_MAIL_SA_JSON: key}});
    const m = mail({threadId: 'thr-net'});
    const calls: Array<{method: string; url: string; scope?: string; body?: string}> = [];
    deps.fetcher = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.startsWith('https://oauth2.googleapis.com/token')) {
        const assertion = new URLSearchParams(String(init?.body)).get('assertion')!;
        const claims = JSON.parse(Buffer.from(assertion.split('.')[1]!, 'base64url').toString()) as {scope: string};
        calls.push({method, url: u, scope: claims.scope});
        return Response.json({access_token: 'tok', expires_in: 3600});
      }
      calls.push({method, url: u, body: init?.body as string | undefined});
      if (method === 'POST') return Response.json({id: 'draft-net'});
      if (u.includes('/messages?')) return Response.json({messages: [{id: m.id, threadId: m.threadId}]});
      return Response.json({
        id: m.id,
        threadId: m.threadId,
        internalDate: String(m.receivedAt),
        payload: {mimeType: 'text/plain', headers: Object.entries(m.headers).map(([name, v]) => ({name, value: v[0]})), body: {data: Buffer.from(m.text!).toString('base64url')}},
      });
    }) as unknown as typeof fetch;

    const report = await runMailIntake({deps, db});
    assert.equal(report.drafted, 1);
    for (const c of calls) {
      assert.doesNotMatch(c.url, /\/send|messages\/send|drafts\/send/, c.url);
      if (c.method === 'GET') assert.match(c.url, /^https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/box%40incutec\.eu\/messages/);
    }
    const writes = calls.filter((c) => c.method !== 'GET' && !c.url.startsWith('https://oauth2.googleapis.com/token'));
    assert.equal(writes.length, 1, 'the only write');
    assert.equal(writes[0]!.method, 'POST');
    assert.equal(writes[0]!.url, 'https://gmail.googleapis.com/gmail/v1/users/box%40incutec.eu/drafts');
    const payload = JSON.parse(writes[0]!.body!) as {message: {threadId: string; raw: string}};
    assert.equal(payload.message.threadId, 'thr-net');
    assert.ok(payload.message.raw.length > 0);
    const token = calls.find((c) => c.scope);
    assert.equal(token?.scope, 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose');
  });

  it('dry mode asks only for the read-only scope and never writes', async () => {
    _resetGmailToken();
    const pair = await crypto.subtle.generateKey({name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256'}, true, ['sign', 'verify']);
    const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
    const key = JSON.stringify({client_email: 'sa@p.iam', private_key: `-----BEGIN PRIVATE KEY-----\n${der}\n-----END PRIVATE KEY-----`});
    const {deps, db} = await setup({env: {SUPPORT_MAIL_SA_JSON: key, SUPPORT_MAIL_INTAKE_ENABLED: 'dry'}});
    const seen: Array<{method: string; scope?: string}> = [];
    deps.fetcher = (async (url: string, init?: RequestInit) => {
      if (String(url).startsWith('https://oauth2.googleapis.com/token')) {
        const assertion = new URLSearchParams(String(init?.body)).get('assertion')!;
        seen.push({method: 'POST', scope: (JSON.parse(Buffer.from(assertion.split('.')[1]!, 'base64url').toString()) as {scope: string}).scope});
        return Response.json({access_token: 'tok', expires_in: 3600});
      }
      seen.push({method: init?.method ?? 'GET'});
      return Response.json({});
    }) as unknown as typeof fetch;
    await runMailIntake({deps, db});
    assert.deepEqual(seen.filter((s) => s.scope).map((s) => s.scope), ['https://www.googleapis.com/auth/gmail.readonly']);
    assert.deepEqual(seen.filter((s) => !s.scope).map((s) => s.method), ['GET']);
  });

  it('a read-only client refuses to draft', async () => {
    const client = createGmailClient({SUPPORT_MAIL_SA_JSON: '{}', SUPPORT_MAIL_MAILBOX: 'box@incutec.eu'}, (async () => new Response('{}')) as unknown as typeof fetch);
    await assert.rejects(() => client.createDraft('t', 'raw'), /compose scope/);
  });
});
