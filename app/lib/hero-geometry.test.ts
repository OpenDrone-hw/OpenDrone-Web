import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import * as THREE from 'three';
import {
  instanceHeroDraws,
  mergeHeroGeometry,
  updateHeroMatrices,
} from './hero-geometry.ts';

function triangle() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3),
  );
  geometry.setIndex([0, 1, 2]);
  geometry.computeVertexNormals();
  return geometry;
}

function vertices(root: THREE.Object3D) {
  root.updateWorldMatrix(true, true);
  const points: number[][] = [];
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    const positions = node.geometry.attributes.position;
    for (let i = 0; i < positions.count; i++) {
      points.push(
        new THREE.Vector3()
          .fromBufferAttribute(positions, i)
          .applyMatrix4(node.matrixWorld)
          .toArray(),
      );
    }
  });
  return points.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
}

describe('hero geometry fidelity', () => {
  it('invalidates only changed transforms while propagating parent movement', () => {
    const root = new THREE.Group();
    const child = new THREE.Group();
    root.add(child);
    root.matrixAutoUpdate = child.matrixAutoUpdate = false;
    root.updateMatrixWorld(true);
    const moving = new Set([root, child]);
    updateHeroMatrices(moving);
    assert.equal(root.matrixWorldNeedsUpdate, false);
    assert.equal(child.matrixWorldNeedsUpdate, false);
    root.position.x = 3;
    updateHeroMatrices(moving);
    assert.equal(root.matrixWorldNeedsUpdate, true);
    root.updateMatrixWorld();
    assert.equal(child.matrixWorld.elements[12], 3);
    child.position.y = 2;
    updateHeroMatrices(moving);
    assert.equal(root.matrixWorldNeedsUpdate, false);
    root.updateMatrixWorld();
    assert.equal(child.matrixWorld.elements[13], 2);
  });
  it('preserves world-space vertices and independent part animation after merging', () => {
    const root = new THREE.Group();
    const material = new THREE.MeshStandardMaterial();
    const parts = [new THREE.Group(), new THREE.Group()];
    for (const [i, part] of parts.entries()) {
      part.position.set(i * 5, 2, 0);
      root.add(part);
      for (let j = 0; j < 2; j++) {
        const mesh = new THREE.Mesh(triangle(), material);
        mesh.position.set(j * 2, 0, 1);
        mesh.rotation.z = 0.3;
        mesh.scale.set(1.2, 0.8, 1);
        part.add(mesh);
      }
    }
    const reference = root.clone(true);
    const cleanup = mergeHeroGeometry(root, new Set(parts));
    assert.deepEqual(
      parts.map((part) => part.children.length),
      [1, 1],
    );
    for (const angle of [0, 0.3, 1.5]) {
      parts[0].rotation.y = angle;
      reference.children[0].rotation.y = angle;
      const before = vertices(reference);
      const after = vertices(root);
      assert.equal(after.length, before.length);
      for (let i = 0; i < before.length; i++)
        for (let c = 0; c < 3; c++)
          assert.ok(Math.abs(before[i][c] - after[i][c]) < 0.000001);
    }
    assert.equal(parts[0].matrixAutoUpdate, true);
    assert.equal(parts[0].children[0].matrixAutoUpdate, false);
    cleanup();
  });

  it('keeps transparent and mirrored parts out of opaque geometry merges', () => {
    const root = new THREE.Group();
    const transparent = new THREE.MeshStandardMaterial({
      transparent: true,
      opacity: 0.5,
    });
    const opaque = new THREE.MeshStandardMaterial();
    const meshes = [
      new THREE.Mesh(triangle(), transparent),
      new THREE.Mesh(triangle(), transparent),
      new THREE.Mesh(triangle(), opaque),
      new THREE.Mesh(triangle(), opaque),
    ];
    meshes[2].scale.x = -1;
    meshes[3].scale.x = -1;
    root.add(...meshes);
    const cleanup = mergeHeroGeometry(root, new Set());
    assert.deepEqual(root.children, meshes);
    cleanup();
  });

  it('preserves each instance transform and spotlight material without duplicating vertex buffers', () => {
    const scene = new THREE.Scene();
    const root = new THREE.Group();
    scene.add(root);
    const material = new THREE.MeshStandardMaterial();
    const dimMaterial = material.clone();
    const first = new THREE.Mesh(triangle(), material);
    first.position.x = 0.1234;
    const second = new THREE.Mesh(first.geometry, material);
    second.position.set(4, 2, 1);
    root.add(first, second);
    scene.updateMatrixWorld(true);
    const batch = instanceHeroDraws(scene, root, () => dimMaterial);
    batch.update();
    const draws = scene.children.filter(
      (node): node is THREE.InstancedMesh =>
        node instanceof THREE.InstancedMesh,
    );
    assert.equal(draws.length, 2);

    assert.equal(draws[0].geometry, draws[1].geometry);
    assert.equal(draws[0].visible, true);
    assert.equal(draws[1].visible, false);
    const version = draws[0].instanceMatrix.version;
    batch.update();
    assert.equal(draws[0].instanceMatrix.version, version);
    const matrix = new THREE.Matrix4();
    draws[0].getMatrixAt(1, matrix);
    assert.ok(matrix.equals(second.matrixWorld));
    draws[0].setMatrixAt(0, new THREE.Matrix4().makeTranslation(9, 0, 0));
    draws[1].getMatrixAt(0, matrix);
    assert.equal(matrix.elements[12], 0);
    draws[0].setMatrixAt(0, first.matrixWorld);
    second.material = dimMaterial;
    second.position.x = 7;
    scene.updateMatrixWorld(true);
    batch.update();
    assert.equal(draws[0].count, 1);
    assert.equal(draws[1].count, 1);
    draws[1].getMatrixAt(0, matrix);
    assert.ok(matrix.equals(second.matrixWorld));
    assert.equal(first.visible, false);
    batch.dispose();
    assert.equal(scene.children.length, 1);
    assert.equal(first.visible, true);
    assert.equal(second.visible, true);
  });
});
