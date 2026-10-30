import * as THREE from 'three';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';

const nextMatrix = new THREE.Matrix4();

/** Leave static branches clean so a rotating prop only updates its subtree. */
export function updateHeroMatrices(nodes: ReadonlySet<THREE.Object3D>) {
  for (const node of nodes) {
    nextMatrix.compose(node.position, node.quaternion, node.scale);
    if (nextMatrix.equals(node.matrix)) continue;
    node.matrix.copy(nextMatrix);
    node.matrixWorldNeedsUpdate = true;
  }
}

/** Batch opaque geometry only within a rigid part of the animation rig. */
export function mergeHeroGeometry(
  root: THREE.Object3D,
  moving: ReadonlySet<THREE.Object3D>,
) {
  root.updateWorldMatrix(true, true);
  const groups = new Map<THREE.Object3D, Map<string, THREE.Mesh[]>>();
  const sources = new Set<THREE.BufferGeometry>();
  const created = new Set<THREE.BufferGeometry>();
  const collect = (node: THREE.Object3D, owner: THREE.Object3D) => {
    if (moving.has(node)) owner = node;
    if (node instanceof THREE.Mesh) {
      sources.add(node.geometry);
      const mat = node.material;
      if (
        node !== owner &&
        node.visible &&
        !Array.isArray(mat) &&
        !mat.transparent &&
        node.matrixWorld.determinant() > 0 &&
        owner.matrixWorld.determinant() > 0 &&
        !(node instanceof THREE.SkinnedMesh) &&
        !(node instanceof THREE.InstancedMesh) &&
        !Object.keys(node.geometry.morphAttributes).length &&
        !node.geometry.groups.length &&
        node.geometry.drawRange.count === Infinity
      ) {
        const layout = Object.entries(
          node.geometry.attributes as Record<
            string,
            THREE.BufferAttribute | THREE.InterleavedBufferAttribute
          >,
        )
          .sort(([a], [b]) => a.localeCompare(b))
          .map(
            ([name, attr]) =>
              `${name}:${attr.itemSize}:${attr.normalized}:${attr.array.constructor.name}`,
          )
          .join('|');
        const key = `${mat.uuid}:${Boolean(node.geometry.index)}:${layout}:${node.renderOrder}:${node.layers.mask}`;
        let batches = groups.get(owner);
        if (!batches) groups.set(owner, (batches = new Map()));
        const meshes = batches.get(key) ?? [];
        meshes.push(node);
        batches.set(key, meshes);
      }
    }
    for (const child of node.children) collect(child, owner);
  };
  collect(root, root);
  const inverse = new THREE.Matrix4();
  const transform = new THREE.Matrix4();
  for (const [owner, batches] of groups) {
    inverse.copy(owner.matrixWorld).invert();
    for (const meshes of batches.values()) {
      if (meshes.length < 2) continue;
      const copies = meshes.map((mesh) =>
        mesh.geometry
          .clone()
          .applyMatrix4(transform.multiplyMatrices(inverse, mesh.matrixWorld)),
      );
      const geometry = mergeGeometries(copies, false);
      for (const copy of copies) copy.dispose();
      if (!geometry) continue;
      created.add(geometry);
      const batch = new THREE.Mesh(geometry, meshes[0].material);
      batch.name = 'hero-batch';
      batch.renderOrder = meshes[0].renderOrder;
      batch.layers.mask = meshes[0].layers.mask;
      owner.add(batch);
      for (const mesh of meshes) mesh.removeFromParent();
    }
  }
  const prune = (node: THREE.Object3D) => {
    for (const child of [...node.children]) {
      prune(child);
      if (
        !moving.has(child) &&
        !(child instanceof THREE.Mesh) &&
        !child.children.length
      )
        child.removeFromParent();
    }
  };
  prune(root);
  root.traverse((node) => {
    node.updateMatrix();
    node.matrixAutoUpdate = moving.has(node);
    if (node instanceof THREE.Mesh) {
      node.geometry.computeBoundingSphere();
      node.frustumCulled = true;
    }
  });
  return () => {
    for (const geometry of new Set([...sources, ...created]))
      geometry.dispose();
  };
}

/** Instance repeated hardware without copying its vertices or changing its pose. */
export function instanceHeroDraws(
  scene: THREE.Scene,
  root: THREE.Object3D,
  dimMaterial: (material: THREE.Material) => THREE.Material,
) {
  const groups = new Map<
    string,
    THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>[]
  >();
  root.traverse((node) => {
    if (
      !(node instanceof THREE.Mesh) ||
      !node.visible ||
      !(node.material instanceof THREE.MeshStandardMaterial) ||
      node.material.transparent ||
      node.matrixWorld.determinant() <= 0
    )
      return;
    const key = `${node.geometry.uuid}:${node.material.uuid}:${node.renderOrder}:${node.layers.mask}`;
    const list = groups.get(key) ?? [];
    list.push(
      node as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>,
    );
    groups.set(key, list);
  });
  const instances = [...groups.values()]
    .filter((meshes) => meshes.length > 1)
    .map((meshes) => {
      const sourceMaterial = meshes[0].material;
      const dimSource = dimMaterial(
        sourceMaterial,
      ) as THREE.MeshStandardMaterial;
      // Separate material variants keep the renderer's shader cache stable when
      // the same finish is also used by an individually rendered part.
      const normal = new THREE.InstancedMesh(
        meshes[0].geometry,
        sourceMaterial.clone(),
        meshes.length,
      );
      const dim = new THREE.InstancedMesh(
        meshes[0].geometry,
        dimSource.clone(),
        meshes.length,
      );
      for (const draw of [normal, dim]) {
        draw.name = 'hero-instances';
        draw.frustumCulled = false;
        draw.renderOrder = meshes[0].renderOrder;
        draw.layers.mask = meshes[0].layers.mask;
        draw.matrixAutoUpdate = false;
        draw.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        scene.add(draw);
      }
      for (const mesh of meshes) mesh.visible = false;
      return {
        normal,
        dim,
        meshes,
        sourceMaterial,
        dimSource,
        normalMatrices: [] as THREE.Matrix4[],
        dimMatrices: [] as THREE.Matrix4[],
      };
    });
  return {
    update() {
      for (const {
        normal,
        dim,
        meshes,
        sourceMaterial,
        dimSource,
        normalMatrices,
        dimMatrices,
      } of instances) {
        dim.material.color.copy(dimSource.color);
        dim.material.envMapIntensity = dimSource.envMapIntensity;
        dim.material.metalness = dimSource.metalness;
        normal.count = dim.count = 0;
        let normalChanged = false;
        let dimChanged = false;
        for (const mesh of meshes) {
          const draw = mesh.material === sourceMaterial ? normal : dim;
          const index = draw.count++;
          // Compare the original precision, not the Float32 GPU buffer: its
          // rounding would make unchanged transforms appear dirty every frame.
          const matrices = draw === normal ? normalMatrices : dimMatrices;
          const previous = matrices[index];
          if (!previous?.equals(mesh.matrixWorld)) {
            if (previous) previous.copy(mesh.matrixWorld);
            else matrices[index] = mesh.matrixWorld.clone();
            draw.setMatrixAt(index, mesh.matrixWorld);
            if (draw === normal) normalChanged = true;
            else dimChanged = true;
          }
        }
        if (normalChanged) normal.instanceMatrix.needsUpdate = true;
        if (dimChanged) dim.instanceMatrix.needsUpdate = true;
        normal.visible = normal.count > 0;
        dim.visible = dim.count > 0;
      }
    },
    dispose() {
      for (const {normal, dim, meshes} of instances) {
        normal.removeFromParent();
        dim.removeFromParent();
        normal.dispose();
        dim.dispose();
        normal.material.dispose();
        dim.material.dispose();
        for (const mesh of meshes) mesh.visible = true;
      }
    },
  };
}
