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
 */
import type {ChatAnswer, ChatRequest, Citation, DraftOutcomeRequest, DraftRequest, DraftResponse} from './chatfpv-contract.ts';
import {checkRateLimit, clientIp} from '../rate-limit.ts';
import {ipBucket} from './limits.ts';
import {scrubForPublic} from './scrubber.ts';

export type ChatFpvEnv = {
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
export const draftsEnabled = (env: ChatFpvEnv) => on(env.CHATFPV_DRAFTS_ENABLED) && Boolean(env.CHATFPV_URL && env.CHATFPV_KEY);
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

export type AskContext = {product?: string; page?: string};

export type ChatFpvClient = {
  draft(req: DraftRequest): Promise<DraftResponse | null>;
  /** True once ChatFPV accepted the outcome; null on any failure (retried by the cron). */
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

export function createChatFpvClient(env: ChatFpvEnv, fetcher: typeof fetch = fetch, opts: {timeoutMs?: number} = {}): ChatFpvClient {
  const timeoutMs = opts.timeoutMs ?? CHATFPV_TIMEOUT_MS;
  const origin = chatFpvOrigin(env);

  /** `{data}` on a 2xx (data undefined when the body is not JSON), null on any failure. */
  async function call(what: string, id: string, path: string, body: unknown): Promise<{data: unknown} | null> {
    if (!origin) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetcher(new URL(path, origin).toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(env.CHATFPV_KEY ? {'X-ChatFPV-Key': env.CHATFPV_KEY} : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        console.warn('[chatfpv] call failed', what, id, res.status);
        return null;
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
      const res = await call('outcome', req.draftId, '/v1/draft/outcome', body);
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
      return parseAnswer((await call('ask', context.page ?? 'ask', '/v1/chat', body))?.data);
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
  | {ok: true; answer: {text: string; citations: Citation[]; outcome: ChatAnswer['outcome']; handoff: boolean}}
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
export async function handleAsk(request: Request, env: ChatFpvEnv, client?: ChatFpvClient): Promise<Response> {
  if (!askEnabled(env)) return askJson({ok: false, error: 'unavailable'}, 404);
  const origin = request.headers.get('Origin');
  if (request.method !== 'POST' || origin === null || origin !== new URL(request.url).origin) {
    return askJson({ok: false, error: 'forbidden'}, 403);
  }
  if (!checkRateLimit(`chatfpv:ask:${ipBucket(clientIp(request))}`, ASK_LIMIT.limit, ASK_LIMIT.windowMs).allowed) {
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
  const answer = await (client ?? createChatFpvClient(env)).ask(message, {page: 'support', ...(product ? {product} : {})});
  if (!answer) return askJson({ok: false, error: 'unavailable'}, 502);
  return askJson(
    {
      ok: true,
      answer: {
        text: answer.answer,
        citations: answer.citations,
        outcome: answer.outcome,
        handoff: answer.outcome === 'handoff' || answer.outcome === 'abstain' || Boolean(answer.handoff),
      },
    },
    200,
  );
}
