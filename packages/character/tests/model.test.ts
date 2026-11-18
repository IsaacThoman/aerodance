import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { AnimationMixer, Bone, BoxGeometry, Float32BufferAttribute, Group, Matrix4, MeshBasicMaterial, Skeleton, SkinnedMesh as SkinMesh, Vector3 } from "three";
import type { Object3D, SkinnedMesh } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { cloneCharacter } from '../cloneCharacter.ts';
import { hasRigidSkinning, patchRigidSkinning } from '../rigidSkinning.ts';
import { createSkinBounds } from '../skinBounds.ts';

const bytes = await readFile(
  new URL("../assets/aero-character.glb", import.meta.url),
);
const asset = await new GLTFLoader().parseAsync(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  "",
);

const isSkinnedMesh = (o: Object3D): o is SkinnedMesh => "isSkinnedMesh" in o && o.isSkinnedMesh === true;
const materialName = (mesh: SkinnedMesh) => Array.isArray(mesh.material) ? undefined : mesh.material.name;

test('rigid skin specialization requires an exact single influence and a distinct program', () => {
  assert.equal(hasRigidSkinning(asset.scene), true);
  const geometry = new BoxGeometry();
  const weights = new Float32Array(geometry.attributes.position.count * 4);
  for (let i = 0; i < weights.length; i += 4) weights[i] = 1;
  weights[0] = 0.75; weights[1] = 0.25;
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(weights, 4));
  const material = new MeshBasicMaterial();
  assert.equal(hasRigidSkinning(new SkinMesh(geometry, material)), false);
  const before = material.customProgramCacheKey();
  patchRigidSkinning(material);
  assert.notEqual(material.customProgramCacheKey(), before);
  geometry.dispose(); material.dispose();
});

test('skin sharing keeps different bone palettes separate even with shared inverses', () => {
  const model = new Group(), a = new Bone(), b = new Bone();
  const geometry = new BoxGeometry(), material = new MeshBasicMaterial();
  const inverses = [new Matrix4(), new Matrix4()];
  const first = new SkinMesh(geometry, material), second = new SkinMesh(geometry, material);
  first.bind(new Skeleton([a, b], inverses), new Matrix4());
  second.bind(new Skeleton([b, a], inverses), new Matrix4());
  model.add(a, b, first, second);
  const cloned = cloneCharacter(model);
  assert.notEqual((cloned.children[2] as SkinnedMesh).skeleton, (cloned.children[3] as SkinnedMesh).skeleton);
  geometry.dispose(); material.dispose();
});

test('shared character skins retain every mesh palette, bind transform and deformed vertex', () => {
  const original = clone(asset.scene), optimized = cloneCharacter(asset.scene), other = cloneCharacter(asset.scene);
  const meshes = (model: Object3D) => {
    const parts: SkinnedMesh[] = [];
    model.traverse((o) => { if (isSkinnedMesh(o)) parts.push(o); });
    return parts;
  };
  const before = meshes(original), after = meshes(optimized);
  assert.equal(new Set(after.map((mesh) => mesh.skeleton)).size, 1);
  assert.equal(before.length, 8);
  assert.notEqual(after[0].skeleton, meshes(other)[0].skeleton, 'dancers must remain independent');
  assert.notEqual(after[0].skeleton.bones[0], meshes(other)[0].skeleton.bones[0]);
  const a = new AnimationMixer(original), b = new AnimationMixer(optimized);
  for (const clip of asset.animations) {
    a.stopAllAction(); b.stopAllAction();
    a.clipAction(clip).play(); b.clipAction(clip).play();
    for (const time of [0, 0.13, 0.5, 1.7]) {
      a.setTime(time); b.setTime(time);
      original.updateMatrixWorld(true); optimized.updateMatrixWorld(true);
      after[0].skeleton.update();
      before.forEach((mesh, i) => {
        mesh.skeleton.update();
        assert.deepEqual(after[i].skeleton.boneMatrices, mesh.skeleton.boneMatrices);
        assert.deepEqual(after[i].bindMatrix, mesh.bindMatrix);
        assert.deepEqual(after[i].bindMatrixInverse, mesh.bindMatrixInverse);
        for (let v = 0; v < mesh.geometry.attributes.position.count; v++) {
          assert.deepEqual(after[i].getVertexPosition(v, new Vector3()), mesh.getVertexPosition(v, new Vector3()));
        }
      });
    }
  }
});

test("export contains the reference silhouette, two arms, two feet, and no invented face details", () => {
  const meshes: SkinnedMesh[] = [];
  asset.scene.traverse((o) => {
    if (isSkinnedMesh(o)) meshes.push(o);
  });
  const bodyParts = meshes.filter((o) => materialName(o) === "AquaGel");
  assert.equal(bodyParts.length, 6);
  assert.equal(bodyParts.filter((o) => o.name.startsWith("Arm")).length, 2);
  assert.equal(bodyParts.filter((o) => o.name.startsWith("Foot")).length, 2);
  assert.equal(meshes.filter((o) => materialName(o) === "Ink").length, 2);
  assert.ok(!meshes.some((o) => /Smile|Glint/.test(o.name)));
  const head = bodyParts.find((o) => o.name.startsWith("Head"));
  const torso = bodyParts.find((o) => o.name.startsWith("Body"));
  assert.ok(head && torso);
  head.geometry.computeBoundingBox();
  torso.geometry.computeBoundingBox();
  assert.ok(head.geometry.boundingBox && torso.geometry.boundingBox);
  const headSize = head.geometry.boundingBox.getSize(new Vector3());
  const bodySize = torso.geometry.boundingBox.getSize(new Vector3());
  assert.ok(Math.abs(headSize.x - 1.29) < 0.01);
  assert.ok(Math.abs(bodySize.y / headSize.y - 145 / 129) < 0.04);
  assert.ok(bodySize.x / headSize.x > 1 && bodySize.x / headSize.x < 1.1);
  for (const mesh of bodyParts) {
    assert.equal(mesh.skeleton.bones.length, 7);
    const weights = mesh.geometry.attributes.skinWeight;
    for (let i = 0; i < weights.count; i++) {
      assert.ok(
        Math.abs(
          weights.getX(i) +
            weights.getY(i) +
            weights.getZ(i) +
            weights.getW(i) -
            1,
        ) < 0.001,
      );
    }
  }
});

test("four usable clips animate the actual exported skeleton", () => {
  assert.deepEqual(asset.animations.map((a) => a.name).sort(), [
    "Dance",
    "Idle",
    "Walk",
    "Wave",
  ]);
  const mixer = new AnimationMixer(asset.scene);
  const arm = asset.scene.getObjectByName("ArmR");
  const wave = asset.animations.find((c) => c.name === "Wave");
  assert.ok(arm && wave);
  const rest = arm.quaternion.clone();
  mixer.clipAction(wave).play();
  mixer.update(0.5);
  assert.ok(
    rest.angleTo(arm.quaternion) > 1.8,
    "Wave must raise the arm, not just spin it in place",
  );
  mixer.stopAllAction();
  mixer.uncacheRoot(asset.scene);
  for (const clip of asset.animations) {
    assert.ok(clip.duration >= 1);
    for (const track of clip.tracks) {
      assert.ok([...track.values].every(Number.isFinite));
      assert.equal((asset.scene.getObjectByName(track.name.split('.')[0]) as Bone).isBone, true, 'the shipped clips only animate bones');
    }
  }
});

test('each glass part sorts and culls where its bone has moved it', () => {
  const model = cloneCharacter(asset.scene), parent = new Group();
  parent.add(model);
  parent.position.set(2, 0, 0); parent.scale.set(-1, 1, 1);
  parent.updateMatrixWorld(true);
  const update = createSkinBounds(model);
  const part = (name: string) => model.getObjectByName(name) as SkinnedMesh;
  const world = (mesh: SkinnedMesh) => mesh.boundingSphere!.center.clone().applyMatrix4(mesh.matrixWorld);
  update();
  const hand = part('ArmL_1'), body = part('Body_1');
  assert.ok(hand.isSkinnedMesh && body.isSkinnedMesh);
  const rest = world(hand);
  // Rests beside the body, in its plane.
  assert.ok(Math.abs(rest.z - world(body).z) < 0.05);
  // The hand held out in front of the chest: its part sorts nearer the camera (+z) than the body's.
  const bone = model.getObjectByName('ArmL')!, start = new Vector3().setFromMatrixPosition(bone.matrixWorld);
  bone.position.add(new Vector3(0.4, 0.3, 0.8));
  model.updateMatrixWorld(true);
  update();
  const moved = new Vector3().setFromMatrixPosition(bone.matrixWorld).sub(start);
  assert.ok(world(hand).sub(rest).distanceTo(moved) < 1e-6, 'the sphere moves with the bone, through the mirrored parent');
  assert.ok(world(hand).z > world(body).z + 0.7);
});
test('bounds placed before the first render are where that render draws the parts', () => {
  const model = cloneCharacter(asset.scene), parent = new Group();
  parent.add(model);
  parent.position.set(-2, 0, 0);
  const update = createSkinBounds(model);
  const parts: SkinnedMesh[] = [];
  model.traverse((o) => { if (isSkinnedMesh(o)) parts.push(o); });
  const world = (mesh: SkinnedMesh) => mesh.boundingSphere!.center.clone().applyMatrix4(mesh.matrixWorld);
  // Posing updates only the bone hierarchy, as createPoseApplier does; then the renderer updates
  // the meshes' world matrices and culls by the spheres placed in between.
  model.getObjectByName('Root')!.updateWorldMatrix(true, true);
  update();
  model.updateMatrixWorld(true);
  const drawn = parts.map(world);
  update();
  parts.forEach((part, i) => assert.ok(drawn[i].distanceTo(world(part)) < 1e-6, `${part.name} must not be offset by its parent twice`));
});
