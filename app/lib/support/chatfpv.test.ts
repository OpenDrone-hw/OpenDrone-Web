import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {
  ASK_LIMIT,
  askClientId,
  askEnabled,
  chatFpvOrigin,
  chatFpvWidgetSrc,
  chatFpvWidgetSrcWithProduct,
  cleanCitations,
  createChatFpvClient,
  draftsEnabled,
  dropInternalCitations,
  handleAsk,
  handoffReasonText,
  productHandleFromCitation,
  widgetEnabled,
  type AskResult,
  type ChatFpvEnv,
} from './chatfpv.ts';
import type {Catalog} from '../catalog.ts';
import type {CatalogClient} from '../catalog-client.ts';
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

  it('sends the visitor client id on ask only with the key, and uses the service binding when bound', async () => {
    const s = server(() => Response.json({conversationId: 'c', messageId: 'm', answer: 'Yes.', citations: [], outcome: 'answered', confidence: 0.9}));
    await createChatFpvClient(ENV, s.fetcher).ask('Does the F4 run INAV?', {page: 'support', clientId: 'od_0123456789abcdef'});
    assert.equal(s.calls[0]!.headers.get('X-ChatFPV-Client'), 'od_0123456789abcdef');
    assert.equal(s.calls[0]!.headers.get('X-ChatFPV-Key'), 'store-key');
    await createChatFpvClient({CHATFPV_URL: ENV.CHATFPV_URL}, s.fetcher).ask('Does the F4 run INAV?', {clientId: 'od_0123456789abcdef'});
    assert.equal(s.calls[1]!.headers.get('X-ChatFPV-Client'), null);

    const bound = server(() => Response.json(DRAFT));
    const c = createChatFpvClient({...ENV, CHATFPV: {fetch: bound.fetcher}});
    assert.equal((await c.draft({ticketRef: 'R', topic: 'other', conversation: [{role: 'customer', text: 'hi there'}]}))?.draftId, 'dr_1');
    assert.equal(bound.calls[0]!.url, 'https://chatfpv.test/v1/draft');
  });

  it('derives an opaque, stable client id per IP bucket from the key', async () => {
    const a = await askClientId(ENV, '203.0.113.7');
    assert.match(a!, /^od_[0-9a-f]{32}$/);
    assert.equal(await askClientId(ENV, '203.0.113.7'), a);
    assert.notEqual(await askClientId(ENV, '203.0.113.8'), a);
    assert.notEqual(await askClientId({...ENV, CHATFPV_KEY: 'other'}, '203.0.113.7'), a);
    assert.ok(!a!.includes('203'));
    assert.equal(await askClientId({}, '203.0.113.7'), null);
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

  it('warns once when drafts are switched on but the key or URL is missing', () => {
    const calls: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => calls.push(args);
    try {
      assert.equal(draftsEnabled({CHATFPV_DRAFTS_ENABLED: '1'}), false);
      assert.equal(draftsEnabled({CHATFPV_URL: 'https://chatfpv.test', CHATFPV_DRAFTS_ENABLED: '1'}), false);
    } finally {
      console.warn = original;
    }
    assert.equal(calls.length, 2);
    assert.match(String(calls[0]![0]), /CHATFPV_DRAFTS_ENABLED/);
  });

  it('build the widget address only while the widget flag is on', () => {
    assert.equal(chatFpvWidgetSrc({...ENV, CHATFPV_WIDGET_ENABLED: '0'}, 'product', 'openfc-f4'), null);
    assert.equal(
      chatFpvWidgetSrc({...ENV, CHATFPV_WIDGET_ENABLED: '1'}, 'product', 'openfc-f4'),
      'https://chatfpv.test/embed?mode=opendrone&product=openfc-f4&page=product',
    );
    assert.equal(chatFpvOrigin({CHATFPV_URL: 'https://chatfpv.sales-ee0.workers.dev/'}), 'https://chatfpv.sales-ee0.workers.dev');
  });

  it('overrides the widget product with the selected variant, and passes through unset or invalid src', () => {
    const src = chatFpvWidgetSrc({...ENV, CHATFPV_WIDGET_ENABLED: '1'}, 'product', 'openesc');
    assert.equal(chatFpvWidgetSrcWithProduct(src, 'OpenESC 30x30'), 'https://chatfpv.test/embed?mode=opendrone&product=OpenESC+30x30&page=product');
    assert.equal(chatFpvWidgetSrcWithProduct(src, null), src);
    assert.equal(chatFpvWidgetSrcWithProduct(null, 'OpenESC 30x30'), null);
    assert.equal(chatFpvWidgetSrcWithProduct('not a url', 'OpenESC 30x30'), 'not a url');
  });

  it('maps a ChatFPV handoff reason code to customer text, and a raw code never reaches a customer', () => {
    for (const code of ['order', 'refund', 'return', 'warranty', 'shipping', 'tracking', 'invoice', 'cancel', 'rma', 'where is my', 'store']) {
      const text = handoffReasonText(code);
      assert.ok(text.length > 0);
      assert.notEqual(text, code);
    }
    assert.equal(handoffReasonText('something-new'), handoffReasonText('another-unknown'));
  });

  it('drops a citation into AGENTS.md, CLAUDE.md, production/ or a jig script, keeps everything else', () => {
    const kept = {n: 1, title: 'OpenESC', url: 'https://opendrone.be/products/openesc', source: 'OpenDrone storefront', kind: 'product' as const};
    const out = dropInternalCitations([
      kept,
      {n: 2, title: 'agents', url: 'https://github.com/OpenDrone-hw/OpenDrone-Web/blob/main/AGENTS.md', source: 'repo', kind: 'doc'},
      {n: 3, title: 'claude', url: 'https://github.com/x/y/blob/main/CLAUDE.md', source: 'repo', kind: 'doc'},
      {n: 4, title: 'release', url: 'https://github.com/OpenDrone-hw/OpenESC/blob/main/production/release.md', source: 'repo', kind: 'doc'},
      {n: 5, title: 'jig', url: 'https://github.com/OpenDrone-hw/OpenESC/blob/main/tools/st-link-jig.py', source: 'repo', kind: 'doc'},
    ]);
    assert.deepEqual(out, [kept]);
  });

  it('reads a product handle only from a product-kind citation on the storefront', () => {
    const product = {n: 1, title: 'OpenESC', url: 'https://opendrone.be/products/openesc-30x30', source: 's', kind: 'product' as const};
    assert.equal(productHandleFromCitation(product), 'openesc-30x30');
    assert.equal(productHandleFromCitation({...product, kind: 'doc'}), null);
    assert.equal(productHandleFromCitation({...product, url: 'https://opendrone.be/support'}), null);
    assert.equal(productHandleFromCitation({...product, url: 'not a url'}), null);
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

  it('passes the visitor client id for the IP bucket to ChatFPV', async () => {
    const fake = fakeChatFpv({answer: ANSWER});
    await handleAsk(req({message: 'Does the F4 run INAV?'}, {ip: '2001:db8:9:9::1'}), ASK, fake.client);
    await handleAsk(req({message: 'Does the F4 run INAV?'}, {ip: '2001:db8:9:9::2'}), ASK, fake.client);
    const ids = fake.asks.map((a) => a.context?.clientId);
    assert.match(ids[0]!, /^od_[0-9a-f]{32}$/);
    assert.equal(ids[1], ids[0], 'one /64, one client');
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

  it('answers order, refund and bulk questions from the fixed rules, never asking ChatFPV', async () => {
    const fake = fakeChatFpv({answer: ANSWER});
    const order = await handleAsk(req({message: 'Where is my order? I have no tracking.'}), ASK, fake.client);
    const orderBody = (await read(order)) as Extract<AskResult, {ok: true}>;
    assert.equal(orderBody.ok, true);
    assert.equal(orderBody.answer.handoff, true);
    assert.ok(orderBody.answer.reason && orderBody.answer.reason.length > 0);
    assert.equal(orderBody.answer.url, undefined);

    const bulk = await handleAsk(req({message: 'Can I get a bulk discount for my club?'}), ASK, fake.client);
    const bulkBody = (await read(bulk)) as Extract<AskResult, {ok: true}>;
    assert.equal(bulkBody.answer.handoff, true);
    assert.equal(bulkBody.answer.url, '/wholesale');

    assert.equal(fake.asks.length, 0, 'ChatFPV was never called for a fixed-rule question');
  });

  it('answers a preorder charge/ship timing question from /preorder and the terms, never asking ChatFPV', async () => {
    const fake = fakeChatFpv({answer: ANSWER});
    for (const message of ['How does the preorder work, when am I charged?', 'When will preorders ship?']) {
      const r = await handleAsk(req({message}), ASK, fake.client);
      const body = (await read(r)) as Extract<AskResult, {ok: true}>;
      assert.equal(body.answer.handoff, false);
      assert.equal(body.answer.outcome, 'answered');
      assert.ok(body.answer.citations.some((c) => c.url === '/preorder#questions'));
      assert.ok(body.answer.citations.some((c) => c.url === '/algemene-voorwaarden'));
    }
    assert.equal(fake.asks.length, 0, 'ChatFPV was never called for a preorder timing question');
  });

  it('still hands a refund on a preorder to a ticket, not the preorder info answer', async () => {
    const fake = fakeChatFpv({answer: ANSWER});
    const r = await handleAsk(req({message: 'I want a refund for my preorder.'}), ASK, fake.client);
    const body = (await read(r)) as Extract<AskResult, {ok: true}>;
    assert.equal(body.answer.handoff, true);
  });

  it('shows a low-confidence answered result as uncertain, and a confident one as not', async () => {
    const low = await handleAsk(req({message: 'Does the F4 run INAV?'}), ASK, fakeChatFpv({answer: {...ANSWER, confidence: 0.2}}).client);
    assert.equal(((await read(low)) as Extract<AskResult, {ok: true}>).answer.uncertain, true);
    const high = await handleAsk(req({message: 'Does the F4 run INAV?'}), ASK, fakeChatFpv({answer: ANSWER}).client);
    assert.equal(((await read(high)) as Extract<AskResult, {ok: true}>).answer.uncertain, undefined);
  });

  it('drops an internal-source citation from a ChatFPV answer before it reaches the customer', async () => {
    const withInternal = {
      ...ANSWER,
      citations: [
        {n: 1, title: 'ok', url: 'https://opendrone.be/openesc', source: 's', kind: 'doc' as const},
        {n: 2, title: 'agents', url: 'https://github.com/x/y/blob/main/AGENTS.md', source: 's', kind: 'doc' as const},
      ],
    };
    const r = await handleAsk(req({message: 'Does the F4 run INAV?'}), ASK, fakeChatFpv({answer: withInternal}).client);
    const body = (await read(r)) as Extract<AskResult, {ok: true}>;
    assert.deepEqual(body.answer.citations.map((c) => c.n), [1]);
  });

  it('adds a buy card for a product citation the catalog still carries, none for a handle it does not', async () => {
    const catalogFixture: Catalog = {
      schema: 1,
      generated_at: new Date().toISOString(),
      max_age: 60,
      currency: 'EUR',
      prices_include_vat: true,
      shop_url: 'https://opendrone.be',
      cart_url: 'https://opendrone.be/cart',
      add_url: 'https://opendrone.be/cart/add',
      products: [
        {
          handle: 'openesc',
          title: 'OpenESC',
          family: 'esc',
          description: null,
          url: 'https://opendrone.be/products/openesc',
          images: ['https://cdn.test/openesc.jpg'],
          rating: null,
          variants: [
            {
              sku: 'OPENESC-2020',
              title: '20x20',
              model: '2020',
              options: {Size: '20x20'},
              price: 39.99,
              compare_price: null,
              currency: 'EUR',
              availability: 'in_stock',
              ship_promise: null,
              image: null,
              url: 'https://opendrone.be/products/openesc?Size=20x20',
              cart_add_url: 'https://opendrone.be/cart/add?sku=OPENESC-2020&qty=1',
            },
          ],
        },
      ],
    };
    const catalog: CatalogClient = {get: async () => catalogFixture};
    const withProduct = {
      ...ANSWER,
      citations: [{n: 1, title: 'OpenESC', url: 'https://opendrone.be/products/openesc', source: 'OpenDrone storefront', kind: 'product' as const}],
    };
    const found = await handleAsk(req({message: 'Which ESC should I use?'}), ASK, fakeChatFpv({answer: withProduct}).client, catalog);
    const foundBody = (await read(found)) as Extract<AskResult, {ok: true}>;
    assert.equal(foundBody.answer.products?.length, 1);
    assert.equal(foundBody.answer.products?.[0]!.handle, 'openesc');
    assert.equal(foundBody.answer.products?.[0]!.addToCartHref, 'https://opendrone.be/cart/add?sku=OPENESC-2020&qty=1');

    const withUnknownProduct = {
      ...ANSWER,
      citations: [{n: 1, title: 'OpenMotor', url: 'https://opendrone.be/products/openmotor', source: 'OpenDrone storefront', kind: 'product' as const}],
    };
    const missing = await handleAsk(req({message: 'Which motor should I use?'}), ASK, fakeChatFpv({answer: withUnknownProduct}).client, catalog);
    const missingBody = (await read(missing)) as Extract<AskResult, {ok: true}>;
    assert.equal(missingBody.answer.products, undefined);
  });
});
