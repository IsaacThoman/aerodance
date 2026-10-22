import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { BalloonPop } from '../src/menu/balloonPop.ts';

const meshes = (group: THREE.Group) => group.children as THREE.Mesh<THREE.BufferGeometry, THREE.Material[]>[];
const key = (vector: THREE.Vector3) => [vector.x, vector.y, vector.z].map((value) => Math.fround(value).toFixed(4)).join(',');
const add = (counts: Map<string, number>, value: string) => counts.set(value, (counts.get(value) ?? 0) + 1);

test('the tear starts with every posed dancer triangle, including mirrored eyes, and excludes entrance effects', async () => {
  const bytes = await readFile(new URL('../../../packages/character/assets/aero-character.glb', import.meta.url));
  const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  const mixer = new THREE.AnimationMixer(gltf.scene);
  mixer.clipAction(gltf.animations.find((clip) => clip.name === 'Wave')!).play();
  mixer.update(0.5);
  gltf.scene.scale.x = -1;
  const source = new THREE.Group();
  source.position.set(1.3, 0.1, -0.4);
  source.rotation.set(0.2, 0.3, -0.1);
  source.scale.set(0.9, 1.1, 1.2);
  source.add(gltf.scene);
  const dancerMeshes: THREE.SkinnedMesh[] = [];
  gltf.scene.traverse((object) => {
    if (!(object instanceof THREE.SkinnedMesh)) return;
    if (object.name.startsWith('acc_')) object.visible = false;
    else {
      dancerMeshes.push(object);
      // Character replaces the eyes with an unnamed MeshBasicMaterial.
      if (object.name.startsWith('Eye')) object.material = new THREE.MeshBasicMaterial({ color: '#020611' });
    }
  });
  const entrance = new THREE.Mesh(new THREE.SphereGeometry(10), new THREE.MeshBasicMaterial());
  source.add(entrance);
  const pop = new BalloonPop();
  assert.equal(pop.start(source), true);
  assert.equal(pop.group.children.length, 6, 'only six broad flaps are created');

  const expected = new Map<string, number>();
  const actual = new Map<string, number>();
  const inverse = source.matrixWorld.clone().invert();
  const point = new THREE.Vector3();
  for (const mesh of dancerMeshes) {
    const relative = new THREE.Matrix4().multiplyMatrices(inverse, mesh.matrixWorld);
    const index = mesh.geometry.getIndex()!;
    for (let vertex = 0; vertex < index.count; vertex++) {
      mesh.getVertexPosition(index.getX(vertex), point).applyMatrix4(relative);
      add(expected, key(point));
    }
  }
  for (const mesh of meshes(pop.group)) {
    const position = mesh.geometry.getAttribute('position');
    for (let vertex = 0; vertex < position.count; vertex++) add(actual, key(point.fromBufferAttribute(position, vertex)));
  }
  assert.deepEqual(actual, expected, 'the snapshot preserves the exact starting silhouette without bubbles');
  pop.dispose();
  mixer.stopAllAction();
  mixer.uncacheRoot(gltf.scene);
});

test('mirrored snapshots preserve outward winding, vertex colors, and source ownership', () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 1, 0, 1, 1, 0, 0, 2, 0], 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1], 3));
  const material = new THREE.MeshPhysicalMaterial({ name: 'AquaGel', vertexColors: true, transparent: true });
  material.onBeforeCompile = () => { throw new Error('the live gel shader must not be used by a snapshot'); };
  const mesh = new THREE.Mesh(geometry, material);
  mesh.scale.x = -1;
  const source = new THREE.Group();
  source.add(mesh);
  const original = Array.from(geometry.getAttribute('position').array);
  let sourceDisposals = 0;
  geometry.addEventListener('dispose', () => { sourceDisposals++; });
  material.addEventListener('dispose', () => { sourceDisposals++; });
  const pop = new BalloonPop();
  assert.equal(pop.start(source), true);
  const snapshot = meshes(pop.group)[0];
  assert.notEqual(snapshot.material[0], material);
  assert.doesNotThrow(() => snapshot.material[0].onBeforeCompile({} as never, {} as never));
  const positions = snapshot.geometry.getAttribute('position');
  const a = new THREE.Vector3().fromBufferAttribute(positions, 0);
  const b = new THREE.Vector3().fromBufferAttribute(positions, 1);
  const c = new THREE.Vector3().fromBufferAttribute(positions, 2);
  assert.ok(b.sub(a).cross(c.sub(a)).z > 0, 'mirroring must reverse the baked triangle order');
  assert.deepEqual(Array.from(snapshot.geometry.getAttribute('color').array), [1, 0, 0, 0, 0, 1, 0, 1, 0]);
  let ownedDisposals = 0;
  snapshot.geometry.addEventListener('dispose', () => { ownedDisposals++; });
  snapshot.material[0].addEventListener('dispose', () => { ownedDisposals++; });
  assert.equal(pop.update(0.12), true);
  assert.notDeepEqual(Array.from(snapshot.geometry.getAttribute('position').array), original);
  assert.deepEqual(Array.from(geometry.getAttribute('position').array), original);
  assert.ok(Array.from(snapshot.geometry.getAttribute('position').array).every(Number.isFinite));
  pop.reset();
  pop.dispose();
  assert.equal(ownedDisposals, 2, 'reset disposes owned geometry/material once');
  assert.equal(sourceDisposals, 0, 'source resources are never disposed');
  assert.equal(pop.group.visible, false);
  assert.equal(pop.group.children.length, 0);
});

test('hidden dancers are skipped, and rapid restarts or completion leave no stale flaps', () => {
  const source = new THREE.Group();
  const material = new THREE.MeshPhysicalMaterial({ name: 'AquaGel', transparent: true });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.8, 12, 8), material);
  mesh.position.y = 1.5;
  source.add(mesh);
  const pop = new BalloonPop();
  source.visible = false;
  assert.equal(pop.start(source), false);
  source.visible = true;
  material.opacity = 0;
  assert.equal(pop.start(source), false);
  material.opacity = 1;
  assert.equal(pop.start(source), true);
  const previous = meshes(pop.group)[0];
  let disposed = 0;
  previous.geometry.addEventListener('dispose', () => { disposed++; });
  assert.equal(pop.update(0.1), true);
  assert.equal(pop.start(source), true);
  assert.equal(disposed, 1, 'a restart releases the earlier snapshot');
  assert.equal(pop.group.children.length, 6);
  assert.equal(pop.update(0.61), true);
  assert.equal(pop.update(0.02), false);
  assert.equal(pop.update(0.1), false);
  assert.equal(pop.group.visible, false);
  assert.equal(pop.group.children.length, 0);
  pop.dispose();
});
