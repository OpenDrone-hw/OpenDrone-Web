import {joinPrimitives} from '@gltf-transform/functions';

export function mergePrimitives(doc) {
  let before = 0, after = 0;
  const mats = doc.getRoot().listMaterials();
  for (const mesh of doc.getRoot().listMeshes()) {
    const prims = mesh.listPrimitives();
    before += prims.length;
    const groups = new Map();
    for (const p of prims) {
      // Key on everything joinPrimitives validates: material, draw mode, the
      // exact attribute set, and whether indices are present.
      const key = [
        mats.indexOf(p.getMaterial()),
        p.getMode(),
        p.listSemantics().sort().join(','),
        p.getIndices() ? 'idx' : 'noidx',
      ].join('|');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      try {
        const joined = joinPrimitives(group);
        for (const p of group) { mesh.removePrimitive(p); p.dispose(); }
        mesh.addPrimitive(joined);
      } catch {
        // Incompatible despite the key; leave this group untouched.
      }
    }
    after += mesh.listPrimitives().length;
  }
  return {before, after};
}

