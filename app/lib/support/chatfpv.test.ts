import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {
  ASK_LIMIT,
  askEnabled,
  chatFpvOrigin,
  chatFpvWidgetSrc,
  cleanCitations,
  createChatFpvClient,
  draftsEnabled,
  handleAsk,
  widgetEnabled,
  type AskResult,
  type ChatFpvEnv,
} from './chatfpv.ts';
import {fakeChatFpv} from './testing.ts';

const ENV: ChatFpvEnv = {CHATFPV_URL: 'https://chatfpv.test', CHATFPV_KEY: 'store-key'};

function server(answer: (path: string, body: Record<string, unknown>) => Response | Promise<Response>) {
  const calls: Array<{url: string; headers: Headers; body: Record<string, unknown>}> = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({url, headers: new Headers(init.headers), body});
    return answer(new URL(url).pathname, body);
  }) as unknown as typeof fetch;
  return {calls, fetcher};
}

const DRAFT = {draftId: 'dr_1', draft: 'Use 4.5.1 [1].', citations: [{n: 1, title: 'Docs', url: 'https://docs.test/a', source: 'Docs', kind: 'doc'}], confidence: 0.7, note: 'ok'};

describe('createChatFpvClient', () => {
  it('posts drafts with the store key and scrubs every conversation text', async () => {
    const s = server(() => Response.json(DRAFT));
    const c = createChatFpvClient(ENV, s.fetcher);
    const res = await c.draft({
      ticketRef: 'OD-AAAA-BBBB',
      topic: 'product',
      conversation: [
        {role: 'customer', text: 'mail me at jan@example.com or +32 470 12 34 56'},
        {role: 'staff', text: 'Sure.'},
      ],
    });
    assert.deepEqual(res, {...DRAFT, citations: [{n: 1, title: 'Docs', url: 'https://docs.test/a', source: 'Docs', kind: 'doc'}]});
    assert.equal(s.calls[0]!.url, 'https://chatfpv.test/v1/draft');
    assert.equal(s.calls[0]!.headers.get('X-ChatFPV-Key'), 'store-key');
    const sent = JSON.stringify(s.calls[0]!.body);
    assert.ok(!sent.includes('jan@example.com') && !sent.includes('470'), sent);
  });

  it('answers null on a 5xx, a timeout, a network error and a malformed body, never throws', async () => {
    const fail500 = createChatFpvClient(ENV, server(() => new Response('x', {status: 502})).fetcher);
    assert.equal(await fail500.draft({ticketRef: 'R', topic: 'other', conversation: [{role: 'customer', text: 'hi there'}]}), null);
    assert.equal(await fail500.outcome({draftId: 'd', status: 'approved', decidedBy: 'u'}), null);
    assert.equal(await fail500.ask('what props?'), null);

    const hang = (async (_url: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(Object.assign(new Error('a'), {name: 'AbortError'}))))) as unknown as typeof fetch;
    const slow = createChatFpvClient(ENV, hang, {timeoutMs: 20});
    const started = Date.now();
    assert.equal(await slow.ask('what props?'), null);
    assert.ok(Date.now() - started < 2000);

    const down = createChatFpvClient(ENV, (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch);
    assert.equal(await down.ask('what props?'), null);

    const junk = createChatFpvClient(ENV, server(() => Response.json({nope: true})).fetcher);
    assert.equal(await junk.draft({ticketRef: 'R', topic: 'other', conversation: [{role: 'customer', text: 'hi there'}]}), null);
    assert.equal(await junk.ask('what props?'), null);
  });

  it('counts any 2xx as an accepted outcome, with or without a body', async () => {
    const c = createChatFpvClient(ENV, server(() => new Response(null, {status: 204})).fetcher);
    assert.equal(await c.outcome({draftId: 'd', status: 'replaced', finalText: 'final', decidedBy: 'u'}), true);
  });

  it('asks /v1/chat server side in opendrone mode on the widget surface, not streamed', async () => {
    const s = server(() => Response.json({conversationId: 'c', messageId: 'm', answer: 'Yes [1].', citations: DRAFT.citations, outcome: 'answered', confidence: 0.9}));
    const answer = await createChatFpvClient(ENV, s.fetcher).ask('Does the F4 run INAV?', {page: 'support'});
    assert.equal(answer?.answer, 'Yes [1].');
    assert.equal(s.calls[0]!.url, 'https://chatfpv.test/v1/chat');
    assert.deepEqual(s.calls[0]!.body, {message: 'Does the F4 run INAV?', mode: 'opendrone', surface: 'widget', stream: false, context: {page: 'support'}});
  });

  it('makes no call without a URL, and no draft or outcome call without the key', async () => {
    const s = server(() => Response.json(DRAFT));
    assert.equal(await createChatFpvClient({}, s.fetcher).ask('hello there'), null);
    const keyless = createChatFpvClient({CHATFPV_URL: ENV.CHATFPV_URL}, s.fetcher);
    assert.equal(await keyless.draft({ticketRef: 'R', topic: 'other', conversation: [{role: 'customer', text: 'hi there'}]}), null);
    assert.equal(await keyless.outcome({draftId: 'd', status: 'approved', decidedBy: 'u'}), null);
    assert.equal(s.calls.length, 0);
  });
});

describe('helpers', () => {
  it('keep only http(s) citations', () => {
    const out = cleanCitations([
      {n: 1, title: 'ok', url: 'https://a.test/x', source: 's', kind: 'doc'},
      {n: 2, title: 'bad', url: 'javascript:alert(1)', source: 's', kind: 'doc'},
      {n: 3, title: 'bad', url: 'not a url', source: 's', kind: 'doc'},
      'junk',
    ]);
    assert.deepEqual(out.map((c) => c.n), [1]);
  });

  it('read the flags as exactly "1"', () => {
    assert.equal(draftsEnabled({...ENV, CHATFPV_DRAFTS_ENABLED: '0'}), false);
    assert.equal(draftsEnabled({...ENV, CHATFPV_DRAFTS_ENABLED: '1'}), true);
    assert.equal(askEnabled({...ENV, CHATFPV_ASK_ENABLED: 'true'}), false);
    assert.equal(widgetEnabled({...ENV, CHATFPV_WIDGET_ENABLED: '1'}), true);
    assert.equal(widgetEnabled({CHATFPV_URL: 'ftp://x', CHATFPV_WIDGET_ENABLED: '1'}), false);
  });

  it('build the widget address only while the widget flag is on', () => {
    assert.equal(chatFpvWidgetSrc({...ENV, CHATFPV_WIDGET_ENABLED: '0'}, 'product', 'openfc-f4'), null);
    assert.equal(
      chatFpvWidgetSrc({...ENV, CHATFPV_WIDGET_ENABLED: '1'}, 'product', 'openfc-f4'),
      'https://chatfpv.test/embed?mode=opendrone&product=openfc-f4&page=product',
    );
    assert.equal(chatFpvOrigin({CHATFPV_URL: 'https://chatfpv.sales-ee0.workers.dev/'}), 'https://chatfpv.sales-ee0.workers.dev');
  });
});

describe('POST /api/support/ask', () => {
  const ASK: ChatFpvEnv = {...ENV, CHATFPV_ASK_ENABLED: '1'};
  const ANSWER = {conversationId: 'c', messageId: 'm', answer: 'Yes, INAV 8 supports it [1].', citations: [], outcome: 'answered' as const, confidence: 0.9};
  let ip = 0;
  function req(body: unknown, opts: {origin?: string | null; ip?: string} = {}) {
    const headers = new Headers({'Content-Type': 'application/json', 'CF-Connecting-IP': opts.ip ?? `203.0.113.${++ip}`});
    if (opts.origin !== null) headers.set('Origin', opts.origin ?? 'https://opendrone.be');
    return new Request('https://opendrone.be/api/support/ask', {method: 'POST', headers, body: JSON.stringify(body)});
  }
  const read = async (r: Response) => (await r.json()) as AskResult;

  it('is off (404, no ChatFPV call) unless CHATFPV_ASK_ENABLED is 1', async () => {
    const fake = fakeChatFpv({answer: ANSWER});
    const r = await handleAsk(req({message: 'Does the F4 run INAV?'}), {...ENV, CHATFPV_ASK_ENABLED: '0'}, fake.client);
    assert.equal(r.status, 404);
    assert.equal(fake.asks.length, 0);
  });

  it('rejects cross-origin and origin-less requests', async () => {
    const fake = fakeChatFpv({answer: ANSWER});
    assert.equal((await handleAsk(req({message: 'Does the F4 run INAV?'}, {origin: 'https://evil.test'}), ASK, fake.client)).status, 403);
    assert.equal((await handleAsk(req({message: 'Does the F4 run INAV?'}, {origin: null}), ASK, fake.client)).status, 403);
    assert.equal(fake.asks.length, 0);
  });

  it('allows 20 an hour per IP bucket, one IPv6 /64 counting as one client', async () => {
    const fake = fakeChatFpv({answer: ANSWER});
    for (let i = 0; i < ASK_LIMIT.limit; i++) {
      const r = await handleAsk(req({message: 'Does the F4 run INAV?'}, {ip: `2001:db8:1:2::${i + 1}`}), ASK, fake.client);
      assert.equal(r.status, 200, `request ${i + 1}`);
    }
    const over = await handleAsk(req({message: 'Does the F4 run INAV?'}, {ip: '2001:db8:1:2::ff'}), ASK, fake.client);
    assert.equal(over.status, 429);
    assert.deepEqual(await read(over), {ok: false, error: 'rate'});
    assert.equal(fake.asks.length, ASK_LIMIT.limit);
  });

  it('answers with the text, citations and whether to hand off to a ticket', async () => {
    const ok = await handleAsk(req({message: 'Does the F4 run INAV?', product: 'openfc-f4'}), ASK, fakeChatFpv({answer: ANSWER}).client);
    assert.deepEqual(await read(ok), {ok: true, answer: {text: ANSWER.answer, citations: [], outcome: 'answered', handoff: false}});
    const refund = await handleAsk(req({message: 'I want a refund'}), ASK, fakeChatFpv({answer: {...ANSWER, outcome: 'handoff'}}).client);
    assert.equal(((await read(refund)) as Extract<AskResult, {ok: true}>).answer.handoff, true);
    const down = await handleAsk(req({message: 'Does the F4 run INAV?'}), ASK, fakeChatFpv({answer: null}).client);
    assert.equal(down.status, 502);
    assert.equal((await handleAsk(req({message: 'x'}), ASK, fakeChatFpv({answer: ANSWER}).client)).status, 400);
  });
});
