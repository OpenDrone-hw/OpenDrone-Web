// Exploded-view assets: raw.glb + units.json (build_explode.py) -> streamed,
// meshopt-compressed chunks + chunks.json + explode.json for the hero scene.
//
//   node --max-old-space-size=8192 compress-explode.mjs <dir with raw.glb + units.json> <outdir>
//
// --legacy mode compresses the builder airframe (frame<N>.glb) the same way, undecimated.
// Same compression as build-hero.mjs (weld, dedup, meshopt simplify with a tighter
// bound and untouched silkscreen on boards, reorder, quantize, meshopt).
import {makeIO} from './io.mjs';
import {mergePrimitives} from './merge-primitives.mjs';
import {dedup, weld, prune, meshopt, simplifyPrimitive, quantize, reorder, cloneDocument} from '@gltf-transform/functions';
import {MeshoptEncoder, MeshoptSimplifier} from 'meshoptimizer';
import {readFileSync, writeFileSync, mkdirSync, statSync} from 'node:fs';
import {join} from 'node:path';

await MeshoptEncoder.ready;
await MeshoptSimplifier.ready;
// Builder airframe: node compress-explode.mjs --legacy <frame-legacy.glb> <public/models/frame3.glb>
if (process.argv[2] === '--legacy') {
  const [, , , src, dst] = process.argv;
  const io0 = await makeIO();
  const d = await io0.read(src);
  await d.transform(weld(), dedup(), reorder({encoder: MeshoptEncoder}), quantize({quantizePosition: 16, quantizeNormal: 10}));
  await d.transform(meshopt({encoder: MeshoptEncoder, level: 'high', quantizePosition: 16}));
  await io0.write(dst, d);
  console.log(`${dst} ${(statSync(dst).size / 1024).toFixed(0)} KB`);
  process.exit(0);
}
const [IN, OUT] = process.argv.slice(2);
if (!IN || !OUT) { console.error('usage: compress-explode.mjs <in dir> <outdir>'); process.exit(1); }
mkdirSync(OUT, {recursive: true});
const argNum = (f, dflt) => { const i = process.argv.indexOf(f); return i < 0 ? dflt : parseFloat(process.argv[i + 1]); };
const RATIO = argNum('--ratio', 0.2);
const ERROR = argNum('--error', 0.004);

const units = JSON.parse(readFileSync(join(IN, 'units.json'), 'utf8'));
const chunkOf = new Map(units.map((u) => [u.id, u.chunk]));
const io = await makeIO();
const doc = await io.read(join(IN, 'raw.glb'));
const chunkIds = [...new Set(units.map((u) => u.chunk))];
const rank = (id) => (id === 'frame' ? 0 : id === 'drive' ? 1 : id.startsWith('board-') ? 2 : 3);
chunkIds.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
const LABEL = {frame: 'airframe and hardware', drive: 'motors and props', video: 'camera and video system'};

const emitted = [];
for (const cid of chunkIds) {
  const clone = cloneDocument(doc);
  const cAsm = clone.getRoot().listScenes()[0].listChildren()[0];
  for (const n of [...cAsm.listChildren()]) {
    if (chunkOf.get(n.getName()) !== cid) { n.dispose(); }
  }
  await clone.transform(prune({keepAttributes: false}));
  mergePrimitives(clone);
  const isBoard = cid.startsWith('board-');
  const hiRes = isBoard || cid === 'frame';
  await clone.transform(weld(), dedup());
  await clone.transform(async (d) => {
    for (const mesh of d.getRoot().listMeshes()) {
      for (const p of mesh.listPrimitives()) {
        const mat = p.getMaterial()?.getName() ?? '';
        // Ink and pads are thin geometry: keep their exact triangles.
        if (/^(silk|padgold)\|/.test(mat)) continue;
        // Carbon plates are already cheap and need crisp edges.
        if (/^carbon\|/.test(mat)) continue;
        simplifyPrimitive(p, {simplifier: MeshoptSimplifier, ratio: RATIO, error: isBoard ? Math.min(ERROR, 0.0005) : ERROR});
      }
    }
  }, dedup());
  await clone.transform(reorder({encoder: MeshoptEncoder}), quantize({quantizePosition: hiRes ? 16 : 14, quantizeNormal: 10, quantizeTexcoord: 12}));
  await clone.transform(meshopt({encoder: MeshoptEncoder, level: 'high', quantizePosition: hiRes ? 16 : 14}));
  const file = `${cid}.glb`;
  await io.write(join(OUT, file), clone);
  let verts = 0;
  for (const m of clone.getRoot().listMeshes()) for (const p of m.listPrimitives()) verts += p.getAttribute('POSITION')?.getCount() ?? 0;
  const bytes = statSync(join(OUT, file)).size;
  emitted.push({id: cid, label: LABEL[cid] ?? cid.replace(/^board-/, ''), file, bytes, verts});
  console.log(`${file.padEnd(34)} ${(bytes / 1024).toFixed(0).padStart(6)} KB ${verts.toLocaleString().padStart(9)} verts`);
}
writeFileSync(join(OUT, 'chunks.json'), JSON.stringify({
  _note: 'Written by compress-explode.mjs. Array order is load order.',
  chunks: emitted,
}, null, 2));
console.log(`total ${(emitted.reduce((s, c) => s + c.bytes, 0) / 1048576).toFixed(2)} MB`);
