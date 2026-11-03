/**
 * Review 3 F1/F2: the staging firmware route and the build guard (synthetic data only).
 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, it} from 'node:test';
import {STAGING_FILE_NAMES} from './firmware-manifest.ts';
import {
  FIRMWARE_STAGING_FORBIDDEN_OUTPUTS,
  FIRMWARE_STAGING_FORBIDDEN_SOURCES,
  firmwareStagingBuildProblem,
  handleStagingFirmware,
  type StagingFirmwareStore,
} from './staging-serve.ts';

const FILE = 'OpenESC-20x20_AM32_OPENESC_20_F421_2.21.bin';
const BYTES = Uint8Array.from([1, 2, 3, 4, 5]);
const PASSWORD = 'synthetic-test-password';

function store(files: Record<string, Uint8Array> = {[FILE]: BYTES}): StagingFirmwareStore & {gets: string[]} {
  const gets: string[] = [];
  return {
    gets,
    async get(key) {
      gets.push(key);
      const b = files[key];
      return b ? {body: new Response(Uint8Array.from(b).buffer).body!, size: b.length} : null;
    },
  };
}

const basic = (user: string, pass: string) => `Basic ${btoa(`${user}:${pass}`)}`;
const req = (path: string, auth?: string, method = 'GET') =>
  new Request(`http://localhost:8787${path}`, {method, headers: auth ? {Authorization: auth} : {}});
const okAuth = basic('opendrone', PASSWORD);

describe('staging firmware route: only manifest file names (N2)', () => {
  it('serves every manifest file name and 404s any other key, even a plain-looking one', async () => {
    const names = [...STAGING_FILE_NAMES];
    assert.ok(names.includes(FILE) && names.length >= 3);
    const files = Object.fromEntries([...names, 'notes.txt', 'other.bin'].map((n) => [n, BYTES]));
    for (const n of names) assert.equal((await handleStagingFirmware(req(`/firmware-staging/${n}`, okAuth), {password: PASSWORD, store: store(files)}))!.status, 200, n);
    for (const n of ['notes.txt', 'other.bin']) {
      const st = store(files);
      assert.equal((await handleStagingFirmware(req(`/firmware-staging/${n}`, okAuth), {password: PASSWORD, store: st}))!.status, 404, n);
      assert.deepEqual(st.gets, [], 'R2 not asked for a name outside the manifest');
    }
  });
});

describe('staging firmware route (F1)', () => {
  it('ignores every other path', async () => {
    for (const p of ['/flash', '/', '/firmware-stagingx/a.bin', '/assets/firmware-staging/a.bin']) {
      assert.equal(await handleStagingFirmware(req(p), {password: PASSWORD, store: store()}), null, p);
    }
  });
  it('without the staging env (no binding or no password) answers 404 and reads nothing', async () => {
    const s = store();
    for (const env of [
      {password: PASSWORD, store: undefined},
      {password: undefined, store: s},
      {password: '   ', store: s},
    ]) {
      const r = await handleStagingFirmware(req(`/firmware-staging/${FILE}`, okAuth), env);
      assert.equal(r?.status, 404);
    }
    assert.deepEqual(s.gets, []);
  });
  it('without or with wrong credentials answers 401 with the staging realm and reads nothing', async () => {
    const s = store();
    for (const auth of [
      undefined,
      basic('opendrone', 'wrong'),
      basic('someone', PASSWORD),
      'Basic !!!not-base64',
      `Bearer ${PASSWORD}`,
    ]) {
      const r = await handleStagingFirmware(req(`/firmware-staging/${FILE}`, auth), {password: PASSWORD, store: s});
      assert.equal(r?.status, 401, String(auth));
      assert.match(r!.headers.get('WWW-Authenticate') ?? '', /Basic realm="OpenDrone staging"/);
    }
    assert.deepEqual(s.gets, []);
  });
  it('with the env and the right credentials serves the file, no-store', async () => {
    const r = await handleStagingFirmware(req(`/firmware-staging/${FILE}`, okAuth), {password: PASSWORD, store: store()});
    assert.equal(r?.status, 200);
    assert.deepEqual(new Uint8Array(await r!.arrayBuffer()), BYTES);
    assert.equal(r!.headers.get('Cache-Control'), 'no-store');
    assert.equal(r!.headers.get('Content-Type'), 'application/octet-stream');
    assert.equal(r!.headers.get('Content-Length'), String(BYTES.length));
  });
  it('refuses odd names, queries, nesting and unknown files with 404', async () => {
    const s = store();
    for (const p of [
      '/firmware-staging',
      '/firmware-staging/',
      '/firmware-staging/a/b.bin',
      '/firmware-staging/.hidden',
      '/firmware-staging/%2e%2e%2fsecret',
      `/firmware-staging/${FILE}?x=1`,
      '/firmware-staging/missing.bin',
    ]) {
      const r = await handleStagingFirmware(req(p, okAuth), {password: PASSWORD, store: s});
      assert.equal(r?.status, 404, p);
    }
    assert.deepEqual(s.gets, [], 'only manifest file names reach R2');
  });
  it('only GET and HEAD', async () => {
    const r = await handleStagingFirmware(req(`/firmware-staging/${FILE}`, okAuth, 'POST'), {password: PASSWORD, store: store()});
    assert.equal(r?.status, 405);
    const h = await handleStagingFirmware(req(`/firmware-staging/${FILE}`, okAuth, 'HEAD'), {password: PASSWORD, store: store()});
    assert.equal(h?.status, 200);
  });
  it('no committed wrangler config declares the FIRMWARE_STAGING binding (the bench config is local-only)', () => {
    const root = join(import.meta.dirname, '..', '..', '..');
    for (const f of ['wrangler.toml', 'wrangler.production.toml', 'wrangler.shoptest.toml']) {
      assert.doesNotMatch(readFileSync(join(root, f), 'utf8'), /FIRMWARE_STAGING/, f);
    }
  });
  it('server.ts calls the route only in a VITE_FLASH_STAGING_GATES=1 build, before the site gate', () => {
    const src = readFileSync(join(import.meta.dirname, '..', '..', '..', 'server.ts'), 'utf8');
    const call = src.indexOf('handleStagingFirmware(request');
    const flag = src.lastIndexOf("import.meta.env.VITE_FLASH_STAGING_GATES === '1'", call);
    assert.ok(call > 0 && flag > 0 && call - flag < 200);
    assert.ok(call < src.indexOf('const gate = stagingGate(request, env);'));
  });
});

describe('firmware-staging build guard (F2)', () => {
  it('passes when no forbidden path exists', () => {
    assert.equal(firmwareStagingBuildProblem(() => false, FIRMWARE_STAGING_FORBIDDEN_SOURCES), null);
    assert.equal(firmwareStagingBuildProblem(() => false, FIRMWARE_STAGING_FORBIDDEN_OUTPUTS), null);
  });
  it('fails when public/firmware-staging exists, whatever the env', () => {
    const msg = firmwareStagingBuildProblem((p) => p === 'public/firmware-staging', FIRMWARE_STAGING_FORBIDDEN_SOURCES);
    assert.match(msg ?? '', /Refusing to build: public\/firmware-staging exists/);
  });
  it('fails when a build output holds firmware-staging', () => {
    assert.match(
      firmwareStagingBuildProblem((p) => p === 'dist/client/firmware-staging', FIRMWARE_STAGING_FORBIDDEN_OUTPUTS) ?? '',
      /dist\/client\/firmware-staging/,
    );
  });
  it('vite.config.ts registers the guard as a build plugin', () => {
    const src = readFileSync(join(import.meta.dirname, '..', '..', '..', 'vite.config.ts'), 'utf8');
    assert.match(src, /firmwareStagingBuildGuardPlugin\(\),/);
    assert.match(src, /apply: 'build',\s*configResolved\(config\)[\s\S]*buildStart: checkSource,\s*writeBundle: checkOutputs,\s*closeBundle: checkOutputs/);
    assert.doesNotMatch(src.slice(src.indexOf('function firmwareStagingBuildGuardPlugin'), src.indexOf('function firmwareStagingDevRefusePlugin')), /process\.cwd\(\)/);
  });
});
