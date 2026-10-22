import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { BalloonTear, TEAR_DURATION } from '../src/menu/stageEffects.ts';

const bytes = await readFile(new URL('../../../packages/character/assets/aero-character.glb', import.meta.url));
const asset = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');

function dancer() {
  const model = clone(asset.scene);
  const mixer = new THREE.AnimationMixer(model);
  mixer.clipAction(asset.animations.find((a) => a.name === 'Wave')!).play();
  mixer.update(0.5);
  model.scale.x = -1;
  const source = new THREE.Group();
  source.position.set(3, -2, -19);
  source.rotation.set(0.2, -0.22, 0);
  source.add(model);
  const meshes: THREE.SkinnedMesh[] = [];
  model.traverse((object) => {
    if (object.name.startsWith('acc_')) object.visible = false;
    if (object instanceof THREE.SkinnedMesh && object.visible) meshes.push(object);
  });
  return { source, meshes };
}

const skins = (tear: BalloonTear) => tear.group.children as THREE.Mesh<THREE.BufferGeometry, THREE.Material>[];
function bounds(tear: BalloonTear) {
  const box = new THREE.Box3();
  const point = new THREE.Vector3();
  for (const mesh of skins(tear)) {
    const position = mesh.geometry.getAttribute('position');
    for (const index of mesh.geometry.index!.array) {
      point.fromBufferAttribute(position, index);
      box.expandByPoint(point);
    }
  }
  return box;
}

test('the tear starts with the actual mirrored pose, retaining every visible skin triangle exactly once', () => {
  const { source, meshes } = dancer();
  const tear = new BalloonTear();
  tear.capture(source);
  tear.update(0);
  assert.equal(tear.group.visible, true);
  const expected = meshes.reduce((n, mesh) => n + mesh.geometry.index!.count, 0);
  assert.equal(skins(tear).reduce((n, mesh) => n + mesh.geometry.index!.count, 0), expected);
  const toLocal = source.matrixWorld.clone().invert();
  const point = new THREE.Vector3();
  let panel = 0;
  for (const mesh of meshes) {
    const matrix = new THREE.Matrix4().multiplyMatrices(toLocal, mesh.matrixWorld);
    const original = mesh.geometry.getAttribute('position');
    let triangles = 0;
    while (triangles < mesh.geometry.index!.count) {
      const skin = skins(tear)[panel++];
      assert.notEqual(skin.geometry, mesh.geometry);
      assert.notEqual(skin.material, mesh.material);
      const captured = skin.geometry.getAttribute('position');
      assert.equal(captured.count, original.count);
      for (let i = 0; i < original.count; i++) {
        mesh.getVertexPosition(i, point).applyMatrix4(matrix);
        assert.ok(Math.abs(captured.getX(i) - point.x) < 1e-6);
        assert.ok(Math.abs(captured.getY(i) - point.y) < 1e-6);
        assert.ok(Math.abs(captured.getZ(i) - point.z) < 1e-6);
      }
      triangles += skin.geometry.index!.count;
    }
  }
  assert.equal(panel, skins(tear).length);
  tear.dispose();
});

test('torn skin deflates into thin curled sheets, falls, fades and finishes', () => {
  const { source } = dancer();
  const tear = new BalloonTear();
  tear.capture(source);
  tear.update(0);
  const before = bounds(tear);
  tear.update(0.24);
  const after = bounds(tear);
  assert.ok(after.getSize(new THREE.Vector3()).y < before.getSize(new THREE.Vector3()).y * 0.6);
  assert.ok(after.getSize(new THREE.Vector3()).z < before.getSize(new THREE.Vector3()).z * 0.5);
  assert.ok(after.getCenter(new THREE.Vector3()).y < before.getCenter(new THREE.Vector3()).y);
  for (const skin of skins(tear)) {
    assert.ok([...skin.geometry.getAttribute('normal').array].every(Number.isFinite));
  }
  tear.update(0.54);
  assert.ok(skins(tear).every((skin) => skin.material.opacity > 0 && skin.material.opacity < 0.5));
  tear.update(TEAR_DURATION);
  assert.equal(tear.group.visible, false);
  tear.dispose();
});

test('recapturing or cancelling releases only the torn copies, leaving the dancer reusable', () => {
  const { source, meshes } = dancer();
  const positions = meshes.map((mesh) => Array.from(mesh.geometry.getAttribute('position').array));
  const tear = new BalloonTear();
  let sourceDisposed = false;
  meshes.forEach((mesh) => mesh.geometry.addEventListener('dispose', () => { sourceDisposed = true; }));
  for (let i = 0; i < 3; i++) {
    tear.capture(source);
    tear.update(0.3);
    const copies = skins(tear).length;
    let disposed = 0;
    skins(tear).forEach((skin) => {
      skin.geometry.addEventListener('dispose', () => { disposed++; });
      skin.material.addEventListener('dispose', () => { disposed++; });
    });
    tear.capture(new THREE.Group());
    assert.equal(disposed, copies * 2);
    assert.equal(tear.group.visible, false);
    assert.equal(tear.group.children.length, 0);
  }
  assert.equal(sourceDisposed, false);
  meshes.forEach((mesh, i) => assert.deepEqual(Array.from(mesh.geometry.getAttribute('position').array), positions[i]));
});
