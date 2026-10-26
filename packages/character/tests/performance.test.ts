import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Euler, Group, Matrix4, Quaternion, Vector3 } from 'three';
import type { Object3D, SkinnedMesh } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { neutralCharacterPose } from '../../pose/performance.ts';
import { createPerformanceApplier } from '../performance.ts';
import { createPoseApplier, calibratePoses } from '../retarget.ts';

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
