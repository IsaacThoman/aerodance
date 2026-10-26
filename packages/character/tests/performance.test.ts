import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Euler, Frustum, Group, Matrix4, OrthographicCamera, Quaternion, Vector3 } from 'three';
import type { Object3D, SkinnedMesh } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { neutralCharacterPose } from '../../pose/performance.ts';
import { createPerformanceApplier } from '../performance.ts';
import { createPoseApplier, calibratePoses } from '../retarget.ts';
import { createSkinBounds } from '../skinBounds.ts';

const bytes = await readFile(new URL('../assets/aero-character.glb', import.meta.url));
const asset = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
function vertices(model: Object3D, prefix: string) {
  model.updateMatrixWorld(true);
  let mesh: SkinnedMesh | undefined;
  model.traverse(o => { if ('isSkinnedMesh' in o && o.isSkinnedMesh && o.name.startsWith(prefix)) mesh = o as SkinnedMesh; });
  assert.ok(mesh); mesh.skeleton.update();
  const inverse = new Matrix4().copy(model.matrixWorld).invert();
  return Array.from({ length: mesh.geometry.attributes.position.count }, (_, i) => mesh!.getVertexPosition(i, new Vector3()).applyMatrix4(mesh!.matrixWorld).applyMatrix4(inverse));
}
test('a squashed and turned body does not distort independently posed heads or hands', () => {
  const model = clone(asset.scene), apply = createPerformanceApplier(model), p = neutralCharacterPose();
  p.head = [0, 0, 0]; apply(p);
  const head = vertices(model, 'Head');
  // Include the game's mirror and a nonuniformly scaled, rotated stage parent.
  const parent = new Group(); parent.position.set(2, -3, 1); parent.rotation.set(.2, -.4, .1); parent.scale.set(-1.4, .8, 1.1); parent.add(model);
  p.body = [1, .5, -.2]; p.bodyRotation = [76, 17, -8]; p.bodyScale = [.8, .45, .7];
  p.head = [1.2, .6, 1]; p.headRotation = [12, 25, -7]; p.headScale = .7;
  p.leftHand = [1.8, .2, 1.2]; p.rightHand = [.4, .2, 1.1]; p.handScale = .8;
  apply(p);
  const rotation = new Quaternion().setFromEuler(new Euler(...p.headRotation.map(x => x * Math.PI / 180) as [number, number, number]));
  const actual = vertices(model, 'Head');
  head.forEach((v, i) => assert.ok(actual[i].distanceTo(v.multiplyScalar(.7).applyQuaternion(rotation).add(new Vector3(...p.head))) < 1e-5));
  for (const [name, centre, pivot] of [['ArmR', p.leftHand, [.26, -.86, 0]], ['ArmL', p.rightHand, [-.26, -.86, 0]]] as const) {
    const b = model.getObjectByName(name)!;
    const at = new Vector3(...pivot).applyMatrix4(b.matrixWorld).applyMatrix4(new Matrix4().copy(model.matrixWorld).invert());
    assert.ok(at.distanceTo(new Vector3(...centre)) < 1e-5);
  }
});
test('scaled parts keep enclosing culling bounds and restore their radii when a performance ends', () => {
  const model = clone(asset.scene), apply = createPerformanceApplier(model), update = createSkinBounds(model);
  const meshes: SkinnedMesh[] = [];
  model.traverse(o => { if ('isSkinnedMesh' in o && o.isSkinnedMesh) meshes.push(o as SkinnedMesh); });
  const refresh = () => {
    model.updateMatrixWorld(true);
    for (const mesh of meshes) mesh.skeleton.update();
    update();
  };
  refresh();
  const radii = meshes.map(mesh => mesh.boundingSphere!.radius);
  const p = neutralCharacterPose();
  p.head = [4.2, 0, 0]; p.headScale = 4;
  p.bodyScale = [.5, 2, 1.7]; p.bodyRotation = [76, 17, -8];
  p.handScale = 2; p.footScale = 3;
  apply(p); refresh();
  const head = meshes.find(mesh => mesh.name.startsWith('Head'))!;
  const camera = new OrthographicCamera(-3, 3, 3, -3, .1, 20);
  camera.position.z = 10; camera.updateMatrixWorld(true);
  const frustum = new Frustum().setFromProjectionMatrix(new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  assert.ok(vertices(model, 'Head').some(v => frustum.containsPoint(v)), 'the enlarged head reaches into the viewport');
  assert.ok(frustum.intersectsObject(head), 'the visible enlarged head must not be culled');
  const parent = new Group();
  parent.scale.set(-1.4, .8, 1.1); parent.rotation.set(.2, -.4, .1); parent.add(model);
  apply(p); refresh();
  for (const mesh of meshes) for (let i = 0; i < mesh.geometry.attributes.position.count; i++) {
    const v = mesh.getVertexPosition(i, new Vector3()), sphere = mesh.boundingSphere!;
    assert.ok(v.distanceTo(sphere.center) <= sphere.radius + 1e-5, `${mesh.name} vertex ${i} must fit its bounds`);
  }
  apply(null); refresh();
  meshes.forEach((mesh, i) => assert.ok(Math.abs(mesh.boundingSphere!.radius - radii[i]) < 1e-5, mesh.name));
});

test('leaving a direct performance restores the rig before ordinary pose playback', () => {
  const model = clone(asset.scene), reference = clone(asset.scene), apply = createPerformanceApplier(model);
  const landmarks = Array.from({ length: 33 }, () => ({ x: .5, y: .2, z: 0, confidence: 1 }));
  for (const [i, x, y] of [[11,.56,.3],[12,.44,.3],[23,.56,.55],[24,.44,.55],[15,.67,.3],[16,.33,.3],[27,.56,.9],[28,.44,.9]]) Object.assign(landmarks[i], { x, y });
  const pose = { playerId: 0, landmarks }, calibration = calibratePoses([pose]);
  const keyed = neutralCharacterPose(); keyed.bodyScale = [.7, .5, .8]; keyed.bodyRotation = [80, 5, 0];
  apply(keyed); assert.equal(apply(null), false);
  createPoseApplier(model, calibration)(pose); createPoseApplier(reference, calibration)(pose);
  for (const part of ['Head', 'Body', 'ArmL', 'ArmR', 'FootL', 'FootR']) {
    const a = vertices(model, part), b = vertices(reference, part);
    a.forEach((v, i) => assert.ok(v.distanceTo(b[i]) < 1e-5, part));
  }
});
