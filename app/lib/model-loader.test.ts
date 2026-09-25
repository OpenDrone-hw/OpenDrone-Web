import {test} from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {ModelLoader} from './model-loader.ts';

function minimalGLB() {
  const json = JSON.stringify({asset: {version: '2.0'}, scenes: [{nodes: []}], scene: 0});
  const body = new TextEncoder().encode(json.padEnd(Math.ceil(json.length / 4) * 4));
  const data = new ArrayBuffer(20 + body.length);
  const header = new DataView(data);
  header.setUint32(0, 0x46546c67, true);
  header.setUint32(4, 2, true);
  header.setUint32(8, data.byteLength, true);
  header.setUint32(12, body.length, true);
  header.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(data, 20).set(body);
  return data;
}
for (const gzip of [false, true]) {
  test(`model loader accepts ${gzip ? 'gzip deployment' : 'raw development'} GLB`, async () => {
    const raw = minimalGLB();
    const data = gzip ? Uint8Array.from(gzipSync(new Uint8Array(raw))).buffer : raw;
    const gltf = await new ModelLoader().parseAsync(data, '');
    assert.equal(gltf.scene.children.length, 0);
  });
}
test('model loader rejects corrupt gzip instead of hanging', async () => {
  await assert.rejects(new ModelLoader().parseAsync(Uint8Array.from([0x1f, 0x8b, 0]).buffer, ''));
});
