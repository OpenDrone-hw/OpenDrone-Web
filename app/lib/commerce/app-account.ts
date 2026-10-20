/**
 * Customer accounts in app mode (COMMERCE_SOURCE=app and ACCOUNTS_ENABLED=1): a magic sign-in link, no password.
 * The incutec app owns the customer (`storefront.account*`); this file only keeps the opaque session token in a
 * signed HttpOnly cookie and passes it on. The Shopify and ChatFPV account code (app/lib/accounts) is not used here.
 */
import {createCookie} from 'react-router';
import {safeReturnTo} from '../accounts/config.ts';
import {type AppEnv, appCommerceEnabled, appOp, AppUnavailable, returnOrigin} from './app-api.ts';

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
  quote: {total_minor: number; currency: string};
  lines: Array<{title: string; variant_title: string; qty: number; total_minor: number}>;
  ship_address: Omit<AccountAddress, 'id' | 'saved'> | null;
  shipment?: {carrier?: string; tracking_number?: string; tracking_url?: string; eta?: string};
};
export type Account = {email: string; since: string; orders: AccountOrder[]; addresses: AccountAddress[]};

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

export const PAYMENT_WORDS: Record<string, string> = {
  none: 'Not paid',
  pending_async: 'Payment pending',
  paid: 'Paid',
  failed: 'Payment failed',
  partially_refunded: 'Partly refunded',
  refunded: 'Refunded',
};

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

/** POST /account/login: send a link to the address in the form. Never says whether the address has an account. */
export async function sendLinkAction(request: Request, env: AccountEnv, dev = false): Promise<{sent: boolean; email: string; problem: string | null}> {
  const form = await request.formData();
  const email = String(form.get('email') ?? '').trim();
  if (!postOk(request)) return {sent: false, email, problem: 'Something went wrong. Reload the page and try again.'};
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) return {sent: false, email, problem: 'Enter a valid email address.'};
  const ok = await requestLink(env, {email}, verifyUrl(request, String(form.get('return_to') ?? '/account'), dev));
  return ok ? {sent: true, email, problem: null} : {sent: false, email, problem: 'Sign-in is not available right now. Try again in a minute.'};
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
