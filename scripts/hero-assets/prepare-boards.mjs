import {Matrix4} from 'three';
import {transformMesh, joinPrimitives, prune} from '@gltf-transform/functions';

// Bake a rigid board offline, preserving separate surface classes for the
// studio's soldermask, gold, silkscreen and component material profiles.
export async function prepareBoard(doc, assembly, id) {
  const inverse = new Matrix4().fromArray(assembly.getWorldMatrix()).invert();
  const groups = new Map();
  const sources = [...assembly.listChildren()];
  const materials = doc.getRoot().listMaterials();
  for (const occurrence of sources) {
    const visit = (node) => {
      const source = node.getMesh();
      if (source) {
        const mesh = source.clone();
        const matrix = inverse.clone().multiply(new Matrix4().fromArray(node.getWorldMatrix()));
        transformMesh(mesh, matrix.elements);
        const suffix = /_(PCB|pad|silkscreen|soldermask)(?:\b|_)/i.exec(occurrence.getName())?.[1] ?? 'components';
        for (const primitive of mesh.listPrimitives()) {
          // CAD exports have no textures; unused UV streams only cost bytes.
          for (const semantic of primitive.listSemantics()) {
            if (semantic.startsWith('TEXCOORD') && !primitive.getMaterial()?.listTextures().length) primitive.setAttribute(semantic, null);
          }
          const key = `${suffix}|${materials.indexOf(primitive.getMaterial())}|${primitive.listSemantics().sort().join(',')}`;
          if (!groups.has(key)) groups.set(key, {suffix, primitives: []});
          groups.get(key).primitives.push(primitive);
        }
      }
      node.listChildren().forEach(visit);
    };
    visit(occurrence);
  }
  const board = doc.createNode(`BOARD_${id}`).setExtras({boardId: id});
  for (const {suffix, primitives} of groups.values()) {
    const mesh = doc.createMesh(`${id}_${suffix}`);
    mesh.addPrimitive(primitives.length === 1 ? primitives[0] : joinPrimitives(primitives));
    board.addChild(doc.createNode(`${id}_${suffix}`).setMesh(mesh));
  }
  for (const node of sources) assembly.removeChild(node);
  assembly.addChild(board);
  await doc.transform(prune());
  return {occurrences: sources.length, surfaces: groups.size};
}
