import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, it} from 'node:test';
import {handleEditorial, manifestBody, receiptBody, type EditorialEnv} from './api.ts';
import {allowlistedPaths, buildManifest, sha256} from './manifest.ts';

const REPO = path.resolve(import.meta.dirname, '../../..');

function fixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'editorial-'));
  const put = (p: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, p)), {recursive: true});
    writeFileSync(path.join(root, p), text);
  };
  put('package.json', JSON.stringify({name: 'x-web', version: '1.2.3'}));
  put('content/copy/home.json', JSON.stringify({$title: 'Home', a: 1}));
  put('content/votes.json', '{}');
  put('app/content/legal/nl/shipping.md', '## Verzending\n\ntekst');
  put('app/content/learn/escs.md', '---\nx: 1\n---\n# ESCs\n');
  put('content/notes.txt', 'not allowlisted');
  return root;
}

const opts = (root: string) => ({root, commit: 'a'.repeat(40), builtAt: '2026-10-22T00:00:00.000Z', history: () => null});

describe('manifest generation', () => {
  it('lists every allowlisted path with a stable sha256 and nothing else', () => {
    const root = fixture();
    const a = buildManifest(opts(root));
    const b = buildManifest(opts(root));
    assert.deepEqual(a, b);
    assert.deepEqual(a.items.map((i) => i.path), ['app/content/learn/escs.md', 'app/content/legal/nl/shipping.md', 'content/copy/home.json', 'content/votes.json']);
    const home = a.items.find((i) => i.path === 'content/copy/home.json')!;
    assert.equal(home.sha256, sha256(JSON.stringify({$title: 'Home', a: 1})));
    assert.equal(home.title, 'Home');
    assert.equal(home.kind, 'copy');
    assert.equal(a.items.find((i) => i.path.endsWith('shipping.md'))!.locale, 'nl');
    assert.equal(a.items.find((i) => i.path.endsWith('escs.md'))!.title, 'ESCs');
    assert.equal(a.items.find((i) => i.path === 'content/votes.json')!.classification, 'generated');
    assert.equal(a.renderer.version, '1.2.3');
    assert.equal(a.completeness, 'complete');
    assert.match(a.manifest_hash, /^[0-9a-f]{64}$/);
  });

  it('changes the manifest hash exactly when a source byte changes', () => {
    const root = fixture();
    const a = buildManifest(opts(root));
    writeFileSync(path.join(root, 'content/copy/home.json'), '{"$title":"Home","a":2}');
    const b = buildManifest(opts(root));
    assert.notEqual(a.manifest_hash, b.manifest_hash);
    assert.equal(buildManifest({...opts(root), builtAt: '2030-01-01T00:00:00.000Z'}).manifest_hash, b.manifest_hash);
  });

  it('declares unknown commits as a gap', () => {
    assert.ok(buildManifest(opts(fixture())).gaps.some((g) => g.includes('git history')));
  });

  it('covers every content path of the real repository', () => {
    const m = buildManifest({root: REPO, commit: null, history: () => null});
    assert.deepEqual(m.items.map((i) => i.path), allowlistedPaths(REPO));
    for (const p of ['content/copy/home.json', 'content/products/openesc.json', 'app/content/legal/en/shipping.md', 'app/content/learn/escs.md']) {
      assert.ok(m.items.some((i) => i.path === p), p);
    }
    for (const i of m.items) assert.match(i.sha256, /^[0-9a-f]{64}$/);
  });
});

const TOKEN = 'editorial-token-1234567890';
const manifest = buildManifest(opts(fixture()));
const get = (name: string, headers: Record<string, string> = {}, method = 'GET') =>
  new Request(`https://opendrone.test/api/editorial/${name}`, {method, headers});
const auth = {Authorization: `Bearer ${TOKEN}`};
const ON: EditorialEnv = {EDITORIAL_API: '1', SUPPORT_STAFF_API_TOKEN: TOKEN};

describe('editorial endpoints', () => {
  for (const name of ['manifest', 'receipt']) {
    it(`${name}: 404 when the flag is off, even with the credential`, async () => {
      for (const env of [{...ON, EDITORIAL_API: undefined}, {...ON, EDITORIAL_API: '0'}]) {
        assert.equal((await handleEditorial(get(name, auth), env, manifest)).status, 404);
      }
    });
    it(`${name}: refuses without or with a wrong credential`, async () => {
      assert.equal((await handleEditorial(get(name), ON, manifest)).status, 401);
      assert.equal((await handleEditorial(get(name, {Authorization: 'Bearer nope'}), ON, manifest)).status, 401);
      assert.equal((await handleEditorial(get(name, auth), {EDITORIAL_API: '1'}, manifest)).status, 503);
    });
    it(`${name}: refuses writes`, async () => {
      assert.equal((await handleEditorial(get(name, auth, 'POST'), ON, manifest)).status, 405);
    });
  }

  it('manifest answers the contract envelope with a complete page', async () => {
    const res = await handleEditorial(get('manifest', auth), ON, manifest);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = (await res.json()) as ReturnType<typeof manifestBody>;
    assert.equal(body.schema_version, 1);
    assert.equal(body.capability, 'editorial.manifest');
    assert.equal(body.runtime.provider, 'storefront');
    assert.deepEqual(body.runtime.capabilities, [{name: 'editorial.manifest', version: 1}, {name: 'publication.receipt', version: 1}]);
    assert.equal(body.runtime.runtime_version, 'a'.repeat(40));
    assert.equal(body.completeness, 'complete');
    assert.equal(body.next_cursor, null);
    assert.equal(body.items.length, manifest.items.length);
    assert.deepEqual(body.items[0]!.ref, {provider: 'storefront', kind: 'learn', id: 'app/content/learn/escs.md'});
    assert.equal(body.items[0]!.revision, manifest.items[0]!.sha256);
    assert.equal(body.manifest.manifest_hash, manifest.manifest_hash);
  });

  it('receipt carries build sha, deploy time, version id and the manifest hash', async () => {
    const env: EditorialEnv = {...ON, CF_VERSION_METADATA: {id: 'ver-1', timestamp: '2026-10-22T01:00:00.000Z'}};
    const body = (await (await handleEditorial(get('receipt', auth), env, manifest)).json()) as ReturnType<typeof receiptBody>;
    assert.equal(body.capability, 'publication.receipt');
    assert.equal(body.deployed_revision, 'a'.repeat(40));
    assert.equal(body.manifest_hash, manifest.manifest_hash);
    assert.equal(body.verification_ref, manifest.manifest_hash);
    assert.equal(body.build_time, '2026-10-22T00:00:00.000Z');
    assert.equal(body.deployed_at, '2026-10-22T01:00:00.000Z');
    assert.equal(body.worker_version_id, 'ver-1');
    const bare = receiptBody(manifest, ON);
    assert.equal(bare.worker_version_id, null);
    assert.equal(bare.deployed_at, null);
  });
});
