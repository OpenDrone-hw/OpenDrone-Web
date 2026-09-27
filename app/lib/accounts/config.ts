/**
 * Shared accounts configuration (README "Shared accounts"). Every account
 * route answers 404 (or the legacy /account redirect) unless
 * ACCOUNTS_ENABLED is "1".
 */
import {NO_FRAMING_HEADERS} from '../csp.ts';

export type AccountsEnv = {
  ACCOUNTS_ENABLED?: string;
  ACCOUNTS_TEST_IDP?: string;
  SESSION_SECRET?: string;
  SESSION_ENC_KEY?: string;
  ACCOUNT_PAIRWISE_SALT?: string;
  WIDGET_ASSERTION_KEY?: string;
  CHATFPV_OAUTH_CLIENT_SECRET?: string;
  CHATFPV_OAUTH_REDIRECTS?: string;
  CHATFPV_POST_LOGOUT_REDIRECTS?: string;
  SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID?: string;
  SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_SECRET?: string;
  SHOPIFY_CUSTOMER_ACCOUNT_SHOP_ID?: string;
  SHOPIFY_CUSTOMER_ACCOUNT_ISSUER?: string;
  SUPPORT_DB?: D1Database;
};

/** The one OAuth client (no registry: accounts design section 5). */
export const CHATFPV_CLIENT_ID = 'chatfpv';

export const accountsEnabled = (env: {ACCOUNTS_ENABLED?: string}) => env.ACCOUNTS_ENABLED?.trim() === '1';

/** Hosts where the test identity provider is never honoured, whatever the vars say. */
export const PRODUCTION_HOSTS: ReadonlySet<string> = new Set(['opendrone.be', 'www.opendrone.be']);

/**
 * The only hosts where the test identity provider may run: the staging
 * Worker `opendrone-web-preview` on workers.dev (and its version or alias
 * previews, `<id>-opendrone-web-preview...`) and local development. The
 * production Worker `opendrone-web` also answers on its own workers.dev and
 * preview hosts, so a denylist of opendrone.be alone is not enough.
 */
const STAGING_HOST = 'opendrone-web-preview.sales-ee0.workers.dev';
export function testIdpHost(host: string): boolean {
  if (PRODUCTION_HOSTS.has(host)) return false;
  return host === STAGING_HOST || host.endsWith('-' + STAGING_HOST) || host === 'localhost' || host === '127.0.0.1';
}

/**
 * The test identity provider (and the public /oauth/token it needs for
 * staging E2E) is active only when ACCOUNTS_TEST_IDP is "1" AND the request
 * host is a staging or local host (`testIdpHost`), never opendrone.be, its
 * www host, or the production Worker's workers.dev hosts (accounts contract).
 */
export function testIdpActive(env: AccountsEnv, requestUrl: string | URL): boolean {
  if (!accountsEnabled(env) || env.ACCOUNTS_TEST_IDP?.trim() !== '1') return false;
  return testIdpHost(new URL(requestUrl).hostname.toLowerCase().replace(/\.$/, ''));
}

/**
 * A request that arrived over a service binding (Worker to Worker) rather
 * than from the internet. Cloudflare's edge sets CF-Connecting-IP on every
 * internet request and a client cannot remove it; a binding request carries
 * only the headers its caller set.
 */
export function isBindingRequest(request: Request): boolean {
  return !request.headers.has('cf-connecting-ip');
}

/** Comma-separated exact-match allowlist. */
export function allowlist(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * `return_to` as a same-origin path (`/^\/(?!\/)/`, no backslash or control
 * characters), else "/". Blocks `//evil`, `/\evil` and absolute URLs.
 */
export function safeReturnTo(raw: string | null | undefined): string {
  if (!raw || raw.length > 2048) return '/';
  if (!/^\/(?![/\\])/.test(raw) || raw.includes('\\') || [...raw].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)) return '/';
  try {
    const url = new URL(raw, 'https://opendrone.invalid');
    if (url.origin !== 'https://opendrone.invalid') return '/';
    return url.pathname + url.search + url.hash;
  } catch {
    return '/';
  }
}

/** Response headers for every account and OAuth response: never cached, never framed. */
export function accountHeaders(extra: Record<string, string> = {}): Headers {
  const headers = new Headers({
    'Cache-Control': 'no-store',
    ...NO_FRAMING_HEADERS,
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow',
  });
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return headers;
}

export function notFound(): Response {
  return new Response('Not Found', {status: 404, headers: accountHeaders()});
}

export function redirectTo(location: string, cookies: string[] = [], status = 302): Response {
  const headers = accountHeaders({Location: location});
  for (const c of cookies) headers.append('Set-Cookie', c);
  return new Response(null, {status, headers});
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: accountHeaders({'Content-Type': 'application/json', Pragma: 'no-cache'}),
  });
}

/** A named cookie from the Cookie header. */
export function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** `__Host-` cookie: Secure, Path=/, no Domain, HttpOnly, SameSite=Lax. */
export function hostCookie(name: string, value: string, maxAgeSec: number): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; Secure; SameSite=Lax`;
}

export const clearCookie = (name: string) => hostCookie(name, '', 0);

/** Same-origin browser POST (accounts design section 7, row 4). */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('Origin');
  return origin !== null && origin === new URL(request.url).origin;
}
