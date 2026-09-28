/**
 * opendrone.be account sessions (accounts design section 5): cookie
 * `__Host-od_sid` = 32 random bytes, stored as SHA-256 hex, 30 days
 * sliding, revocable. The hash doubles as the `sid` handed to chatfpv.com.
 */
import {clearCookie, hostCookie, readCookie, type AccountsEnv} from './config.ts';
import {randomToken, seal, sha256Hex, unseal} from './crypto.ts';

export const SESSION_COOKIE = '__Host-od_sid';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Extend the sliding expiry at most once a day. */
const SLIDE_AFTER_MS = 24 * 60 * 60 * 1000;
const COOKIE_VALUE = /^[A-Za-z0-9_-]{43}$/;

export type AccountSession = {
  sid: string;
  accountId: string;
  shopifyGid: string;
  createdAt: number;
  expiresAt: number;
  sealedIdToken: string | null;
  /** Set-Cookie to send when the sliding expiry moved, else null. */
  refreshCookie: string | null;
};

export const sessionCookie = (value: string) => hostCookie(SESSION_COOKIE, value, SESSION_TTL_MS / 1000);
export const clearSessionCookie = () => clearCookie(SESSION_COOKIE);

/** True when the browser sent a well-formed session cookie (no database read). */
export function hasSessionCookie(request: Request): boolean {
  return COOKIE_VALUE.test(readCookie(request, SESSION_COOKIE) ?? '');
}

/** Insert or touch the account for a Shopify customer GID; returns its id. */
export async function upsertAccount(db: D1Database, gid: string, now = Date.now()): Promise<string> {
  await db
    .prepare(
      'INSERT INTO od_accounts (id, shopify_gid, created_at, last_login_at) VALUES (?, ?, ?, ?) ON CONFLICT (shopify_gid) DO UPDATE SET last_login_at = excluded.last_login_at',
    )
    .bind(`oda_${randomToken(16)}`, gid, now, now)
    .run();
  const row = await db.prepare('SELECT id FROM od_accounts WHERE shopify_gid = ?').bind(gid).first<{id: string}>();
  if (!row) throw new Error('account upsert failed');
  return row.id;
}

/** A new session (always a new id: no fixation). Returns the cookie value and sid. */
export async function createSession(
  db: D1Database,
  env: AccountsEnv,
  accountId: string,
  idToken: string,
  now = Date.now(),
): Promise<{cookieValue: string; sid: string}> {
  const cookieValue = randomToken(32);
  const sid = await sha256Hex(cookieValue);
  const sealed = idToken && env.SESSION_ENC_KEY ? await seal(env.SESSION_ENC_KEY, idToken) : null;
  await db
    .prepare('INSERT INTO od_sessions (id_hash, account_id, shopify_id_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(sid, accountId, sealed, now, now + SESSION_TTL_MS)
    .run();
  return {cookieValue, sid};
}

/** The valid session behind the request cookie, sliding its expiry; null otherwise. */
export async function readSession(db: D1Database | undefined, request: Request, now = Date.now()): Promise<AccountSession | null> {
  if (!db) return null;
  const value = readCookie(request, SESSION_COOKIE);
  if (!value || !COOKIE_VALUE.test(value)) return null;
  const sid = await sha256Hex(value);
  const row = await db
    .prepare(
      'SELECT s.account_id, s.shopify_id_token, s.created_at, s.expires_at, a.shopify_gid FROM od_sessions s JOIN od_accounts a ON a.id = s.account_id WHERE s.id_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?',
    )
    .bind(sid, now)
    .first<{account_id: string; shopify_id_token: string | null; created_at: number; expires_at: number; shopify_gid: string}>();
  if (!row) return null;
  let expiresAt = row.expires_at;
  let refreshCookie: string | null = null;
  if (now + SESSION_TTL_MS - expiresAt > SLIDE_AFTER_MS) {
    expiresAt = now + SESSION_TTL_MS;
    await db.prepare('UPDATE od_sessions SET expires_at = ? WHERE id_hash = ? AND revoked_at IS NULL').bind(expiresAt, sid).run();
    refreshCookie = sessionCookie(value);
  }
  return {
    sid,
    accountId: row.account_id,
    shopifyGid: row.shopify_gid,
    createdAt: row.created_at,
    expiresAt,
    sealedIdToken: row.shopify_id_token,
    refreshCookie,
  };
}

export async function revokeSession(db: D1Database, sid: string, now = Date.now()): Promise<void> {
  await db.prepare('UPDATE od_sessions SET revoked_at = ? WHERE id_hash = ? AND revoked_at IS NULL').bind(now, sid).run();
}

/** The Shopify id_token of a session, for the logout hint. */
export async function sessionIdToken(env: AccountsEnv, session: AccountSession): Promise<string | null> {
  if (!session.sealedIdToken || !env.SESSION_ENC_KEY) return null;
  return unseal(env.SESSION_ENC_KEY, session.sealedIdToken);
}

/** An account with no sign-in for this long, and no live session, is deleted (privacy policy "Customer account"). */
export const ACCOUNT_IDLE_MS = 1095 * 24 * 60 * 60 * 1000;

const IDLE_ACCOUNTS =
  'SELECT id FROM od_accounts WHERE last_login_at < ? AND NOT EXISTS (SELECT 1 FROM od_sessions s WHERE s.account_id = od_accounts.id AND s.revoked_at IS NULL AND s.expires_at > ?)';

/**
 * Retention (accounts design section 7): expired codes and dead sessions go,
 * and an account goes 3 years (1095 days) after its last sign-in unless a
 * session is still live (a sliding session keeps an active user signed in
 * without a new sign-in). ChatFPV deletes its pairwise account on the same
 * 1095-day rule, so no erase call is needed here.
 */
export async function purgeExpired(db: D1Database, now = Date.now()): Promise<void> {
  const cutoff = now - ACCOUNT_IDLE_MS;
  await db.batch([
    db.prepare('DELETE FROM oauth_codes WHERE expires_at < ?').bind(now - 60_000),
    db.prepare('DELETE FROM od_sessions WHERE expires_at < ? OR revoked_at < ?').bind(now, now - SLIDE_AFTER_MS),
    db.prepare(`DELETE FROM oauth_codes WHERE account_id IN (${IDLE_ACCOUNTS})`).bind(cutoff, now),
    db.prepare(`DELETE FROM od_sessions WHERE account_id IN (${IDLE_ACCOUNTS})`).bind(cutoff, now),
    db.prepare(`DELETE FROM od_accounts WHERE id IN (${IDLE_ACCOUNTS})`).bind(cutoff, now),
  ]);
}
