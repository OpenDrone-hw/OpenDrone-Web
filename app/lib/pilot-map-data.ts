/**
 * Worker side of the pilot map (README "Owners map"): the pins table, the
 * Discord identify-only OAuth, and the short-lived cookies that carry a
 * half-finished sign-up. Pure rules are in pilot-map.ts.
 *
 * What is stored, and when:
 *
 * | Step | Stored |
 * |---|---|
 * | Owner starts "Link Discord" | cookie `__Host-od_pm_oauth` (state, PKCE verifier, customer), 10 min |
 * | Discord answers | cookie `__Host-od_pm_link` (Discord id and name, customer), 1 h; the Discord token is revoked at once, never kept |
 * | Owner ticks consent and places the pin | row in `pilot_map_pins`: customer GID, Discord id and name, grid cell, consent time and version |
 * | Withdrawal, erasure, idle purge, 24 months after the consent | the row is deleted |
 *
 * The clicked point is read, snapped and dropped inside `placePin`: it is
 * never written to the database, a cookie or a log line.
 *
 * `fetch` is injectable so tests run against a fake Discord and Shopify.
 */
import {PAID_STATUSES, readCustomerOrders, type EarlyBirdOrder} from './early-bird.ts';
import type {AdminEnv} from './preorder-fulfilment.ts';
import {accountsEnabled, clearCookie, hostCookie, readCookie, type AccountsEnv} from './accounts/config.ts';
import {PKCE_VALUE, openBlob, pkceChallenge, randomToken, safeEqual, signBlob} from './accounts/crypto.ts';
import {
  PILOT_CONSENT_VERSION,
  PILOT_RETENTION_MS,
  cleanDiscordId,
  cleanDiscordName,
  consentGiven,
  qualifiesAsOwner,
  snapToCell,
  viewFor,
  type PilotView,
  type PinRow,
} from './pilot-map.ts';

export type PilotEnv = AccountsEnv &
  AdminEnv & {
    PILOT_MAP_ENABLED?: string;
    DISCORD_OAUTH_CLIENT_ID?: string;
    DISCORD_OAUTH_CLIENT_SECRET?: string;
    /** Overrides the callback URL registered at Discord; default `<origin>/owners/discord/callback`. */
    DISCORD_OAUTH_REDIRECT?: string;
  };

export const OAUTH_COOKIE = '__Host-od_pm_oauth';
export const LINK_COOKIE = '__Host-od_pm_link';
export const OWNER_COOKIE = '__Host-od_pm_owner';
const OAUTH_LABEL = 'od-pm-oauth';
const LINK_LABEL = 'od-pm-link';
const OWNER_LABEL = 'od-pm-owner';
const OAUTH_TTL_SEC = 600;
const LINK_TTL_SEC = 3600;
const OWNER_TTL_SEC = 3600;
const TIMEOUT_MS = 6000;
const USER_AGENT = 'opendrone-web (https://opendrone.be)';
export const DISCORD_AUTHORIZE = 'https://discord.com/oauth2/authorize';
export const DISCORD_API = 'https://discord.com/api/v10';

/** The whole feature: off unless PILOT_MAP_ENABLED is "1", and it needs accounts and the database. */
export const pilotMapEnabled = (env: Pick<PilotEnv, 'PILOT_MAP_ENABLED' | 'ACCOUNTS_ENABLED' | 'SUPPORT_DB'>): boolean =>
  env.PILOT_MAP_ENABLED?.trim() === '1' && accountsEnabled(env) && Boolean(env.SUPPORT_DB);

/** Discord sign-in is configured (id and secret), else only the dev fake can run. */
export const discordConfigured = (env: PilotEnv): boolean => Boolean(env.DISCORD_OAUTH_CLIENT_ID?.trim() && env.DISCORD_OAUTH_CLIENT_SECRET?.trim());

export const callbackUrl = (env: PilotEnv, origin: string): string => env.DISCORD_OAUTH_REDIRECT?.trim() || `${origin}/owners/discord/callback`;

// ---------------------------------------------------------------- pins

const PIN_COLUMNS = 'cell_id, cell_lat, cell_lon, discord_id, discord_name';

export async function readPins(db: D1Database): Promise<PinRow[]> {
  return (await db.prepare(`SELECT ${PIN_COLUMNS} FROM pilot_map_pins`).all<PinRow>()).results ?? [];
}

export type OwnPin = {discordName: string; cellLat: number; cellLon: number; consentAt: number};

export async function readOwnPin(db: D1Database, gid: string): Promise<OwnPin | null> {
  const row = await db
    .prepare('SELECT discord_name, cell_lat, cell_lon, consent_at FROM pilot_map_pins WHERE shopify_gid = ?')
    .bind(gid)
    .first<{discord_name: string; cell_lat: number; cell_lon: number; consent_at: number}>();
  return row ? {discordName: row.discord_name, cellLat: row.cell_lat, cellLon: row.cell_lon, consentAt: row.consent_at} : null;
}

/** The pins a viewer may see. `qualifiedOwner` is the server's own decision, never the browser's. */
export async function pilotView(db: D1Database, qualifiedOwner: boolean): Promise<PilotView> {
  return viewFor(qualifiedOwner, await readPins(db));
}

/** Withdrawal and erasure: the row is gone when this returns. */
export async function deletePin(db: D1Database, gid: string): Promise<void> {
  await db.prepare('DELETE FROM pilot_map_pins WHERE shopify_gid = ?').bind(gid).run();
}

/** Scheduled: delete pins whose consent is older than the retention. */
export async function purgeOldPins(db: D1Database, now = Date.now()): Promise<void> {
  await db.prepare('DELETE FROM pilot_map_pins WHERE consent_at < ?').bind(now - PILOT_RETENTION_MS).run();
}

export type Link = {gid: string; discordId: string; name: string};

export type PlaceResult = {ok: true} | {ok: false; error: 'not-owner' | 'no-link' | 'consent' | 'position'};

/**
 * Put one owner on the map. Order of checks: owner, Discord link, consent,
 * position. The point is snapped here and only the cell is written.
 */
export async function placePin(
  db: D1Database,
  input: {gid: string; owner: boolean; link: Link | null; form: {lat?: unknown; lon?: unknown; consent?: unknown; age16?: unknown; version?: unknown}},
  now = Date.now(),
): Promise<PlaceResult> {
  const {gid, owner, form} = input;
  if (!owner) return {ok: false, error: 'not-owner'};
  // A pin that exists already keeps its Discord account, so moving or renewing needs no new link.
  let link = input.link && input.link.gid === gid ? input.link : null;
  if (!link) {
    const row = await db
      .prepare('SELECT discord_id, discord_name FROM pilot_map_pins WHERE shopify_gid = ?')
      .bind(gid)
      .first<{discord_id: string; discord_name: string}>();
    link = row ? {gid, discordId: row.discord_id, name: row.discord_name} : null;
  }
  if (!link) return {ok: false, error: 'no-link'};
  if (!consentGiven(form)) return {ok: false, error: 'consent'};
  const cell = snapToCell(form.lat, form.lon);
  if (!cell) return {ok: false, error: 'position'};
  await db
    .prepare(
      `INSERT INTO pilot_map_pins (shopify_gid, discord_id, discord_name, cell_id, cell_lat, cell_lon, consent_at, consent_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (shopify_gid) DO UPDATE SET discord_id = excluded.discord_id, discord_name = excluded.discord_name,
         cell_id = excluded.cell_id, cell_lat = excluded.cell_lat, cell_lon = excluded.cell_lon,
         consent_at = excluded.consent_at, consent_version = excluded.consent_version`,
    )
    .bind(gid, link.discordId, link.name, cell.id, cell.lat, cell.lon, now, PILOT_CONSENT_VERSION)
    .run();
  return {ok: true};
}

// ---------------------------------------------------------------- owner check

/**
 * Whether this customer owns something: a paid, not cancelled order, read
 * from Shopify (the same Admin read as the Early Bird claim). `readOrders`
 * is injectable; local dev passes a mock so it never touches the shared store.
 */
export async function customerIsOwner(
  env: AdminEnv,
  gid: string,
  readOrders: (env: AdminEnv, gid: string) => Promise<EarlyBirdOrder[] | null> = readCustomerOrders,
): Promise<boolean> {
  try {
    return qualifiesAsOwner(await readOrders(env, gid), PAID_STATUSES);
  } catch (error) {
    console.error('pilot map: order read failed:', error instanceof Error ? error.message : 'unknown');
    return false;
  }
}

/** A signed one-hour note that this customer was found to be an owner, so a page view does not ask Shopify each time. */
export async function ownerCookie(env: PilotEnv, gid: string, now = Date.now()): Promise<string | null> {
  if (!env.SESSION_SECRET) return null;
  const token = await signBlob(env.SESSION_SECRET, OWNER_LABEL, {g: gid, exp: Math.floor(now / 1000) + OWNER_TTL_SEC});
  return hostCookie(OWNER_COOKIE, token, OWNER_TTL_SEC);
}

export async function ownerCookieValid(env: PilotEnv, request: Request, gid: string, now = Date.now()): Promise<boolean> {
  const raw = readCookie(request, OWNER_COOKIE);
  if (!raw || !env.SESSION_SECRET) return false;
  const blob = await openBlob<{g: string; exp: number}>(env.SESSION_SECRET, OWNER_LABEL, raw, Math.floor(now / 1000));
  return Boolean(blob && blob.g === gid);
}

export const clearOwnerCookie = () => clearCookie(OWNER_COOKIE);

// ---------------------------------------------------------------- Discord link

type OauthClaims = {s: string; v: string; g: string; exp: number};
type LinkClaims = {g: string; i: string; n: string; exp: number};

export type DiscordStart = {location: string; cookie: string};

/** The Discord authorize URL and the cookie that proves the callback is the answer to it. Scope identify only. */
export async function discordStart(
  env: PilotEnv,
  gid: string,
  origin: string,
  authorizeBase: string = DISCORD_AUTHORIZE,
  now = Date.now(),
): Promise<DiscordStart | null> {
  if (!env.SESSION_SECRET) return null;
  const state = randomToken(24);
  const verifier = randomToken(48);
  const cookie = await signBlob(env.SESSION_SECRET, OAUTH_LABEL, {s: state, v: verifier, g: gid, exp: Math.floor(now / 1000) + OAUTH_TTL_SEC});
  const url = new URL(authorizeBase, origin);
  url.searchParams.set('client_id', env.DISCORD_OAUTH_CLIENT_ID?.trim() || 'dev');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', callbackUrl(env, origin));
  url.searchParams.set('scope', 'identify');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', await pkceChallenge(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  return {location: url.toString(), cookie: hostCookie(OAUTH_COOKIE, cookie, OAUTH_TTL_SEC)};
}

/** The verifier of a callback whose state matches the cookie of this customer, else null. */
export async function discordCallbackCheck(
  env: PilotEnv,
  request: Request,
  gid: string,
  state: string | null,
  now = Date.now(),
): Promise<{verifier: string} | null> {
  const raw = readCookie(request, OAUTH_COOKIE);
  if (!raw || !state || !env.SESSION_SECRET) return null;
  const claims = await openBlob<OauthClaims>(env.SESSION_SECRET, OAUTH_LABEL, raw, Math.floor(now / 1000));
  if (!claims || claims.g !== gid || !safeEqual(claims.s, state) || !PKCE_VALUE.test(claims.v)) return null;
  return {verifier: claims.v};
}

export type DiscordIdentity = {id: string; name: string};

async function timed(fetcher: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetcher(url, {...init, signal: controller.signal});
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Trade the code for the one thing we want, the user's id and name, then
 * revoke the token: nothing of Discord's is kept except those two values.
 * Null on any failure.
 */
export async function discordIdentity(
  env: PilotEnv,
  code: string,
  verifier: string,
  redirectUri: string,
  fetcher: typeof fetch = fetch,
): Promise<DiscordIdentity | null> {
  const clientId = env.DISCORD_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.DISCORD_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  try {
    const tokenRes = await timed(fetcher, `${DISCORD_API}/oauth2/token`, {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT, Accept: 'application/json'},
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    });
    if (!tokenRes.ok) return null;
    const token = ((await tokenRes.json()) as {access_token?: unknown}).access_token;
    if (typeof token !== 'string' || !token) return null;
    const meRes = await timed(fetcher, `${DISCORD_API}/users/@me`, {
      headers: {Authorization: `Bearer ${token}`, 'User-Agent': USER_AGENT, Accept: 'application/json'},
    });
    const me = meRes.ok ? ((await meRes.json()) as {id?: unknown; username?: unknown; global_name?: unknown}) : null;
    // Best effort: the token is of no use to us any more.
    await timed(fetcher, `${DISCORD_API}/oauth2/token/revoke`, {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT},
      body: new URLSearchParams({client_id: clientId, client_secret: clientSecret, token, token_type_hint: 'access_token'}),
    }).catch(() => null);
    if (!me) return null;
    const id = cleanDiscordId(me.id);
    const name = cleanDiscordName(me.global_name) ?? cleanDiscordName(me.username);
    return id && name ? {id, name} : null;
  } catch {
    console.warn('pilot map: discord identify failed');
    return null;
  }
}

/** The cookie that remembers a linked Discord account until the owner places the pin. */
export async function linkCookie(env: PilotEnv, gid: string, identity: DiscordIdentity, now = Date.now()): Promise<string | null> {
  if (!env.SESSION_SECRET) return null;
  const token = await signBlob(env.SESSION_SECRET, LINK_LABEL, {g: gid, i: identity.id, n: identity.name, exp: Math.floor(now / 1000) + LINK_TTL_SEC});
  return hostCookie(LINK_COOKIE, token, LINK_TTL_SEC);
}

export async function readLink(env: PilotEnv, request: Request, gid: string, now = Date.now()): Promise<Link | null> {
  const raw = readCookie(request, LINK_COOKIE);
  if (!raw || !env.SESSION_SECRET) return null;
  const claims = await openBlob<LinkClaims>(env.SESSION_SECRET, LINK_LABEL, raw, Math.floor(now / 1000));
  const discordId = cleanDiscordId(claims?.i);
  const name = cleanDiscordName(claims?.n);
  return claims && claims.g === gid && discordId && name ? {gid, discordId, name} : null;
}

export const clearLinkCookie = () => clearCookie(LINK_COOKIE);
export const clearOauthCookie = () => clearCookie(OAUTH_COOKIE);
