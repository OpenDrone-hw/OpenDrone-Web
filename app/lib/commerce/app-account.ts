/**
 * Customer accounts in app mode (COMMERCE_SOURCE=app and ACCOUNTS_ENABLED=1): the email is the account: a mailed code and link, no password.
 * The incutec app owns the customer (`storefront.account*`); this file only keeps the opaque session token in a
 * signed HttpOnly cookie and passes it on. The Shopify and ChatFPV account code (app/lib/accounts) is not used here.
 */
import {createCookie} from 'react-router';
import {safeReturnTo} from '../accounts/config.ts';
import {type AppEnv, appCommerceEnabled, appOp, AppUnavailable, cleanLines, readCart, returnOrigin, writeCart} from './app-api.ts';

export type AccountEnv = AppEnv & {ACCOUNTS_ENABLED?: string};

export function appAccountsEnabled(env: Partial<AccountEnv>): boolean {
  return appCommerceEnabled(env) && env.ACCOUNTS_ENABLED === '1';
}

/** 404 for the account pages while app accounts are off. */
export function requireAppAccounts(env: Partial<AccountEnv>): void {
  if (!appAccountsEnabled(env)) throw new Response('Not found', {status: 404});
}

export type AccountAddress = {
  id: string;
  saved: boolean;
  name: string;
  line1: string;
  line2: string;
  postal_code: string;
  city: string;
  country: string;
  phone: string;
};
export type AccountOrder = {
  number: string;
  created: string;
  rail: string;
  payment_mode?: string;
  state: {payment: string; fulfilment: string};
  canceled: boolean;
  /** The total always; the rest is what the app sent for this order (test orders carry the full quote). */
  quote: {
    total_minor: number;
    currency: string;
    subtotal_minor?: number | null;
    shipping_minor?: number | null;
    discount?: {code?: string; minor: number} | null;
    vat_included_minor?: number | null;
    vat_label?: string | null;
    pickup?: boolean | null;
  };
  lines: Array<{title: string; variant_title: string; qty: number; total_minor: number}>;
  ship_address: Omit<AccountAddress, 'id' | 'saved'> | null;
  shipment?: {carrier?: string; tracking_number?: string; tracking_url?: string; eta?: string};
  invoice: {number: string; issued_at: string} | null;
  reorder: {country: string; lines: Array<{variant: string; qty: number; title: string; variant_title: string; available: boolean; unit_minor: number | null}>};
};
export type Marketing = {granted: boolean; at: string | null; source: string | null};
export type Account = {
  email: string;
  since: string;
  orders: AccountOrder[];
  addresses: AccountAddress[];
  /** The profile name, empty when not set. */
  name: string;
  /** Opaque and stable across an email change; what other systems (ChatFPV) key on. Empty until the account is next signed in. */
  customer_id: string;
  marketing: Marketing;
  /** Addresses the account used before; their orders stay in the order list. */
  aliases: string[];
  /** Set once the customer asked to have their data deleted. */
  erasure: {requested_at: string} | null;
};

export function sessionCookie(env: Pick<AppEnv, 'SESSION_SECRET'>) {
  return createCookie('od_app_acct', {
    httpOnly: true,
    path: '/',
    sameSite: 'lax',
    secure: true,
    secrets: [env.SESSION_SECRET],
    maxAge: 60 * 60 * 24 * 30,
  });
}

export async function readSessionToken(request: Request, env: Pick<AppEnv, 'SESSION_SECRET'>): Promise<string | null> {
  const v = await sessionCookie(env).parse(request.headers.get('Cookie'));
  return typeof v === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(v) ? v : null;
}

/** A cookie in the jar means "probably signed in": the header's label; the app decides on every read. */
export function hasSessionCookie(request: Request): boolean {
  return /(?:^|;\s*)od_app_acct=/.test(request.headers.get('Cookie') ?? '');
}

export const clearSession = (env: Pick<AppEnv, 'SESSION_SECRET'>) => sessionCookie(env).serialize('', {maxAge: 0});

export type Read = {account: Account | null; clear: boolean; down: boolean};

/** The signed-in customer, or none. `clear` says the cookie is stale (the app no longer knows the session). */
export async function readAccount(request: Request, env: AccountEnv, fetcher: typeof fetch = fetch): Promise<Read> {
  const token = await readSessionToken(request, env);
  if (!token) return {account: null, clear: hasSessionCookie(request), down: false};
  try {
    const out = await appOp<Account>(env, 'storefront.account', {session: token}, fetcher);
    if (out.ok && out.data) return {account: out.data, clear: false, down: false};
    return {account: null, clear: out.error?.code === 'unauthenticated', down: false};
  } catch (err) {
    if (err instanceof AppUnavailable) return {account: null, clear: false, down: true};
    throw err;
  }
}

/** The page the mailed link opens: /account/verify, which sends the browser on to `returnTo`. */
export function verifyUrl(request: Request, returnTo: string, dev = false): string {
  const origin = returnOrigin(new URL(request.url).origin, dev);
  return `${origin}/account/verify?return_to=${encodeURIComponent(safeReturnTo(returnTo))}`;
}

/** Ask for a link by address, or (the order status page) for the address of the buyer's own order. The app answers the
 *  same ok whether or not it sent anything. False: the app could not be reached or refused the request. */
export async function requestLink(
  env: AppEnv,
  who: {email: string} | {number: string; token: string},
  linkBase: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const out = await appOp(env, 'storefront.account_link', {...who, link_base: linkBase}, fetcher);
    return out.ok;
  } catch (err) {
    if (err instanceof AppUnavailable) return false;
    throw err;
  }
}

/** Spend a link: the session token, or null when the link is used up or expired. */
export async function verifyLink(env: AppEnv, token: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  const out = await appOp<{session: string}>(env, 'storefront.account_verify', {token}, fetcher);
  return out.ok && out.data ? out.data.session : null;
}

/** Spend the six-digit code of a sign-in mail: the session token, or null for any wrong, expired or used-up code. */
export async function verifyCode(env: AppEnv, email: string, code: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  const out = await appOp<{session: string}>(env, 'storefront.account_verify_code', {email, code}, fetcher);
  return out.ok && out.data ? out.data.session : null;
}

export const PAYMENT_WORDS: Record<string, string> = {
  none: 'Not paid',
  pending_async: 'Payment pending',
  paid: 'Paid',
  failed: 'Payment failed',
  partially_refunded: 'Partly refunded',
  refunded: 'Refunded',
};

export type OrderRow = {key: string; label: string; value: number | 'Free'; minus?: boolean};

/** The rows between the lines and the total of an order card, only from what the app sent: Subtotal, Discount, Shipping,
 *  and the VAT line (the order's own label). Nothing is invented: an order with only a total has no rows. */
export function orderBreakdown(q: AccountOrder['quote']): OrderRow[] {
  const rows: OrderRow[] = [];
  if (q.subtotal_minor == null) return rows;
  rows.push({key: 'subtotal', label: 'Subtotal', value: q.subtotal_minor});
  if (q.discount && q.discount.minor > 0) rows.push({key: 'discount', label: q.discount.code ? `Discount (${q.discount.code})` : 'Discount', value: q.discount.minor, minus: true});
  if (q.shipping_minor != null) rows.push({key: 'shipping', label: q.pickup ? 'Pickup at our Leuven office' : 'Shipping', value: q.shipping_minor === 0 ? 'Free' : q.shipping_minor});
  return rows;
}

/** The one status word of an order in the list. */
export function orderStatus(o: Pick<AccountOrder, 'state' | 'canceled' | 'payment_mode' | 'shipment'>): string {
  if (o.canceled) return 'Canceled';
  if (o.shipment?.tracking_number || o.state.fulfilment === 'fulfilled') return 'Shipped';
  if (o.payment_mode === 'none') return 'Test order, not paid';
  return PAYMENT_WORDS[o.state.payment] ?? o.state.payment;
}

// ---- Route logic (the /account pages) ----

const NO_STORE = {'Cache-Control': 'no-store'};

/** Same-origin browser POST; anything else is refused before the app is called. */
export function postOk(request: Request): boolean {
  return request.method === 'POST' && request.headers.get('Origin') === new URL(request.url).origin;
}

export type LoginResult = {sent: boolean; email: string; problem: string | null};

/** POST /account/login: mail a code and a link to the address in the form. Never says whether the address has orders. */
export async function sendLinkAction(request: Request, env: AccountEnv, dev = false): Promise<LoginResult> {
  const form = await request.formData();
  const email = String(form.get('email') ?? '').trim();
  if (!postOk(request)) return {sent: false, email, problem: 'Something went wrong. Reload the page and try again.'};
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) return {sent: false, email, problem: 'Enter a valid email address.'};
  const ok = await requestLink(env, {email}, verifyUrl(request, String(form.get('return_to') ?? '/account'), dev));
  return ok ? {sent: true, email, problem: null} : {sent: false, email, problem: 'Sign-in is not available right now. Try again in a minute.'};
}

/** POST /account/login with intent=code: spend the six digits, set the session cookie, go on. A wrong code stays on the
 *  code step with one sentence; the app answers the same for every reason, so this does too. */
export async function codeAction(request: Request, env: AccountEnv): Promise<Response | LoginResult> {
  const form = await request.formData();
  const email = String(form.get('email') ?? '').trim();
  const code = String(form.get('code') ?? '').replace(/\s/g, '');
  if (!postOk(request)) return {sent: true, email, problem: 'Something went wrong. Reload the page and try again.'};
  if (!/^[0-9]{6}$/.test(code)) return {sent: true, email, problem: 'Enter the 6 digits from the mail.'};
  let session: string | null;
  try {
    session = await verifyCode(env, email, code);
  } catch (err) {
    if (err instanceof AppUnavailable) return {sent: true, email, problem: 'Sign-in is not available right now. Try again in a minute.'};
    throw err;
  }
  if (!session) return {sent: true, email, problem: 'That code did not work. It may have expired or been used. Check the latest mail, or go back and ask for a new one.'};
  const to = safeReturnTo(String(form.get('return_to') ?? '/account'));
  return new Response(null, {status: 303, headers: {...NO_STORE, Location: to, 'Set-Cookie': await sessionCookie(env).serialize(session)}});
}

/** GET /account/invoices/<order>: the stored invoice of one of the signed-in customer's orders, as the page that was mailed. */
export async function invoiceRoute(request: Request, env: AccountEnv, number: string): Promise<Response> {
  const token = await readSessionToken(request, env);
  if (!token || !/^[A-Za-z0-9._-]{1,20}$/.test(number)) return new Response('Not found', {status: 404, headers: NO_STORE});
  try {
    const out = await appOp<{html: string; filename: string}>(env, 'storefront.account_invoice', {session: token, number});
    if (!out.ok || !out.data) return new Response('Not found', {status: 404, headers: NO_STORE});
    const name = out.data.filename.replace(/[^A-Za-z0-9._-]/g, '_');
    return new Response(out.data.html, {
      headers: {
        ...NO_STORE,
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': `inline; filename="${name}"`,
        'Content-Security-Policy': "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; sandbox",
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      },
    });
  } catch (err) {
    if (err instanceof AppUnavailable) return new Response('The invoice cannot be reached right now.', {status: 503, headers: NO_STORE});
    throw err;
  }
}

/** POST /account/reorder: add the available lines of one past order to the cart, then show the cart. */
export async function reorderRoute(request: Request, env: AccountEnv): Promise<Response> {
  if (!postOk(request)) return new Response('Forbidden', {status: 403, headers: NO_STORE});
  const form = await request.formData();
  const number = String(form.get('number') ?? '');
  const {account} = await readAccount(request, env);
  const order = account?.orders.find((o) => o.number === number);
  if (!order) return new Response(null, {status: 303, headers: {...NO_STORE, Location: '/account'}});
  const add = order.reorder.lines.filter((l) => l.available).map((l) => ({variant: l.variant, qty: l.qty}));
  const lines = cleanLines([...(await readCart(request, env)), ...add]);
  return new Response(null, {status: 303, headers: {...NO_STORE, Location: '/shop/cart', 'Set-Cookie': await writeCart(lines, env)}});
}

/** GET /account/verify?token&return_to: spend the link, set the session cookie, go on. */
export async function verifyRoute(request: Request, env: AccountEnv): Promise<Response | {expired: true}> {
  const url = new URL(request.url);
  const token = url.searchParams.get('token') ?? '';
  const to = safeReturnTo(url.searchParams.get('return_to') ?? '/account');
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return {expired: true};
  let session: string | null;
  try {
    session = await verifyLink(env, token);
  } catch (err) {
    if (err instanceof AppUnavailable) return {expired: true};
    throw err;
  }
  if (!session) return {expired: true};
  return new Response(null, {status: 303, headers: {...NO_STORE, Location: to, 'Set-Cookie': await sessionCookie(env).serialize(session)}});
}

/** POST /account/logout: revoke at the app, drop the cookie, return to `return_to` (same-origin path) or the home page. */
export async function logoutRoute(request: Request, env: AccountEnv): Promise<Response> {
  if (!postOk(request)) return new Response('Forbidden', {status: 403, headers: NO_STORE});
  const form = await request.formData().catch(() => new FormData());
  const token = await readSessionToken(request, env);
  if (token) {
    try {
      await appOp(env, 'storefront.account_signout', {session: token});
    } catch (err) {
      if (!(err instanceof AppUnavailable)) throw err;
    }
  }
  return new Response(null, {status: 303, headers: {...NO_STORE, Location: safeReturnTo(String(form.get('return_to') ?? '/')), 'Set-Cookie': await clearSession(env)}});
}

/** POST /account/addresses: save, replace or remove one address. */
export async function addressRoute(request: Request, env: AccountEnv): Promise<{problem: string | null}> {
  if (!postOk(request)) return {problem: 'Something went wrong. Reload the page and try again.'};
  const token = await readSessionToken(request, env);
  if (!token) return {problem: 'You are signed out. Sign in again.'};
  const form = await request.formData();
  const f = (k: string) => String(form.get(k) ?? '').trim();
  const remove = f('intent') === 'remove';
  const address = {name: f('name'), line1: f('line1'), line2: f('line2'), postal_code: f('postal_code'), city: f('city'), country: f('country').toUpperCase(), phone: f('phone')};
  try {
    const out = await appOp(env, 'storefront.account_address', {session: token, id: f('id'), remove, ...(remove ? {} : {address})});
    if (out.ok) return {problem: null};
    return {problem: out.error?.code === 'bad_args' ? 'Check the address and phone number, then try again.' : out.error?.detail || 'We could not save the address.'};
  } catch (err) {
    if (err instanceof AppUnavailable) return {problem: 'Your account cannot be reached right now. Try again in a minute.'};
    throw err;
  }
}
