// Geometry cleanup and high-precision meshopt encoding for existing product GLBs.
// Usage: node optimize-product.mjs input.glb output.glb
import {makeIO} from './io.mjs';
import {mergePrimitives} from './merge-primitives.mjs';
import {dedup, prune, weld, meshopt} from '@gltf-transform/functions';
import {MeshoptEncoder} from 'meshoptimizer';

const [input, output, ...extra] = process.argv.slice(2);
if (!input || !output || extra.length) throw new Error('Usage: optimize-product.mjs input.glb output.glb');
const io = await makeIO();
const doc = await io.read(input);
mergePrimitives(doc);
await doc.transform(weld(), dedup(), prune(), meshopt({encoder: MeshoptEncoder, level: 'high', quantizePosition: 16, quantizeNormal: 12}));
await io.write(output, doc);
