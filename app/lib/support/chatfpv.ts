/**
 * The storefront's ChatFPV client (server side only; the key never reaches
 * a browser). Three calls, all behind flags that default off:
 *
 *   draft(req)      POST /v1/draft          a suggested staff answer for a ticket
 *   outcome(req)    POST /v1/draft/outcome  what staff did with that draft
 *   ask(msg, ctx)   POST /v1/chat           the /support "Ask ChatFPV" answer
 *
 * Every call has a 20 s timeout and answers null on any failure (network,
 * timeout, non-2xx, malformed body). It never throws, so a ChatFPV outage
 * can never break a ticket flow. Logs carry ids and status codes only.
 *
 * Everything sent is passed through `scrubForPublic` first; callers build
 * the request without name, email, phone, order data or attachments
 * (ai-drafts.ts `draftRequest`).
 *
 * Calls go through the CHATFPV service binding when the Worker has one.
 * Cloudflare refuses a Worker's fetch to another workers.dev Worker on the
 * same account (error 1042), so the public URL only works from outside it.
 */
import type {ChatAnswer, ChatRequest, Citation, DraftOutcomeRequest, DraftRequest, DraftResponse} from './chatfpv-contract.ts';
import {matchFixedHandoff, matchPreorderInfo} from './ask-rules.ts';
import {checkRateLimit, clientIp} from '../rate-limit.ts';
import {ipBucket} from './limits.ts';
import {scrubForPublic} from './scrubber.ts';
import {byHandle, cartAddUrl, type Catalog} from '../catalog.ts';
import type {CatalogClient} from '../catalog-client.ts';

export type ChatFpvEnv = {
  /** Service binding to the ChatFPV Worker (wrangler [[services]]); used instead of the public fetch when set. */
  CHATFPV?: {fetch: typeof fetch};
  CHATFPV_URL?: string;
  CHATFPV_KEY?: string;
  /** "1": ticket drafts in the Discord thread (ai-drafts.ts). */
  CHATFPV_DRAFTS_ENABLED?: string;
  /** "1": the Ask ChatFPV box on /support and POST /api/support/ask. */
  CHATFPV_ASK_ENABLED?: string;
  /** "1": the ChatFPV iframe widget on product and preorder pages. */
  CHATFPV_WIDGET_ENABLED?: string;
};

export const CHATFPV_TIMEOUT_MS = 20_000;
const MAX_TEXT = 4000;
const MAX_TURNS = 20;

const on = (v: string | undefined) => v?.trim() === '1';
/**
 * True only once every piece drafts need is present. `CHATFPV_DRAFTS_ENABLED`
 * flipped on without the URL or the key would otherwise fail silently
 * (drafts just never appear, with nothing in the logs saying why), so that
 * combination gets one warning here instead.
 */
export function draftsEnabled(env: ChatFpvEnv): boolean {
  if (!on(env.CHATFPV_DRAFTS_ENABLED)) return false;
  if (!env.CHATFPV_URL || !env.CHATFPV_KEY) {
    console.warn('[chatfpv] CHATFPV_DRAFTS_ENABLED is "1" but CHATFPV_URL or CHATFPV_KEY is missing; drafts stay off');
    return false;
  }
  return true;
}
export const askEnabled = (env: ChatFpvEnv) => on(env.CHATFPV_ASK_ENABLED) && Boolean(env.CHATFPV_URL);
export const widgetEnabled = (env: ChatFpvEnv) => on(env.CHATFPV_WIDGET_ENABLED) && Boolean(chatFpvOrigin(env));

/** The https origin of CHATFPV_URL, or null. */
export function chatFpvOrigin(env: ChatFpvEnv): string | null {
  try {
    const u = new URL(env.CHATFPV_URL ?? '');
    return u.protocol === 'https:' || (u.protocol === 'http:' && u.hostname === 'localhost') ? u.origin : null;
  } catch {
    return null;
  }
}

/** The widget iframe address for a page, or null while the widget flag is off. */
export function chatFpvWidgetSrc(env: ChatFpvEnv, page: string, product?: string | null): string | null {
  const origin = widgetEnabled(env) ? chatFpvOrigin(env) : null;
  if (!origin) return null;
  const u = new URL('/embed', origin);
  u.searchParams.set('mode', 'opendrone');
  if (product) u.searchParams.set('product', product);
  u.searchParams.set('page', page);
  return u.toString();
}

/**
 * Overrides `product` on an already-built widget src, e.g. with the title
 * plus the variant selected client-side after the loader ran (the PDP
 * resolves its selected variant from the URL without a loader round-trip;
 * see `shouldRevalidate` in products.$handle.tsx). `src` null or the widget
 * flag off passes through unchanged; an invalid `src` is returned as is.
 */
export function chatFpvWidgetSrcWithProduct(src: string | null | undefined, product: string | null | undefined): string | null {
  if (!src) return null;
  if (!product) return src;
  try {
    const u = new URL(src);
    u.searchParams.set('product', product);
    return u.toString();
  } catch {
    return src;
  }
}

/**
 * product and page go to ChatFPV as context; clientId is sent as
 * X-ChatFPV-Client so ChatFPV rate limits each visitor on its own instead of
 * every visitor behind the storefront's one address.
 */
export type AskContext = {product?: string; page?: string; clientId?: string};

/**
 * A stable, opaque ChatFPV client id for a visitor's IP bucket: SHA-256 of
 * the store key and the bucket, so ChatFPV never sees the address and the
 * id is useless without the key. Null without a key.
 */
export async function askClientId(env: ChatFpvEnv, bucket: string): Promise<string | null> {
  if (!env.CHATFPV_KEY) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`opendrone-ask:${env.CHATFPV_KEY}:${bucket}`));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `od_${hex.slice(0, 32)}`;
}

export type ChatFpvClient = {
  draft(req: DraftRequest): Promise<DraftResponse | null>;
  /**
   * True once ChatFPV settled the outcome: accepted it, or refused it for
   * good (400 invalid, 404 unknown draft, 409 already decided), which a
   * retry would never change. Null on any other failure (retried by the cron).
   */
  outcome(req: DraftOutcomeRequest): Promise<true | null>;
  ask(message: string, context?: AskContext): Promise<ChatAnswer | null>;
};

/** Text for ChatFPV: scrubbed, or null when the scrubber blocks it. */
export function scrubOutbound(text: string): string | null {
  const s = scrubForPublic(text.slice(0, MAX_TEXT));
  return s.blocked ? null : s.content;
}

/** Citations with an http(s) URL only; anything else is dropped. */
export function cleanCitations(raw: unknown): Citation[] {
  if (!Array.isArray(raw)) return [];
  const out: Citation[] = [];
  for (const c of raw as Array<Partial<Citation>>) {
    if (!c || typeof c !== 'object' || typeof c.url !== 'string' || typeof c.title !== 'string') continue;
    let url: URL;
    try {
      url = new URL(c.url);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    out.push({
      n: Number.isFinite(c.n) ? Number(c.n) : out.length + 1,
      title: c.title.slice(0, 200),
      url: url.toString(),
      source: typeof c.source === 'string' ? c.source.slice(0, 100) : '',
      kind: (c.kind ?? 'doc') as Citation['kind'],
      ...(typeof c.version === 'string' ? {version: c.version.slice(0, 40)} : {}),
    });
    if (out.length >= 10) break;
  }
  return out;
}

/**
 * A citation into this workspace's own agent-facing sources rather than
 * customer-facing product or policy pages: AGENTS.md/CLAUDE.md, anything
 * under `production/` (release and jig tooling, e.g. an ST-LINK flashing
 * script), or a filename naming a jig. ChatFPV's knowledge base indexes
 * repository docs for staff drafting; the /support Ask box is customer
 * facing and never shows one of these (baseline iteration 3: 8 of 40
 * answers cited AGENTS.md, production/ or an ST-LINK procedure).
 */
const INTERNAL_CITATION = /(?:^|\/)(?:AGENTS|CLAUDE)\.md(?:[?#]|$)|\/production\/|\bjig\b|st-?link/i;

/** `citations` with every internal-source citation (see INTERNAL_CITATION) removed. */
export function dropInternalCitations(citations: Citation[]): Citation[] {
  return citations.filter((c) => {
    try {
      return !INTERNAL_CITATION.test(new URL(c.url).pathname);
    } catch {
      return !INTERNAL_CITATION.test(c.url);
    }
  });
}

/**
 * Customer-readable text for a ChatFPV handoff reason. ChatFPV's contract
 * sends a short internal code (`worker/src/answer/route.ts` HANDOFF list:
 * "order", "refund", "return", "warranty", "shipping", "tracking",
 * "invoice", "cancel", "rma", "where is my", or the classifier's "store"),
 * never customer wording; showing the bare code above the ticket form was
 * an iteration-2 bug (a customer would see "order"). ask-rules.ts's own
 * fixed-handoff reasons are already customer text and never pass through
 * this map. An unlisted or future code falls back to a generic line
 * instead of a raw code.
 */
const HANDOFF_REASON_TEXT: Record<string, string> = {
  order: 'This needs a look at your order, so here is a ticket.',
  refund: 'Refunds need a ticket so the team can pull up your order.',
  return: 'Returns need a ticket so the team can start the process.',
  warranty: 'Warranty claims need a ticket so the team can check your order.',
  shipping: 'Shipping on a specific order needs a ticket so the team can check it.',
  tracking: 'Tracking needs a ticket so the team can pull up your order.',
  invoice: 'Invoices and receipts need a ticket so the team can pull up your order.',
  cancel: 'Cancelling an order needs a ticket so the team can stop it in time.',
  rma: 'An RMA needs a ticket so the team can start the process.',
  'where is my': 'Order status needs a ticket so the team can pull up your order.',
  store: 'This needs a ticket so the team can help with your order.',
};

export function handoffReasonText(reason: string): string {
  return HANDOFF_REASON_TEXT[reason] ?? 'This needs a ticket so the team can help.';
}

/** An `answered` result below this confidence is shown as uncertain, with
 * the ticket button as the main action instead of a silent take-it-or-leave-it
 * answer (baseline iteration 3: order/refund handoffs at confidence 0.08 to
 * 0.33 were shown as plain answered results with no handoff). */
export const UNCERTAIN_CONFIDENCE = 0.55;

export type AskProductCard = {
  handle: string;
  title: string;
  image: string | null;
  price: {amount: string; currencyCode: string};
  href: string;
  addToCartHref: string | null;
  available: boolean;
};

/** A citation's product handle, from `https://opendrone.be/products/<handle>`
 * (`ChatFPV worker/src/tools/load/storefront.ts` `storefrontUrl`), or null
 * for any other citation kind or URL shape. */
export function productHandleFromCitation(citation: Citation): string | null {
  if (citation.kind !== 'product') return null;
  try {
    const m = /^\/products\/([^/]+)\/?$/.exec(new URL(citation.url).pathname);
    return m ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
}

/**
 * A small buy card per product citation, resolved through the same catalog
 * client every loader uses (Shopify Storefront API, request-cached), never
 * a second fetch path. Up to 3 cards, in citation order, silently skipping
 * a handle the catalog does not carry and a product with no orderable
 * variant. Never throws: a catalog outage just means no cards, not a
 * broken answer.
 */
export async function productCardsFromCitations(citations: Citation[], catalog: CatalogClient): Promise<AskProductCard[]> {
  const handles = [...new Set(citations.map(productHandleFromCitation).filter((h): h is string => Boolean(h)))].slice(0, 3);
  if (!handles.length) return [];
  let data: Catalog;
  try {
    data = await catalog.get();
  } catch {
    return [];
  }
  const cards: AskProductCard[] = [];
  for (const handle of handles) {
    const product = byHandle(data, handle);
    if (!product) continue;
    const variant = product.variants.find((v) => v.availability !== 'sold_out') ?? product.variants[0];
    if (!variant) continue;
    cards.push({
      handle: product.handle,
      title: product.title,
      image: variant.image ?? product.images[0] ?? null,
      price: {amount: variant.price.toFixed(2), currencyCode: variant.currency || data.currency},
      href: product.url || `/products/${product.handle}`,
      addToCartHref: variant.cart_add_url || cartAddUrl(data.add_url, [{sku: variant.sku}]),
      available: variant.availability !== 'sold_out',
    });
  }
  return cards;
}

const confidenceOf = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

function parseDraft(raw: unknown): DraftResponse | null {
  const r = raw as Partial<DraftResponse> | null;
  if (!r || typeof r !== 'object' || typeof r.draftId !== 'string' || !r.draftId) return null;
  if (r.draft !== null && typeof r.draft !== 'string') return null;
  return {
    draftId: r.draftId.slice(0, 100),
    draft: typeof r.draft === 'string' && r.draft.trim() ? r.draft.trim() : null,
    citations: cleanCitations(r.citations),
    confidence: confidenceOf(r.confidence),
    note: typeof r.note === 'string' ? r.note.replace(/\s+/g, ' ').trim().slice(0, 300) : '',
  };
}

const OUTCOMES = new Set(['answered', 'clarify', 'abstain', 'handoff', 'refused']);

function parseAnswer(raw: unknown): ChatAnswer | null {
  const r = raw as Partial<ChatAnswer> | null;
  if (!r || typeof r !== 'object' || typeof r.answer !== 'string' || !OUTCOMES.has(String(r.outcome))) return null;
  return {
    conversationId: typeof r.conversationId === 'string' ? r.conversationId : '',
    messageId: typeof r.messageId === 'string' ? r.messageId : '',
    answer: r.answer.slice(0, 6000),
    citations: cleanCitations(r.citations),
    outcome: r.outcome!,
    confidence: confidenceOf(r.confidence),
    ...(r.handoff && typeof r.handoff === 'object' ? {handoff: {reason: String(r.handoff.reason ?? ''), url: String(r.handoff.url ?? '')}} : {}),
  };
}

export function createChatFpvClient(env: ChatFpvEnv, fetcher?: typeof fetch, opts: {timeoutMs?: number} = {}): ChatFpvClient {
  // The Vite dev server (`npm run dev`, including the support sandbox) has
  // no real service binding: `wrangler.toml`'s [[services]] binds CHATFPV to
  // a local ChatFPV dev worker there, which the sandbox cannot drive or
  // reset, so calls through it can 429 with nothing to say why (the ticket
  // flow then fails silently past the draft step). The same
  // `import.meta.env.DEV` gate other support dev overrides use (discord.ts
  // `discordApiBase`, shopify.ts `adminEndpoint`): a production build folds
  // it to `false`, the minifier drops this branch, and CHATFPV_URL's public
  // origin is used instead, same as any caller outside the Worker.
  const isDevServer = typeof import.meta.env !== 'undefined' && import.meta.env.DEV;
  const binding = isDevServer ? undefined : env.CHATFPV;
  const send: typeof fetch = fetcher ?? (binding ? (input, init) => binding.fetch(input, init) : (input, init) => fetch(input, init));
  const timeoutMs = opts.timeoutMs ?? CHATFPV_TIMEOUT_MS;
  const origin = chatFpvOrigin(env);

  /**
   * `{data}` on a 2xx (data undefined when the body is not JSON), null on
   * any failure. `final` lists non-2xx statuses answered as `{data:
   * undefined, status}` instead of null.
   */
  async function call(
    what: string,
    id: string,
    path: string,
    body: unknown,
    final: number[] = [],
    extra: Record<string, string> = {},
  ): Promise<{data: unknown; status?: number} | null> {
    if (!origin) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await send(new URL(path, origin).toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(env.CHATFPV_KEY ? {'X-ChatFPV-Key': env.CHATFPV_KEY} : {}),
          ...extra,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        console.warn('[chatfpv] call failed', what, id, res.status);
        return final.includes(res.status) ? {data: undefined, status: res.status} : null;
      }
      return {data: await res.json().catch(() => undefined)};
    } catch (err) {
      const reason = err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'network';
      console.warn('[chatfpv] call failed', what, id, reason);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async draft(req) {
      if (!env.CHATFPV_KEY) return null;
      const conversation = req.conversation
        .map((t) => ({role: t.role, text: scrubOutbound(t.text)}))
        .filter((t): t is {role: 'customer' | 'staff'; text: string} => Boolean(t.text))
        .slice(-MAX_TURNS);
      if (!conversation.length) return null;
      const body: DraftRequest = {
        ticketRef: req.ticketRef,
        topic: req.topic,
        ...(req.product ? {product: scrubOutbound(req.product.slice(0, 80)) ?? undefined} : {}),
        ...(req.firmware ? {firmware: scrubOutbound(req.firmware.slice(0, 60)) ?? undefined} : {}),
        conversation,
      };
      return parseDraft((await call('draft', req.ticketRef, '/v1/draft', body))?.data);
    },

    async outcome(req) {
      if (!env.CHATFPV_KEY) return null;
      const finalText = req.finalText === undefined ? undefined : scrubOutbound(req.finalText) ?? '';
      const body: DraftOutcomeRequest = {...req, ...(finalText === undefined ? {} : {finalText})};
      const res = await call('outcome', req.draftId, '/v1/draft/outcome', body, [400, 404, 409]);
      return res === null ? null : true;
    },

    async ask(message, context = {}) {
      const text = scrubOutbound(message);
      if (!text) return null;
      const body: ChatRequest = {
        message: text,
        mode: 'opendrone',
        surface: 'widget',
        stream: false,
        context: {
          ...(context.product ? {product: context.product.slice(0, 80)} : {}),
          ...(context.page ? {page: context.page.slice(0, 80)} : {}),
        },
      };
      const extra: Record<string, string> = context.clientId && env.CHATFPV_KEY ? {'X-ChatFPV-Client': context.clientId} : {};
      return parseAnswer((await call('ask', context.page ?? 'ask', '/v1/chat', body, [], extra))?.data);
    },
  };
}

// --------------------------------------------------------------------------
// POST /api/support/ask
// --------------------------------------------------------------------------

/** Ask ChatFPV requests per IP bucket (an IPv6 client by its /64), per isolate. */
export const ASK_LIMIT = {limit: 20, windowMs: 60 * 60 * 1000} as const;
export const ASK_MAX = 1000;

export type AskResult =
  | {
      ok: true;
      answer: {
        text: string;
        citations: Citation[];
        outcome: ChatAnswer['outcome'];
        handoff: boolean;
        /** Why this handed off, shown above the ticket form instead of a silent swap to it. */
        reason?: string;
        /** Where a handoff points instead of the ticket form, e.g. "/wholesale" for bulk pricing. */
        url?: string;
        /** An `answered` result below UNCERTAIN_CONFIDENCE: shown with a
         *  caution note and the ticket button as the main action, not a
         *  silent take-it-or-leave-it answer. */
        uncertain?: boolean;
        /** Buy cards for a product-kind citation the catalog still carries. */
        products?: AskProductCard[];
      };
    }
  | {ok: false; error: 'forbidden' | 'rate' | 'invalid' | 'unavailable'};

function askJson(body: AskResult, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex'},
  });
}

/**
 * The /support Ask box: same origin only, 20 an hour per IP bucket, then
 * /v1/chat server side (the browser never talks to ChatFPV, so the page
 * CSP needs no connect-src entry). Off unless CHATFPV_ASK_ENABLED is "1".
 */
export async function handleAsk(request: Request, env: ChatFpvEnv, client?: ChatFpvClient, catalog?: CatalogClient): Promise<Response> {
  if (!askEnabled(env)) return askJson({ok: false, error: 'unavailable'}, 404);
  const origin = request.headers.get('Origin');
  if (request.method !== 'POST' || origin === null || origin !== new URL(request.url).origin) {
    return askJson({ok: false, error: 'forbidden'}, 403);
  }
  const bucket = ipBucket(clientIp(request));
  if (!checkRateLimit(`chatfpv:ask:${bucket}`, ASK_LIMIT.limit, ASK_LIMIT.windowMs).allowed) {
    return askJson({ok: false, error: 'rate'}, 429);
  }
  let body: {message?: unknown; product?: unknown};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return askJson({ok: false, error: 'invalid'}, 400);
  }
  const message = typeof body.message === 'string' ? body.message.replace(/\s+/g, ' ').trim() : '';
  if (message.length < 3 || message.length > ASK_MAX) return askJson({ok: false, error: 'invalid'}, 400);
  const product = typeof body.product === 'string' && /^[\w .'-]{1,80}$/.test(body.product) ? body.product : undefined;

  // Order status, refunds, warranty, damage and bulk pricing route on fixed
  // keywords before ChatFPV ever sees the question: a model can misjudge
  // the wording, and every one of these needs a human on the order anyway
  // (see ask-rules.ts).
  const fixed = matchFixedHandoff(message);
  if (fixed) {
    return askJson(
      {
        ok: true,
        answer: {text: '', citations: [], outcome: 'handoff', handoff: true, reason: fixed.reason, ...(fixed.url ? {url: fixed.url} : {})},
      },
      200,
    );
  }

  // A preorder charge- or ship-timing question: published on /preorder and
  // in the terms, not a ticket matter. Checked after the fixed handoffs
  // above (a real refund or cancellation on a preorder still needs a
  // ticket) and before ChatFPV, whose own store-handoff routing treats any
  // "preorder" mention as an order question (ask-rules.ts).
  const info = matchPreorderInfo(message);
  if (info) {
    return askJson({ok: true, answer: {text: info.text, citations: info.citations, outcome: 'answered', handoff: false}}, 200);
  }

  const clientId = await askClientId(env, bucket);
  const answer = await (client ?? createChatFpvClient(env)).ask(message, {
    page: 'support',
    ...(product ? {product} : {}),
    ...(clientId ? {clientId} : {}),
  });
  if (!answer) return askJson({ok: false, error: 'unavailable'}, 502);
  const handoff = answer.outcome === 'handoff' || answer.outcome === 'abstain' || Boolean(answer.handoff);
  const citations = dropInternalCitations(answer.citations);
  const uncertain = !handoff && answer.outcome === 'answered' && answer.confidence < UNCERTAIN_CONFIDENCE;
  const products = !handoff && catalog ? await productCardsFromCitations(citations, catalog) : [];
  return askJson(
    {
      ok: true,
      answer: {
        text: answer.answer,
        citations,
        outcome: answer.outcome,
        handoff,
        ...(handoff && answer.handoff?.reason ? {reason: handoffReasonText(answer.handoff.reason)} : {}),
        ...(handoff && answer.handoff?.url ? {url: answer.handoff.url} : {}),
        ...(uncertain ? {uncertain: true} : {}),
        ...(products.length ? {products} : {}),
      },
    },
    200,
  );
}
