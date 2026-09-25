import {readFileSync} from 'node:fs';
import {getBounds} from '@gltf-transform/functions';

// The exporter preserves Onshape occurrence IDs in its metadata extension.
// Copy them into standard extras before decoding, then share geometry only
// between occurrences of the exact same CAD part and revision.
export async function readAssembly(io, path, definitionPath) {
  const json = await io.binaryToJSON(new Uint8Array(readFileSync(path)));
  const definition = JSON.parse(readFileSync(definitionPath, 'utf8'));
  const instances = new Map(definition.rootAssembly.instances.map((i) => [i.id, i]));
  const boardElements = new Map();
  for (const instance of instances.values()) {
    const match = /^(.+?)_(?:PCB|pad|silkscreen|soldermask)(?:\b|_)/.exec(instance.name ?? '');
    if (match) boardElements.set(instance.elementId, match[1]);
  }
  for (const node of json.json.nodes ?? []) {
    const id = node.extensions?.PTC_onshape_metadata?.id?.at(-1);
    const instance = instances.get(id);
    if (!instance?.partId) continue;
    node.extras = {
      ...node.extras,
      sourceInstance: id,
      sourcePart: [instance.documentId, instance.documentMicroversion, instance.elementId, instance.partId, instance.fullConfiguration].join('|'),
      ...(boardElements.has(instance.elementId) ? {boardId: boardElements.get(instance.elementId)} : {}),
    };
  }
  const doc = await io.readJSON(json);
  const seen = new Map();
  let shared = 0;
  const cloneTree = (node) => {
    const copy = doc.createNode(node.getName()).setMatrix(node.getMatrix()).setMesh(node.getMesh()).setExtras(node.getExtras());
    for (const child of node.listChildren()) copy.addChild(cloneTree(child));
    return copy;
  };
  const localBounds = (node) => {
    const matrix = node.getMatrix();
    node.setTranslation([0, 0, 0]).setRotation([0, 0, 0, 1]).setScale([1, 1, 1]);
    const bounds = getBounds(node);
    node.setMatrix(matrix);
    return bounds;
  };
  const materialSignature = (node) => {
    const signatures = new Set();
    node.traverse((child) => {
      for (const primitive of child.getMesh()?.listPrimitives() ?? []) {
        const m = primitive.getMaterial();
        signatures.add(JSON.stringify(m ? [m.getBaseColorFactor(), m.getMetallicFactor(), m.getRoughnessFactor(), m.getDoubleSided(), m.getAlphaMode(), m.getEmissiveFactor()] : null));
      }
    });
    return [...signatures].sort().join(';');
  };
  for (const occurrence of doc.getRoot().listScenes()[0].listChildren()[0].listChildren()) {
    const key = occurrence.getExtras().sourcePart;
    if (!key) continue;
    const signature = materialSignature(occurrence);
    const bounds = localBounds(occurrence);
    const first = seen.get(key);
    if (!first) { seen.set(key, {occurrence, signature, bounds}); continue; }
    if (signature !== first.signature) continue;
    if (['min', 'max'].some((side) => bounds[side].some((v, i) => Math.abs(v - first.bounds[side][i]) > 0.00002))) continue;
    for (const child of [...occurrence.listChildren()]) occurrence.removeChild(child);
    for (const child of first.occurrence.listChildren()) occurrence.addChild(cloneTree(child));
    shared++;
  }
  console.log(`Shared CAD geometry for ${shared} repeated occurrences`);
  return doc;
}
