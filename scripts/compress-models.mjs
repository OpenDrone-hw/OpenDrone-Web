// Compress deployment copies only. Source GLBs remain readable by CAD tools
// and the dev server; ModelLoader decodes the gzip payload after HTTP decoding.
import {readFile, writeFile, readdir, rename} from 'node:fs/promises';
import {gzipSync, gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {join, relative} from 'node:path';

const root = 'dist/client';
let before = 0;
let after = 0;
async function compress(dir) {
  for (const entry of await readdir(dir, {withFileTypes: true})) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await compress(path);
    else if (entry.name.endsWith('.glb')) {
      const bytes = await readFile(path);
      // Idempotent when a deployment is prepared twice.
      const raw = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
      if (raw.toString('ascii', 0, 4) !== 'glTF') throw new Error(`Invalid GLB: ${path}`);
      const compressed = gzipSync(raw, {level: 9});
      await writeFile(path, compressed);
      before += raw.length;
      after += compressed.length;
      console.log(`${relative(root, path)}: ${raw.length} -> ${compressed.length} bytes`);
    }
  }
}
// Fingerprint hero chunks so repeat visits cannot mix new manifests and old CAD.
for (const model of ['od3', 'od5']) {
  const dir = join(root, 'models', model);
  const manifestPath = join(dir, 'chunks.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  for (const chunk of manifest.chunks) {
    const path = join(dir, chunk.file);
    const data = await readFile(path);
    const raw = data[0] === 0x1f && data[1] === 0x8b ? gunzipSync(data) : data;
    const hash = createHash('sha256').update(raw).digest('hex').slice(0, 12);
    const file = `${chunk.id}.${hash}.glb`;
    if (file !== chunk.file) await rename(path, join(dir, file));
    chunk.file = file;
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
}
await compress(join(root, 'models'));
console.log(`GLB transfer: ${before} -> ${after} bytes`);
