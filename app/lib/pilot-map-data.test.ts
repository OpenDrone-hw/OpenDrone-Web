import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {describe, it} from 'node:test';
import {redactCustomer} from './accounts/rights.ts';
import {ACCOUNT_IDLE_MS, createSession, purgeExpired, upsertAccount} from './accounts/sessions.ts';
import type {EarlyBirdOrder} from './early-bird.ts';
import {PILOT_CONSENT_VERSION, PILOT_RETENTION_MS} from './pilot-map.ts';
import {
  LINK_COOKIE,
  OAUTH_COOKIE,
  customerIsOwner,
  discordCallbackCheck,
  discordIdentity,
  discordStart,
  linkCookie,
  ownerCookie,
  ownerCookieValid,
  pilotMapEnabled,
  pilotView,
  placePin,
  purgeOldPins,
  readLink,
  readOwnPin,
  deletePin,
  type PilotEnv,
} from './pilot-map-data.ts';
import {testD1} from './support/testing.ts';

const NOW = 1_800_000_000_000;
const GID = 'gid://shopify/Customer/101';
const OTHER = 'gid://shopify/Customer/202';
const ORIGIN = 'https://opendrone.be';
const ok = {consent: '1', age16: '1', version: PILOT_CONSENT_VERSION};
const link = (gid = GID) => ({gid, discordId: '80351110224678912', name: 'mira_fpv'});

async function db(): Promise<D1Database> {
  const d = await testD1();
  assert.ok(d, 'node:sqlite required');
  return d;
}

const env = (extra: Partial<PilotEnv> = {}): PilotEnv => ({
  ACCOUNTS_ENABLED: '1',
  PILOT_MAP_ENABLED: '1',
  SESSION_SECRET: 'session-secret',
  DISCORD_OAUTH_CLIENT_ID: 'cid',
  DISCORD_OAUTH_CLIENT_SECRET: 'csecret',
  ...extra,
});

const reqWithCookie = (name: string, value: string) => new Request(`${ORIGIN}/x`, {headers: {Cookie: `${name}=${value}`}});
const cookieValue = (setCookie: string) => setCookie.split(';')[0]!.split('=').slice(1).join('=');

describe('pilotMapEnabled', () => {
  it('needs the flag, accounts and the database', async () => {
    const d = await db();
    assert.equal(pilotMapEnabled({PILOT_MAP_ENABLED: '1', ACCOUNTS_ENABLED: '1', SUPPORT_DB: d}), true);
    assert.equal(pilotMapEnabled({PILOT_MAP_ENABLED: '0', ACCOUNTS_ENABLED: '1', SUPPORT_DB: d}), false);
    assert.equal(pilotMapEnabled({ACCOUNTS_ENABLED: '1', SUPPORT_DB: d}), false);
    assert.equal(pilotMapEnabled({PILOT_MAP_ENABLED: '1', ACCOUNTS_ENABLED: '0', SUPPORT_DB: d}), false);
    assert.equal(pilotMapEnabled({PILOT_MAP_ENABLED: '1', ACCOUNTS_ENABLED: '1'}), false);
  });
});

describe('placePin', () => {
  it('stores the cell and the consent, and not the clicked point', async () => {
    const d = await db();
    const result = await placePin(d, {gid: GID, owner: true, link: link(), form: {lat: 52.52013, lon: 13.40495, ...ok}}, NOW);
    assert.deepEqual(result, {ok: true});
    const row = await d.prepare('SELECT * FROM pilot_map_pins').first<Record<string, unknown>>();
    assert.ok(row);
    assert.equal(row.shopify_gid, GID);
    assert.equal(row.discord_id, '80351110224678912');
    assert.equal(row.consent_at, NOW);
    assert.equal(row.consent_version, PILOT_CONSENT_VERSION);
    const dump = JSON.stringify(row);
    assert.doesNotMatch(dump, /52\.52013|13\.40495/);
    assert.ok(Math.abs(Number(row.cell_lat) - 52.52013) < 0.06);
    assert.deepEqual(Object.keys(row).sort(), ['cell_id', 'cell_lat', 'cell_lon', 'consent_at', 'consent_version', 'discord_id', 'discord_name', 'shopify_gid']);
  });

  it('gives two clicks in one cell the same stored position', async () => {
    const d = await db();
    await placePin(d, {gid: GID, owner: true, link: link(), form: {lat: 50.85, lon: 4.35, ...ok}}, NOW);
    const a = await readOwnPin(d, GID);
    await placePin(d, {gid: GID, owner: true, link: link(), form: {lat: 50.8512, lon: 4.3507, ...ok}}, NOW + 1);
    const b = await readOwnPin(d, GID);
    assert.equal(a?.cellLat, b?.cellLat);
    assert.equal(a?.cellLon, b?.cellLon);
    assert.equal((await d.prepare('SELECT COUNT(*) AS n FROM pilot_map_pins').first<{n: number}>())?.n, 1);
  });

  it('refuses without owner, link, consent or a usable position', async () => {
    const d = await db();
    const base = {gid: GID, owner: true, link: link(), form: {lat: 50, lon: 4, ...ok}};
    assert.deepEqual(await placePin(d, {...base, owner: false}, NOW), {ok: false, error: 'not-owner'});
    assert.deepEqual(await placePin(d, {...base, link: null}, NOW), {ok: false, error: 'no-link'});
    assert.deepEqual(await placePin(d, {...base, link: link(OTHER)}, NOW), {ok: false, error: 'no-link'});
    assert.deepEqual(await placePin(d, {...base, form: {...base.form, consent: undefined}}, NOW), {ok: false, error: 'consent'});
    assert.deepEqual(await placePin(d, {...base, form: {...base.form, age16: undefined}}, NOW), {ok: false, error: 'consent'});
    assert.deepEqual(await placePin(d, {...base, form: {...base.form, version: 'old'}}, NOW), {ok: false, error: 'consent'});
    assert.deepEqual(await placePin(d, {...base, form: {...base.form, lat: 95}}, NOW), {ok: false, error: 'position'});
    assert.deepEqual(await placePin(d, {...base, form: {...base.form, lat: undefined}}, NOW), {ok: false, error: 'position'});
    assert.equal((await d.prepare('SELECT COUNT(*) AS n FROM pilot_map_pins').first<{n: number}>())?.n, 0);
  });

  it('moves an existing pin without a new Discord link', async () => {
    const d = await db();
    await placePin(d, {gid: GID, owner: true, link: link(), form: {lat: 50, lon: 4, ...ok}}, NOW);
    const moved = await placePin(d, {gid: GID, owner: true, link: null, form: {lat: 48.1, lon: 11.5, ...ok}}, NOW + 5);
    assert.deepEqual(moved, {ok: true});
    const row = await d.prepare('SELECT discord_name, consent_at FROM pilot_map_pins').first<{discord_name: string; consent_at: number}>();
    assert.equal(row?.discord_name, 'mira_fpv');
    assert.equal(row?.consent_at, NOW + 5);
    // ...but a stranger with no row and no link cannot.
    assert.deepEqual(await placePin(d, {gid: OTHER, owner: true, link: null, form: {lat: 48.1, lon: 11.5, ...ok}}, NOW), {ok: false, error: 'no-link'});
  });
});

describe('pilotView: server-side visibility', () => {
  it('shows names and cells to an owner and only the total to everyone else', async () => {
    const d = await db();
    await placePin(d, {gid: GID, owner: true, link: link(), form: {lat: 52.5, lon: 13.4, ...ok}}, NOW);
    await placePin(d, {gid: OTHER, owner: true, link: {gid: OTHER, discordId: '80351110224678999', name: 'jonas'}, form: {lat: 50.8, lon: 4.3, ...ok}}, NOW);
    const anonymous = await pilotView(d, false);
    assert.deepEqual(anonymous, {total: 2});
    assert.doesNotMatch(JSON.stringify(anonymous), /mira|jonas|8035111|cells/);
    const owner = await pilotView(d, true);
    assert.equal(owner.total, 2);
    assert.equal(owner.cells?.length, 2);
    assert.deepEqual(owner.cells?.flatMap((c) => c.pilots.map((p) => p.name)).sort(), ['jonas', 'mira_fpv']);
  });
});

describe('withdrawal, erasure and retention', () => {
  it('withdrawal deletes the row at once', async () => {
    const d = await db();
    await placePin(d, {gid: GID, owner: true, link: link(), form: {lat: 52.5, lon: 13.4, ...ok}}, NOW);
    await deletePin(d, GID);
    assert.equal(await readOwnPin(d, GID), null);
  });

  it('the customers/redact and delete path (redactCustomer) deletes the pin, with or without an account row', async () => {
    const d = await db();
    await placePin(d, {gid: GID, owner: true, link: link(), form: {lat: 52.5, lon: 13.4, ...ok}}, NOW);
    await placePin(d, {gid: OTHER, owner: true, link: link(OTHER), form: {lat: 50, lon: 4, ...ok}}, NOW);
    await redactCustomer({SUPPORT_DB: d}, GID);
    assert.equal(await readOwnPin(d, GID), null);
    assert.ok(await readOwnPin(d, OTHER), 'another customer keeps theirs');
  });

  it('the account purge deletes the pin of an idle account only', async () => {
    const d = await db();
    const idle = await upsertAccount(d, GID, NOW - ACCOUNT_IDLE_MS - 1000);
    await upsertAccount(d, OTHER, NOW);
    assert.ok(idle);
    await placePin(d, {gid: GID, owner: true, link: link(), form: {lat: 52.5, lon: 13.4, ...ok}}, NOW);
    await placePin(d, {gid: OTHER, owner: true, link: link(OTHER), form: {lat: 50, lon: 4, ...ok}}, NOW);
    await purgeExpired(d, NOW);
    assert.equal(await readOwnPin(d, GID), null);
    assert.ok(await readOwnPin(d, OTHER));
  });

  it('a live session keeps an old account, and its pin', async () => {
    const d = await db();
    const id = await upsertAccount(d, GID, NOW - ACCOUNT_IDLE_MS - 1000);
    await createSession(d, {SESSION_ENC_KEY: 'k'}, id, '', NOW);
    await placePin(d, {gid: GID, owner: true, link: link(), form: {lat: 52.5, lon: 13.4, ...ok}}, NOW);
    await purgeExpired(d, NOW);
    assert.ok(await readOwnPin(d, GID));
  });

  it('retention deletes a pin 24 months after its consent', async () => {
    const d = await db();
    await placePin(d, {gid: GID, owner: true, link: link(), form: {lat: 52.5, lon: 13.4, ...ok}}, NOW - PILOT_RETENTION_MS - 1);
    await placePin(d, {gid: OTHER, owner: true, link: link(OTHER), form: {lat: 50, lon: 4, ...ok}}, NOW - PILOT_RETENTION_MS + 1000);
    await purgeOldPins(d, NOW);
    assert.equal(await readOwnPin(d, GID), null);
    assert.ok(await readOwnPin(d, OTHER));
  });
});

describe('customerIsOwner', () => {
  const order = (over: Partial<EarlyBirdOrder>) => ({cancelledAt: null, displayFinancialStatus: 'PAID', ...over}) as EarlyBirdOrder;
  it('needs a paid order that is not cancelled', async () => {
    assert.equal(await customerIsOwner({}, GID, async () => [order({})]), true);
    assert.equal(await customerIsOwner({}, GID, async () => [order({cancelledAt: '2026-01-01'}), order({displayFinancialStatus: 'PENDING'})]), false);
    assert.equal(await customerIsOwner({}, GID, async () => null), false);
  });
  it('is false when Shopify fails', async () => {
    assert.equal(await customerIsOwner({}, GID, async () => Promise.reject(new Error('503'))), false);
  });
});

describe('owner cookie', () => {
  it('is bound to the customer and expires', async () => {
    const cookie = await ownerCookie(env(), GID, NOW);
    assert.ok(cookie?.startsWith('__Host-od_pm_owner='));
    const req = reqWithCookie('__Host-od_pm_owner', cookieValue(cookie!));
    assert.equal(await ownerCookieValid(env(), req, GID, NOW + 1000), true);
    assert.equal(await ownerCookieValid(env(), req, OTHER, NOW + 1000), false);
    assert.equal(await ownerCookieValid(env(), req, GID, NOW + 2 * 3600 * 1000), false);
    assert.equal(await ownerCookieValid(env({SESSION_SECRET: 'other'}), req, GID, NOW + 1000), false);
  });
});

describe('Discord link', () => {
  it('starts with scope identify, state and PKCE S256', async () => {
    const start = await discordStart(env(), GID, ORIGIN, undefined, NOW);
    assert.ok(start);
    const url = new URL(start.location);
    assert.equal(url.origin + url.pathname, 'https://discord.com/oauth2/authorize');
    assert.equal(url.searchParams.get('scope'), 'identify');
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('redirect_uri'), `${ORIGIN}/owners/discord/callback`);
    assert.equal(url.searchParams.get('client_id'), 'cid');
    assert.ok(url.searchParams.get('state') && url.searchParams.get('code_challenge'));
    assert.ok(start.cookie.startsWith(`${OAUTH_COOKIE}=`) && /HttpOnly/.test(start.cookie) && /Secure/.test(start.cookie));
  });

  it('accepts the callback only with the matching state, customer and a live cookie', async () => {
    const start = (await discordStart(env(), GID, ORIGIN, undefined, NOW))!;
    const state = new URL(start.location).searchParams.get('state');
    const req = reqWithCookie(OAUTH_COOKIE, cookieValue(start.cookie));
    const inTime = Date.now();
    // The cookie is minted for NOW (far future), so it is live for the real clock.
    const checked = await discordCallbackCheck(env(), req, GID, state, inTime);
    assert.ok(checked?.verifier);
    assert.equal(await discordCallbackCheck(env(), req, GID, 'wrong', inTime), null);
    assert.equal(await discordCallbackCheck(env(), req, GID, null, inTime), null);
    assert.equal(await discordCallbackCheck(env(), req, OTHER, state, inTime), null);
    assert.equal(await discordCallbackCheck(env(), req, GID, state, NOW + 3600 * 1000), null);
    assert.equal(await discordCallbackCheck(env(), new Request(`${ORIGIN}/x`), GID, state, inTime), null);
  });

  function fakeDiscord(me: unknown, tokenStatus = 200) {
    const calls: {url: string; body: string; auth: string | null}[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({url, body: String(init?.body ?? ''), auth: new Headers(init?.headers).get('Authorization')});
      if (url.endsWith('/oauth2/token')) return new Response(JSON.stringify({access_token: 'tok'}), {status: tokenStatus});
      if (url.endsWith('/users/@me')) return new Response(JSON.stringify(me), {status: 200});
      return new Response('{}', {status: 200});
    }) as typeof fetch;
    return {fetcher, calls};
  }

  it('reads the id and display name, sends the verifier, and revokes the token', async () => {
    const api = fakeDiscord({id: '80351110224678912', username: 'mira', global_name: 'Mira F'});
    const identity = await discordIdentity(env(), 'the-code', 'v'.repeat(43), `${ORIGIN}/owners/discord/callback`, api.fetcher);
    assert.deepEqual(identity, {id: '80351110224678912', name: 'Mira F'});
    const token = new URLSearchParams(api.calls[0]!.body);
    assert.equal(token.get('code'), 'the-code');
    assert.equal(token.get('code_verifier'), 'v'.repeat(43));
    assert.equal(token.get('grant_type'), 'authorization_code');
    assert.equal(api.calls[1]!.auth, 'Bearer tok');
    assert.ok(api.calls[2]!.url.endsWith('/oauth2/token/revoke'));
  });

  it('falls back to the username and rejects a bad answer', async () => {
    const plain = fakeDiscord({id: '80351110224678912', username: 'mira', global_name: null});
    assert.equal((await discordIdentity(env(), 'c', 'v'.repeat(43), 'r', plain.fetcher))?.name, 'mira');
    assert.equal(await discordIdentity(env(), 'c', 'v'.repeat(43), 'r', fakeDiscord({id: 'x', username: 'a'}).fetcher), null);
    assert.equal(await discordIdentity(env(), 'c', 'v'.repeat(43), 'r', fakeDiscord({}, 400).fetcher), null);
    assert.equal(await discordIdentity(env({DISCORD_OAUTH_CLIENT_ID: ''}), 'c', 'v'.repeat(43), 'r', plain.fetcher), null);
  });

  it('keeps the linked account in a signed cookie bound to the customer', async () => {
    const cookie = await linkCookie(env(), GID, {id: '80351110224678912', name: 'mira_fpv'}, Date.now());
    assert.ok(cookie?.startsWith(`${LINK_COOKIE}=`));
    const req = reqWithCookie(LINK_COOKIE, cookieValue(cookie!));
    assert.deepEqual(await readLink(env(), req, GID), {gid: GID, discordId: '80351110224678912', name: 'mira_fpv'});
    assert.equal(await readLink(env(), req, OTHER), null);
    assert.equal(await readLink(env({SESSION_SECRET: 'other'}), req, GID), null);
    assert.equal(await readLink(env(), reqWithCookie(LINK_COOKIE, 'garbage.value'), GID), null);
  });
});

describe('deployed configs', () => {
  const read = (f: string) => readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
  it('keep the pilot map off and never carry the dev fake or secrets', () => {
    for (const f of ['wrangler.production.toml', 'wrangler.toml']) {
      const toml = read(f);
      assert.match(toml, /^PILOT_MAP_ENABLED = "0"/m, f);
      assert.doesNotMatch(toml, /DISCORD_OAUTH_CLIENT_(ID|SECRET)\s*=/, f);
    }
  });

  // The fake Discord screen is dev only: after `npm run build` its marker must not be in the Worker bundle.
  const serverDir = new URL('../../dist/server/', import.meta.url);
  it('compile the fake Discord out of the production Worker bundle', {skip: existsSync(serverDir) ? false : 'no build in dist/'}, () => {
    const files = execFileSync('find', [serverDir.pathname, '-name', '*.js'], {encoding: 'utf8'}).trim().split('\n');
    assert.ok(files.length > 0 && readdirSync(serverDir).length > 0);
    for (const f of files) assert.doesNotMatch(readFileSync(f, 'utf8'), /od-pilot-dev-discord|Fake Discord/, f);
  });
});
