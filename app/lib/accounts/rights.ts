/**
 * Data subject rights for shared accounts (accounts design section 7, GDPR
 * table): the erase and export used by the Shopify compliance webhooks and
 * the founder CLI (compliance.ts), and the export/delete buttons on /account. ChatFPV holds only the pairwise
 * `sub`, so every call to it goes by `sub`: `POST /v1/account/erase {sub}`
 * and `GET /v1/account/export?sub=`, with the store key, over the CHATFPV
 * service binding when the Worker has one (ChatFPV refuses them otherwise).
 */
import {chatFpvOrigin} from '../support/chatfpv.ts';
import {accountHeaders, accountsEnabled, notFound, redirectTo, sameOrigin, type AccountsEnv} from './config.ts';
import {pairwiseSub} from './crypto.ts';
import {readSession} from './sessions.ts';

export type RightsEnv = AccountsEnv & {
  CHATFPV?: {fetch: typeof fetch};
  CHATFPV_URL?: string;
  CHATFPV_KEY?: string;
  SHOPIFY_WEBHOOK_SECRET?: string;
};

/** Shopify wants a webhook answer within 5 s; the ChatFPV call gets 4 of them. */
const TIMEOUT_MS = 4000;

type ChatFpvCall = {ok: boolean; status: number; body: unknown};

async function callChatFpv(env: RightsEnv, path: string, init: RequestInit, fetcher?: typeof fetch): Promise<ChatFpvCall> {
  const origin = chatFpvOrigin(env);
  if (!origin || !env.CHATFPV_KEY) return {ok: false, status: 0, body: null};
  const binding = env.CHATFPV;
  const send: typeof fetch = fetcher ?? (binding ? (i, o) => binding.fetch(i, o) : (i, o) => fetch(i, o));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    headers.set('X-ChatFPV-Key', env.CHATFPV_KEY);
    const res = await send(new URL(path, origin).toString(), {...init, headers, signal: controller.signal});
    const body: unknown = res.ok ? await res.json().catch(() => null) : null;
    if (!res.ok) console.warn('[accounts] chatfpv', path.split('?')[0], res.status);
    return {ok: res.ok, status: res.status, body};
  } catch {
    console.warn('[accounts] chatfpv', path.split('?')[0], 'failed');
    return {ok: false, status: 0, body: null};
  } finally {
    clearTimeout(timer);
  }
}

/** The pairwise ChatFPV subject of a Shopify customer GID, or null without the salt. */
export async function chatFpvSub(env: AccountsEnv, gid: string): Promise<string | null> {
  const salt = env.ACCOUNT_PAIRWISE_SALT;
  return salt ? pairwiseSub(salt, gid) : null;
}

export const chatFpvErase = (env: RightsEnv, sub: string, fetcher?: typeof fetch) =>
  callChatFpv(env, '/v1/account/erase', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({sub})}, fetcher);

export const chatFpvExport = (env: RightsEnv, sub: string, fetcher?: typeof fetch) =>
  callChatFpv(env, `/v1/account/export?sub=${encodeURIComponent(sub)}`, {method: 'GET'}, fetcher);

/**
 * Remove every opendrone.be account row of one Shopify customer (account,
 * sessions, OAuth codes, pilot map pin) and erase its ChatFPV history. ChatFPV is called
 * when a local account existed, or always with `alwaysChatFpv` (a queued
 * retry or a founder request, where the local rows may already be gone).
 * `chatfpv` is null when ChatFPV was not called.
 * Idempotent: `sub` is derived from the GID, so a repeat deletes nothing more
 * and erases again by the same `sub`.
 */
export async function redactCustomer(
  env: RightsEnv,
  gid: string,
  fetcher?: typeof fetch,
  alwaysChatFpv = false,
): Promise<{accounts: number; chatfpv: ChatFpvCall | null}> {
  const db = env.SUPPORT_DB;
  let accounts = 0;
  if (db) {
    // The opt-in pilot map pin (README "Owners map") goes whether or not an account row exists.
    await db.prepare('DELETE FROM pilot_map_pins WHERE shopify_gid = ?').bind(gid).run();
    const row = await db.prepare('SELECT id FROM od_accounts WHERE shopify_gid = ?').bind(gid).first<{id: string}>();
    if (row) {
      await db.batch([
        db.prepare('DELETE FROM oauth_codes WHERE account_id = ?').bind(row.id),
        db.prepare('DELETE FROM od_sessions WHERE account_id = ?').bind(row.id),
        db.prepare('DELETE FROM od_accounts WHERE id = ?').bind(row.id),
      ]);
      accounts = 1;
    }
  }
  if (!accounts && !alwaysChatFpv) return {accounts, chatfpv: null};
  // Without the salt no pairwise ChatFPV account can exist: nothing to erase there.
  const sub = await chatFpvSub(env, gid);
  const chatfpv = sub ? await chatFpvErase(env, sub, fetcher) : null;
  return {accounts, chatfpv};
}

/** Everything held about one Shopify customer's shared account, on both sites. */
export async function exportCustomer(env: RightsEnv, gid: string, fetcher?: typeof fetch): Promise<{complete: boolean; data: Record<string, unknown>}> {
  const db = env.SUPPORT_DB;
  let account: {created_at: number; last_login_at: number} | null = null;
  let sessions: {created_at: number; expires_at: number; revoked_at: number | null}[] = [];
  if (db) {
    const row = await db
      .prepare('SELECT id, created_at, last_login_at FROM od_accounts WHERE shopify_gid = ?')
      .bind(gid)
      .first<{id: string; created_at: number; last_login_at: number}>();
    if (row) {
      account = {created_at: row.created_at, last_login_at: row.last_login_at};
      const res = await db
        .prepare('SELECT created_at, expires_at, revoked_at FROM od_sessions WHERE account_id = ? ORDER BY created_at')
        .bind(row.id)
        .all<{created_at: number; expires_at: number; revoked_at: number | null}>();
      sessions = res.results ?? [];
    }
  }
  // No account row: the customer never signed in, was redacted, or was purged
  // after 3 years without sign-in (ChatFPV purges its side on the same rule).
  if (!account) return {complete: true, data: {opendrone: {account, sessions}, chatfpv: null}};
  const sub = await chatFpvSub(env, gid);
  const chatfpv = sub ? await chatFpvExport(env, sub, fetcher) : {ok: false, status: 0, body: null};
  return {
    complete: chatfpv.ok,
    data: {
      opendrone: {account, sessions},
      chatfpv: chatfpv.ok ? chatfpv.body : null,
    },
  };
}

export const HISTORY_NOTICES = ['deleted', 'unavailable', 'confirm'] as const;
export type HistoryNotice = (typeof HISTORY_NOTICES)[number];

const toAccount = (notice: HistoryNotice) => redirectTo(`/account?chatfpv=${notice}`, [], 303);

/**
 * POST /account/chatfpv-history (same Origin, signed in): `intent=export`
 * downloads the signed-in customer's ChatFPV history as JSON;
 * `intent=delete` with `confirm=yes` erases it. The opendrone.be account
 * itself stays; deleting that goes through Shopify (compliance.ts).
 */
export async function accountHistory(request: Request, env: RightsEnv, fetcher?: typeof fetch, now = Date.now()): Promise<Response> {
  if (!accountsEnabled(env)) return notFound();
  if (request.method !== 'POST' || !sameOrigin(request)) return new Response('Forbidden', {status: 403, headers: accountHeaders()});
  const session = await readSession(env.SUPPORT_DB, request, now);
  if (!session) return redirectTo('/account/login?return_to=%2Faccount', [], 303);
  const form = await request.formData().catch(() => null);
  const intent = form?.get('intent');
  const sub = await chatFpvSub(env, session.shopifyGid);
  if (!sub) return toAccount('unavailable');
  if (intent === 'export') {
    const result = await chatFpvExport(env, sub, fetcher);
    if (!result.ok) return toAccount('unavailable');
    return new Response(JSON.stringify(result.body, null, 2), {
      status: 200,
      headers: accountHeaders({
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="chatfpv-history-${new Date(now).toISOString().slice(0, 10)}.json"`,
      }),
    });
  }
  if (intent === 'delete') {
    if (form?.get('confirm') !== 'yes') return toAccount('confirm');
    const result = await chatFpvErase(env, sub, fetcher);
    return toAccount(result.ok ? 'deleted' : 'unavailable');
  }
  return new Response('Bad Request', {status: 400, headers: accountHeaders()});
}
