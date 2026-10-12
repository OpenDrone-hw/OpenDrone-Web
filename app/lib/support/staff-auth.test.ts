import assert from 'node:assert/strict';
import {beforeEach, describe, it} from 'node:test';
import {_resetAccessCache, authenticateStaff, validLogin, verifyAccessJwt, type StaffAuthEnv} from './staff-auth.ts';

const b64 = (b: ArrayBuffer | Uint8Array | string) =>
  Buffer.from(typeof b === 'string' ? b : new Uint8Array(b)).toString('base64url');

const TEAM = 'incutec.cloudflareaccess.com';
const NOW = Date.parse('2026-10-12T10:00:00Z');
const ENV: StaffAuthEnv = {SUPPORT_STAFF_API_TOKEN: 'staff-token-1234567890'};
const ACCESS: StaffAuthEnv = {...ENV, SUPPORT_STAFF_ACCESS_TEAM_DOMAIN: TEAM, SUPPORT_STAFF_ACCESS_AUD: 'aud-1', SUPPORT_STAFF_ACCESS_CLIENT_ID: 'svc.access'};

const pair = (await crypto.subtle.generateKey({name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256'}, true, ['sign', 'verify'])) as CryptoKeyPair;
const jwk = {...((await crypto.subtle.exportKey('jwk', pair.publicKey)) as object), kid: 'k1'};

async function jwt(claims: Record<string, unknown> = {}, key = pair.privateKey, kid = 'k1') {
  const head = b64(JSON.stringify({alg: 'RS256', kid}));
  const body = b64(JSON.stringify({aud: ['aud-1'], iss: `https://${TEAM}`, exp: NOW / 1000 + 600, common_name: 'svc.access', ...claims}));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64(sig)}`;
}

let certFetches = 0;
const certs = (async (url: string) => {
  certFetches++;
  assert.equal(url, `https://${TEAM}/cdn-cgi/access/certs`);
  return new Response(JSON.stringify({keys: [jwk]}), {status: 200});
}) as unknown as typeof fetch;

const req = (headers: Record<string, string>) => new Request('https://opendrone.test/api/staff/support/tickets', {headers});

beforeEach(() => {
  _resetAccessCache();
  certFetches = 0;
});

describe('staff bearer token', () => {
  it('accepts the token and names the staff login', async () => {
    const a = await authenticateStaff(req({Authorization: `Bearer ${ENV.SUPPORT_STAFF_API_TOKEN}`, 'X-Staff-Login': 'stan'}), ENV);
    assert.deepEqual(a, {ok: true, login: 'stan'});
  });

  it('refuses a missing, wrong or truncated token with 401', async () => {
    for (const h of [{}, {Authorization: 'Bearer nope'}, {Authorization: 'Bearer staff-token-123456789'}, {Authorization: ENV.SUPPORT_STAFF_API_TOKEN!}] as Array<Record<string, string>>) {
      const a = await authenticateStaff(req(h), ENV);
      assert.equal(a.ok, false);
      assert.equal(!a.ok && a.status, 401);
    }
  });

  it('answers 503 while no token is configured, never open', async () => {
    const a = await authenticateStaff(req({Authorization: 'Bearer '}), {});
    assert.equal(!a.ok && a.status, 503);
  });

  it('drops a malformed login instead of trusting it', async () => {
    const a = await authenticateStaff(req({Authorization: `Bearer ${ENV.SUPPORT_STAFF_API_TOKEN}`, 'X-Staff-Login': 'a b; drop'}), ENV);
    assert.deepEqual(a, {ok: true, login: null});
    assert.equal(validLogin('stan@incutec.eu'), true);
    assert.equal(validLogin('x'.repeat(65)), false);
  });
});

describe('Cloudflare Access check', () => {
  it('needs a valid Access JWT once configured', async () => {
    const h = {Authorization: `Bearer ${ENV.SUPPORT_STAFF_API_TOKEN}`};
    const none = await authenticateStaff(req(h), ACCESS, certs, NOW);
    assert.equal(!none.ok && none.status, 403);
    const ok = await authenticateStaff(req({...h, 'Cf-Access-Jwt-Assertion': await jwt(), 'X-Staff-Login': 'stan'}), ACCESS, certs, NOW);
    assert.deepEqual(ok, {ok: true, login: 'stan'});
  });

  it('is skipped while the team domain or audience is not set', async () => {
    const a = await authenticateStaff(req({Authorization: `Bearer ${ENV.SUPPORT_STAFF_API_TOKEN}`}), {...ENV, SUPPORT_STAFF_ACCESS_TEAM_DOMAIN: TEAM});
    assert.equal(a.ok, true);
  });

  it('rejects wrong audience, issuer, expiry, service token and signature', async () => {
    const other = (await crypto.subtle.generateKey({name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256'}, true, ['sign', 'verify'])) as CryptoKeyPair;
    const bad = [
      await jwt({aud: ['other']}),
      await jwt({iss: 'https://evil.example'}),
      await jwt({exp: NOW / 1000 - 1}),
      await jwt({common_name: 'another.access'}),
      await jwt({}, other.privateKey),
      await jwt({}, pair.privateKey, 'unknown-kid'),
      'a.b',
      '',
    ];
    for (const token of bad) assert.equal(await verifyAccessJwt(ACCESS, token, certs, NOW), false);
  });

  it('accepts any service token when no client id is pinned and caches the certs', async () => {
    const env = {...ACCESS, SUPPORT_STAFF_ACCESS_CLIENT_ID: undefined};
    assert.equal(await verifyAccessJwt(env, await jwt({common_name: 'whatever'}), certs, NOW), true);
    assert.equal(await verifyAccessJwt(env, await jwt(), certs, NOW), true);
    assert.equal(certFetches, 1);
  });

  it('fails closed when the certs cannot be fetched', async () => {
    const down = (async () => new Response('', {status: 500})) as unknown as typeof fetch;
    assert.equal(await verifyAccessJwt(ACCESS, await jwt(), down, NOW), false);
  });
});
