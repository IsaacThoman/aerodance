import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Box3, Group, Vector3 } from "three";
import type { Bone, Object3D, SkinnedMesh } from "three";
import { createPoseApplier, calibratePoses } from '../retarget.ts';
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone } from "three/addons/utils/SkeletonUtils.js";
import {
  loadMotion,
  samplePose,
  createRetargeter,
} from "../motion.ts";
import { isObject, qualityFor, sampleSnapshot } from "../../pose/choreography.ts";
import type { FrameSize, Pose } from "../../pose/choreography.ts";
import type { MotionTake } from "../../pose/motion.ts";

const bytes = await readFile(new URL("../assets/dance.adpose", import.meta.url));
const data = loadMotion(bytes);
/** A tracking report figure the legacy migration preserved in the provenance. */
const report = (key: string): number[] => {
  const value = isObject(data.provenance) && isObject(data.provenance.report) ? data.provenance.report[key] : undefined;
  assert.ok(Array.isArray(value) && value.every((n) => typeof n === "number"));
  return value;
};
const buffer = await readFile(
  new URL("../assets/aero-character.glb", import.meta.url),
);
const asset = await new GLTFLoader().parseAsync(
  buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  "",
);

const isSkinnedMesh = (o: Object3D): o is SkinnedMesh => "isSkinnedMesh" in o && o.isSkinnedMesh === true;
const isBone = (o: Object3D): o is Bone => "isBone" in o && o.isBone === true;
const node = (model: Object3D, name: string) => {
  const object = model.getObjectByName(name);
  assert.ok(object, `missing ${name}`);
  return object;
};
function meshBounds(model: Object3D, prefix: string) {
  let mesh: SkinnedMesh | undefined;
  model.traverse(o => { if (isSkinnedMesh(o) && o.name.startsWith(prefix)) mesh = o; });
  assert.ok(mesh);
  mesh.skeleton.update();
  const bounds = new Box3(), vertex = new Vector3();
  for (let i = 0; i < mesh.geometry.attributes.position.count; i++)
    bounds.expandByPoint(mesh.getVertexPosition(i, vertex).applyMatrix4(mesh.matrixWorld));
  return bounds;
}
function standingPose(): Pose {
  const landmarks = Array.from({ length: 33 }, () => ({ x: .5, y: .2, z: 0, confidence: 1 }));
  for (const [i, x, y] of [[11,.56,.3],[12,.44,.3],[23,.56,.55],[24,.44,.55],
    [15,.67,.3],[16,.33,.3],[27,.56,.9],[28,.44,.9]]) Object.assign(landmarks[i], { x, y });
  return { playerId: 0, landmarks };
}

/** The original menu sampler: keep the shared snapshot path as an independent oracle. */
function referenceSamplePose(take: MotionTake, person: number, seconds: number): Pose | null {
  const time = ((seconds * 1000 % take.durationMs) + take.durationMs) % take.durationMs;
  const last = take.samples[take.samples.length - 1].takeTimeMs;
  const snapshot = sampleSnapshot(take.samples, Math.min(time, last), 'takeTimeMs', 200);
  const pose = snapshot.poses.find(p => p.playerId === person);
  if (!pose) return null;
  const seam = Math.min(350, take.durationMs / 4);
  const blend = Math.max(0, Math.min(1, (time - (take.durationMs - seam)) / seam));
  const smooth = blend * blend * (3 - 2 * blend);
  const first = take.samples[0].poses.find(p => p.playerId === person);
  if (first) pose.landmarks.forEach((joint, i) => {
    for (const axis of ['x', 'y', 'z'] as const) joint[axis] += (first.landmarks[i][axis] - joint[axis]) * smooth;
  });
  return pose;
}

function samplingTimes(take: MotionTake): number[] {
  const seam = Math.min(350, take.durationMs / 4);
  const times = new Set([0, -0.0001, take.durationMs - seam, take.durationMs - seam / 2,
    take.durationMs - 0.0001, take.durationMs, take.durationMs + 0.0001,
    -take.durationMs, -2 * take.durationMs - 123.456, 3 * take.durationMs + 123.456]);
  for (let i = 0; i < take.samples.length; i++) {
    const t = take.samples[i].takeTimeMs;
    // Both sides of the shared sampler's 1e-5 ms exact-frame tolerance.
    for (const offset of [-0.00002, -0.000005, 0, 0.000005, 0.00002]) times.add(t + offset);
    const next = take.samples[i + 1];
    if (next) for (const alpha of [.25, .5, .75]) times.add(t + (next.takeTimeMs - t) * alpha);
  }
  for (let t = 0; t < take.durationMs; t += 1000 / 60) times.add(t);
  return Array.from(times, t => t / 1000);
}

function samplingFixture(durationMs: number, frames: readonly (readonly [number, readonly number[]])[]): MotionTake {
  return {
    schema: 'aerodance.take', schemaVersion: 1, durationMs,
    input: { width: 640, height: 480, mirrored: false },
    samples: frames.map(([takeTimeMs, people], frame) => {
      const poses = people.map(playerId => {
        const pose = standingPose();
        pose.playerId = playerId;
        pose.landmarks.forEach((joint, i) => {
          joint.x += Math.sin(frame + i) * .1 + playerId * .15;
          joint.y += Math.cos(frame + i) * .05;
          joint.z = Math.sin(frame * .3 + i) * .2;
          joint.confidence = [null, 0, .49, .5, .85, 1][(frame + i + playerId) % 6];
        });
        return pose;
      });
      const quality = qualityFor(poses);
      for (const q of quality) {
        q.landmarkOrigins[0] = 'edited';
        q.landmarkOrigins[1] = 'gap-repaired';
        q.reviewed = true;
      }
      return { takeTimeMs, poses, ...(frame % 2 ? { quality } : {}) };
    }),
  };
}

const sparseTake = samplingFixture(1600, [
  [50, [1]], [100, [0, 1]], [300, [0, 1]], [500.0001, [0, 1]],
  [550, [1]], [600, [0]], [650, []], [700, [1]], [900, [0, 1]],
  [1200, [0, 1]], [1300, [0, 1]], [1400, [0]], [1500, [0, 1]],
]);
const shortTake = samplingFixture(400, [[0, [0, 1]], [100, [0, 1]], [200, [0, 1]], [300, [0, 1]]]);

test('webcam distance compensation keeps hands, feet and root consistent across framing and aspect ratios', () => {
  const reference = standingPose();
  reference.landmarks.forEach((p,i) => { p.x -= .2; p.z=(i-20)*.003; });
  const names=['Root','Body','Head','ArmL','ArmR','FootL','FootR'];
  const project=(pose: Pose,zoom: number,aspect: number): Pose=>({ ...pose, landmarks:pose.landmarks.map(p=>({ ...p,
    x:.5+(p.x-.5)*zoom*(4/3)/aspect,y:.5+(p.y-.5)*zoom,z:p.z*zoom*(4/3)/aspect,
  })) });
  const baseline=clone(asset.scene);
  createPoseApplier(baseline,calibratePoses([reference],{width:640,height:480},{adaptiveDistance:true}))(reference);
  for(const input of [{width:640,height:480},{width:1280,height:720},{width:480,height:640}] satisfies FrameSize[]) {
    const aspect=input.width/input.height;
    const neutral=project(reference,1,aspect), model=clone(asset.scene);
    // Retain the near calibration while the dancer moves back; do not silently
    // recalibrate every frame to make the regression pass.
    const apply=createPoseApplier(model,calibratePoses([neutral],input,{adaptiveDistance:true}));
    for(const zoom of [.35,.6,1,1.2]) {
      const projected=project(reference,zoom,aspect), raw=structuredClone(projected);
      apply(projected);
      for(const name of names) {
        const expected=node(baseline,name), actual=node(model,name);
        assert.ok(actual.position.distanceTo(expected.position)<1e-6, `${name} position at framing ${zoom}, aspect ${aspect}`);
        assert.ok(actual.quaternion.angleTo(expected.quaternion)<1e-6, `${name} orientation`);
      }
      assert.deepEqual(projected,raw);
    }
  }
});
test('original wrist reach and continuous foot depth are preserved', () => {
  const model=clone(asset.scene), standing=standingPose();
  const calibration=calibratePoses([standing]);
  const apply=createPoseApplier(model,calibration);
  apply(standing);
  assert.ok(Math.abs(meshBounds(model,'ArmR').getCenter(new Vector3()).x-.952)<1e-5);
  assert.ok(Math.abs(meshBounds(model,'ArmL').getCenter(new Vector3()).x+.952)<1e-5);
  for(const y of [.9,.897,.894,.85,.65]) {
    const lifted=structuredClone(standing); lifted.landmarks[27].y=lifted.landmarks[28].y=y;
    const raw=structuredClone(lifted); apply(lifted);
    for(const side of ['L','R']) {
      const foot=meshBounds(model,`Foot${side}`);
      assert.ok(Math.abs(foot.getCenter(new Vector3()).z)<1e-5,'feet do not snap forward at the torso boundary');
      assert.ok(foot.min.y>=0,'feet stay above the floor');
    }
    assert.deepEqual(lifted,raw);
  }
});
test('live distance smoothing damps torso noise without changing recorded playback', () => {
  const standing=standingPose(), calibration=calibratePoses([standing],undefined,{adaptiveDistance:true});
  const live=clone(asset.scene), recorded=clone(asset.scene);
  const applyLive=createPoseApplier(live,calibration,{smoothDistance:true});
  const applyRecorded=createPoseApplier(recorded,calibration);
  applyLive(standing); applyRecorded(standing);
  const initial=meshBounds(live,'ArmR').getCenter(new Vector3()).x;
  const noise=structuredClone(standing); noise.landmarks[11].y-=.01; noise.landmarks[12].y-=.01;
  applyLive(noise,1/60); applyRecorded(noise);
  const liveJump=Math.abs(meshBounds(live,'ArmR').getCenter(new Vector3()).x-initial);
  const recordedJump=Math.abs(meshBounds(recorded,'ArmR').getCenter(new Vector3()).x-initial);
  assert.ok(liveJump<recordedJump/5,'a single noisy torso measurement cannot resize the whole avatar');
  for(let i=0;i<150;i++) applyLive(standing,1/60);
  assert.ok(Math.abs(meshBounds(live,'ArmR').getCenter(new Vector3()).x-initial)<1e-5);
});


test("capture has two finite, timestamped tracks and usable tracking coverage", () => {
  assert.deepEqual(loadMotion(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)), data);
  assert.ok(data.samples.length > 300);
  assert.ok(report("reliableJointFraction").every((n) => n > 0.9));
  assert.ok(report("longestMissingRun").every((n) => n <= 10));
  assert.throws(() => loadMotion(bytes.subarray(0, 1000)));
});

test("timestamp interpolation, negative time and loop seam remain continuous", () => {
  const a = samplePose(data, 0, 4);
  assert.deepEqual(samplePose(data, 0, 4 + (data.durationMs / 1000)), a);
  const first = samplePose(data, 0, 0);
  const end = samplePose(data, 0, -0.0001);
  assert.ok(first && end);
  assert.ok(Math.abs(first.landmarks[15].x - end.landmarks[15].x) < 0.0001);
  const mid = (data.samples[30].takeTimeMs + data.samples[31].takeTimeMs) / 2000;
  const between = samplePose(data, 1, mid);
  assert.ok(between);
  assert.ok(
    Math.abs(
      between.landmarks[15].x -
        (data.samples[30].poses[1].landmarks[15].x + data.samples[31].poses[1].landmarks[15].x) / 2,
    ) < 1e-8,
  );
});

test('pose-only sampling exactly matches snapshots across full tracks, loop seams, gaps and confidences', () => {
  for (const take of [data, sparseTake, shortTake]) {
    const original = structuredClone(take);
    for (const person of [0, 1, 2]) for (const seconds of samplingTimes(take)) {
      assert.deepEqual(samplePose(take, person, seconds), referenceSamplePose(take, person, seconds),
        `person ${person} at ${seconds}s in ${take.durationMs}ms take`);
    }
    assert.deepEqual(take, original, 'sampling must not mutate capture poses or quality');
  }
  assert.ok(samplePose(sparseTake, 0, .2), 'a 200ms gap is interpolated');
  assert.equal(samplePose(sparseTake, 0, .4), null, 'a gap over 200ms is not interpolated');
  assert.equal(samplePose(sparseTake, 0, .525), null, 'a missing right slot is not interpolated');
  assert.equal(samplePose(sparseTake, 0, .575), null, 'a missing left slot is not interpolated');
  assert.equal(samplePose(sparseTake, 1, .625), null, 'an empty frame is not bridged');
  assert.equal(samplePose(sparseTake, 1, 0), null, 'time before the first capture is absent');
});

test('public sampled poses remain independent of the capture and subsequent samples', () => {
  for (const seconds of [0, .05, .35, -.0001]) {
    const a = samplePose(shortTake, 0, seconds), b = samplePose(shortTake, 0, seconds);
    assert.ok(a && b);
    assert.notEqual(a, b);
    assert.notEqual(a.landmarks, b.landmarks);
    for (let i = 0; i < a.landmarks.length; i++) assert.notEqual(a.landmarks[i], b.landmarks[i]);
    a.landmarks[0].x += 100;
    assert.deepEqual(b, referenceSamplePose(shortTake, 0, seconds));
    assert.deepEqual(samplePose(shortTake, 0, seconds), b);
  }
});

test('reused retargeter sampling preserves rig transforms and visibility through playback and seeks', () => {
  const names = ['Root', 'Body', 'Head', 'ArmL', 'ArmR', 'FootL', 'FootR'];
  for (const take of [data, sparseTake, shortTake]) {
    const original = structuredClone(take), times = samplingTimes(take);
    // Seek backward after advancing through the track and across multiple loops.
    times.push(...times.slice().reverse().filter((_, i) => i % 17 === 0));
    for (const person of [0, 1, 2]) {
      const actual = clone(asset.scene), expected = clone(asset.scene);
      const apply = createRetargeter(actual, take, person);
      const referenceApply = createPoseApplier(expected, calibratePoses(
        take.samples.flatMap(s => s.poses.filter(p => p.playerId === person)), take.input,
      ));
      const bones = names.map(name => [node(actual, name), node(expected, name)]);
      for (const seconds of times) {
        apply(seconds);
        referenceApply(referenceSamplePose(take, person, seconds));
        assert.equal(actual.visible, expected.visible, `visibility for person ${person} at ${seconds}s`);
        for (const [a, b] of bones) {
          assert.deepEqual(a.position, b.position, `${a.name} position at ${seconds}s`);
          assert.deepEqual(a.quaternion.toArray(), b.quaternion.toArray(), `${a.name} rotation at ${seconds}s`);
          assert.deepEqual(a.matrixWorld, b.matrixWorld, `${a.name} world transform at ${seconds}s`);
        }
      }
    }
    assert.deepEqual(take, original, 'repeated playback must not blend into the source capture');
  }
});

test('single-person playback never reads other dancers landmarks or quality metadata', () => {
  const take = structuredClone(shortTake);
  for (const sample of take.samples) {
    Object.defineProperty(sample, 'quality', { get() { assert.fail('playback does not consume quality'); } });
    for (const pose of sample.poses) {
      if (pose.playerId !== 0) Object.defineProperty(pose, 'landmarks', {
        get() { assert.fail('playback must only sample its own dancer'); },
      });
      else {
        for (const joint of pose.landmarks) Object.freeze(joint);
        Object.freeze(pose.landmarks);
        Object.freeze(pose);
      }
    }
  }
  const model = clone(asset.scene), apply = createRetargeter(model, take, 0);
  for (const seconds of samplingTimes(take)) {
    apply(seconds);
    assert.equal(model.visible, true);
  }
});

test("cloned skeletons move independently, remain finite and keep feet above the stage", () => {
  const models = [clone(asset.scene), clone(asset.scene)];
  const apply = models.map((m, p) => createRetargeter(m, data, p));
  const fixed = node(models[1], "ArmR").position.clone();
  apply[0](5);
  assert.deepEqual(node(models[1], "ArmR").position, fixed);
  let minX = Infinity,
    maxX = -Infinity;
  for (let t = 0; t < (data.durationMs / 1000); t += 1 / 30)
    for (let p = 0; p < 2; p++) {
      apply[p](t);
      models[p].updateMatrixWorld(true);
      models[p].traverse((o) => {
        if (isBone(o)) assert.ok(o.matrixWorld.elements.every(Number.isFinite));
      });
      for (const name of ["FootL", "FootR"])
        assert.ok(
          node(models[p], name).getWorldPosition(new Vector3()).y >=
            0.299,
        );
      const hand = node(models[p], "ArmR")
        .getWorldPosition(new Vector3());
      minX = Math.min(minX, hand.x);
      maxX = Math.max(maxX, hand.x);
    }
  assert.ok(
    maxX - minX > 0.5,
    "the recording must produce substantial hand motion",
  );
});

test("retargeting preserves the pose under moving, rotated and nonuniformly scaled parents", () => {
  const names = ["Root", "Body", "Head", "ArmL", "ArmR", "FootL", "FootR"];
  for (const person of [0, 1]) {
    const local = clone(asset.scene), transformed = clone(asset.scene);
    const parent = new Group(), grandparent = new Group();
    parent.add(transformed);
    grandparent.add(parent);
    const applyLocal = createRetargeter(local, data, person);
    const applyTransformed = createRetargeter(transformed, data, person);
    for (let t = -0.1; t < data.durationMs / 1000 + 0.1; t += 1 / 30) {
      parent.position.set(Math.sin(t), 0.4, 3);
      parent.rotation.set(0.2, Math.sin(t) * 0.7, -0.1);
      parent.scale.set(1.3, 0.8, 0.9);
      grandparent.rotation.y = t * 0.1;
      grandparent.position.y = Math.cos(t);
      // Deliberately leave the ancestor matrices stale, as they are between
      // frame callbacks and the renderer's scene update.
      applyLocal(t);
      applyTransformed(t);
      for (const name of names) {
        const a = node(local, name), b = node(transformed, name);
        assert.ok(a.position.distanceTo(b.position) < 1e-10, `${name} position at ${t}`);
        assert.ok(a.quaternion.toArray().every((n, i) => Math.abs(n - b.quaternion.toArray()[i]) < 1e-10));
      }
    }
  }
});
