/**
 * Payment webhooks in app mode (COMMERCE_SOURCE=app): POST /api/pay/webhook/:provider. The Worker only triggers the
 * app: it relays the provider and the payment or session id to the app op `storefront.payment_hook`, which refetches
 * the payment from the provider by id. Nothing else of a body is passed on, and no body is ever echoed.
 *
 * Mollie posts form-encoded `id=tr_...` and has no signature (the id alone is useless without the refetch).
 * Stripe is verified with the Stripe-Signature header and STRIPE_WEBHOOK_SECRET. PayPal is verified with PayPal's
 * verify-webhook-signature API (PAYPAL_WEBHOOK_ID_* with the REST app credentials, live and sandbox separately).
 * Answers: 200 accepted (or a verified event we do not act on), 400 bad body or signature, 404 off or unknown
 * provider, 413 too large, 502/503 when the app does not take it (the provider retries).
 */
import {AppUnavailable, appCommerceEnabled, appOp, type AppEnv} from './app-api.ts';

export const MAX_BODY_BYTES = 64 * 1024;
export const STRIPE_TOLERANCE_S = 300;
const STRIPE_EVENTS = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
]);
const PAYPAL_API = {live: 'https://api-m.paypal.com', sandbox: 'https://api-m.sandbox.paypal.com'} as const;
const ID_RE = /^[A-Za-z0-9_-]{3,128}$/;

export type PayHookEnv = Partial<AppEnv> & {
  STRIPE_WEBHOOK_SECRET?: string;
  PAYPAL_WEBHOOK_ID_LIVE?: string;
  PAYPAL_CLIENT_ID_LIVE?: string;
  PAYPAL_CLIENT_SECRET_LIVE?: string;
  PAYPAL_WEBHOOK_ID_SANDBOX?: string;
  PAYPAL_CLIENT_ID_SANDBOX?: string;
  PAYPAL_CLIENT_SECRET_SANDBOX?: string;
};

const reply = (status: number) => new Response(status === 200 ? 'ok' : status === 404 ? 'Not found' : 'error', {status});

/** Constant-time string compare (length is not secret). */
export function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Stripe-Signature `t=<unix>,v1=<hex>[,v1=...]` over `<t>.<raw body>`, within the tolerance. */
export async function verifyStripe(header: string | null, body: string, secret: string, nowMs: number): Promise<boolean> {
  if (!header || !secret) return false;
  let t = '';
  const sigs: string[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't') t = v;
    else if (k === 'v1') sigs.push(v);
  }
  const ts = Number(t);
  if (!/^\d+$/.test(t) || !sigs.length || Math.abs(nowMs / 1000 - ts) > STRIPE_TOLERANCE_S) return false;
  const want = await hmacHex(secret, `${t}.${body}`);
  return sigs.reduce((ok, s) => safeEqual(s, want) || ok, false);
}

type PayPalEvent = {event_type?: string; resource?: {id?: string; supplementary_data?: {related_ids?: {order_id?: string}}}};

/** The PayPal order id an event is about, or null for an event we do not act on. */
export function paypalOrderId(ev: PayPalEvent): string | null {
  const r = ev.resource;
  if (ev.event_type === 'CHECKOUT.ORDER.APPROVED') return r?.id ?? null;
  if (ev.event_type === 'PAYMENT.CAPTURE.COMPLETED' || ev.event_type === 'PAYMENT.CAPTURE.DENIED') return r?.supplementary_data?.related_ids?.order_id ?? null;
  return null;
}

/** Ask PayPal whether the event is genuine, against each configured environment; true when one says SUCCESS. */
async function verifyPayPal(request: Request, event: unknown, env: PayHookEnv, fetcher: typeof fetch): Promise<boolean> {
  const h = (n: string) => request.headers.get(n) ?? '';
  const fields = {
    auth_algo: h('paypal-auth-algo'),
    cert_url: h('paypal-cert-url'),
    transmission_id: h('paypal-transmission-id'),
    transmission_sig: h('paypal-transmission-sig'),
    transmission_time: h('paypal-transmission-time'),
  };
  if (Object.values(fields).some((v) => !v)) return false;
  const modes = [
    ['live', env.PAYPAL_WEBHOOK_ID_LIVE, env.PAYPAL_CLIENT_ID_LIVE, env.PAYPAL_CLIENT_SECRET_LIVE],
    ['sandbox', env.PAYPAL_WEBHOOK_ID_SANDBOX, env.PAYPAL_CLIENT_ID_SANDBOX, env.PAYPAL_CLIENT_SECRET_SANDBOX],
  ] as const;
  for (const [mode, webhookId, clientId, secret] of modes) {
    if (!webhookId || !clientId || !secret) continue;
    try {
      const base = PAYPAL_API[mode];
      const tok = await fetcher(`${base}/v1/oauth2/token`, {
        method: 'POST',
        headers: {authorization: `Basic ${btoa(`${clientId}:${secret}`)}`, 'content-type': 'application/x-www-form-urlencoded'},
        body: 'grant_type=client_credentials',
      });
      const access = tok.ok ? ((await tok.json()) as {access_token?: string}).access_token : undefined;
      if (!access) continue;
      const res = await fetcher(`${base}/v1/notifications/verify-webhook-signature`, {
        method: 'POST',
        headers: {authorization: `Bearer ${access}`, 'content-type': 'application/json'},
        body: JSON.stringify({...fields, webhook_id: webhookId, webhook_event: event}),
      });
      if (res.ok && ((await res.json()) as {verification_status?: string}).verification_status === 'SUCCESS') return true;
    } catch {
      // try the next environment
    }
  }
  return false;
}

async function readBody(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) return null;
  const text = await request.text();
  return new TextEncoder().encode(text).length > MAX_BODY_BYTES ? null : text;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Handle one provider webhook; the route is a thin call of this. */
export async function handlePayWebhook(
  request: Request,
  provider: string,
  env: PayHookEnv,
  fetcher: typeof fetch = fetch,
  nowMs: number = Date.now(),
): Promise<Response> {
  if (!appCommerceEnabled(env) || !['mollie', 'stripe', 'paypal'].includes(provider)) return reply(404);
  if (request.method !== 'POST') return new Response('Method not allowed', {status: 405, headers: {allow: 'POST'}});
  const body = await readBody(request);
  if (body === null) return reply(413);

  let id: string | null = null;
  if (provider === 'mollie') {
    id = new URLSearchParams(body).get('id');
  } else if (provider === 'stripe') {
    if (!(await verifyStripe(request.headers.get('stripe-signature'), body, env.STRIPE_WEBHOOK_SECRET ?? '', nowMs))) return reply(400);
    const ev = parseJson(body) as {type?: string; data?: {object?: {id?: string}}} | undefined;
    if (!ev || typeof ev !== 'object') return reply(400);
    if (!ev.type || !STRIPE_EVENTS.has(ev.type)) return reply(200); // genuine, nothing for the app to do
    id = ev.data?.object?.id ?? null;
    if (id && !id.startsWith('cs_')) id = null;
  } else {
    const ev = parseJson(body) as PayPalEvent | undefined;
    if (!ev || typeof ev !== 'object' || !(await verifyPayPal(request, ev, env, fetcher))) return reply(400);
    if (!paypalOrderId(ev)) return reply(200);
    id = paypalOrderId(ev);
  }
  if (!id || !ID_RE.test(id) || (provider === 'mollie' && !id.startsWith('tr_'))) return reply(400);

  try {
    const out = await appOp(env as AppEnv, 'storefront.payment_hook', {provider, id}, fetcher);
    return reply(out.ok ? 200 : 502);
  } catch (err) {
    return reply(err instanceof AppUnavailable ? 503 : 502);
  }
}
