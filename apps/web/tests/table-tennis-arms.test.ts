import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Landmark, NormalizedLandmark } from '@mediapipe/tasks-vision';
import { ARM, depthOf, focalLength, handPose, reachable } from '../src/minigames/table-tennis/arms.ts';
import type { HandInput, Side, Vec3 } from '../src/minigames/table-tennis/arms.ts';

/*
 * A player made of 3D points in camera space (x right, y down, z away, metres), projected through
 * a camera with a known field of view, as the trackers would report them.
 */
const SIZE = { width: 1280, height: 720 };
const FOV = 65;
const f = focalLength(SIZE.width, FOV);
const project = (p: Vec3): NormalizedLandmark => ({ x: 0.5 + (p.x * f) / p.z / SIZE.width, y: 0.5 + (p.y * f) / p.z / SIZE.height, z: 0, visibility: 1 });
const at = (p: Vec3, o: Vec3): Vec3 => ({ x: p.x + o.x, y: p.y + o.y, z: p.z + o.z });

// The player 2.5 m from the camera, facing it: their right shoulder on the picture's left. A 50 cm
// torso, so arms of the proportions arms.ts assumes: a 31 cm upper arm and a 25 cm forearm.
const BODY = { x: 0, y: 0, z: 2.5 };
const UPPER = 0.31, FORE = 0.25;
const SHOULDER: Record<Side, Vec3> = { left: at(BODY, { x: 0.19, y: -0.5, z: 0 }), right: at(BODY, { x: -0.19, y: -0.5, z: 0 }) };
const unit = (v: Vec3): Vec3 => { const l = Math.hypot(v.x, v.y, v.z); return { x: v.x / l, y: v.y / l, z: v.z / l }; };
/** An arm: its upper arm and forearm pointing these ways (camera space), from its shoulder. */
interface Arm { upper: Vec3; fore: Vec3; }
const HANGING: Arm = { upper: { x: 0, y: 1, z: 0 }, fore: { x: 0, y: 1, z: 0 } };
function joints(side: Side, arm: Arm) {
  const u = unit(arm.upper), f = unit(arm.fore);
  const elbow = at(SHOULDER[side], { x: u.x * UPPER, y: u.y * UPPER, z: u.z * UPPER });
  return { elbow, wrist: at(elbow, { x: f.x * FORE, y: f.y * FORE, z: f.z * FORE }) };
}
function poseOf(arms: Record<Side, Arm>) {
  const points: Vec3[] = Array.from({ length: 33 }, () => ({ ...BODY }));
  points[11] = SHOULDER.left; points[12] = SHOULDER.right;
  points[23] = at(BODY, { x: 0.12, y: 0, z: 0 }); points[24] = at(BODY, { x: -0.12, y: 0, z: 0 });
  for (const [side, e, w, i, p] of [['left', 13, 15, 19, 17], ['right', 14, 16, 20, 18]] as const) {
    const { elbow, wrist } = joints(side, arms[side]);
    points[e] = elbow; points[w] = wrist;
    points[i] = at(wrist, { x: 0.02, y: -0.08, z: 0 }); points[p] = at(wrist, { x: -0.02, y: -0.08, z: 0 });
  }
  // World landmarks: metres round the hips (the model's), as it would measure them.
  const world: Landmark[] = points.map((p) => ({ x: p.x - BODY.x, y: p.y - BODY.y, z: p.z - BODY.z, visibility: 1 }));
  return { landmarks: points.map(project), world };
}
/** A hand held up, palm to the camera, its wrist at w. */
function handAt(side: Side, w: Vec3): HandInput & { side: Side; handedness: { side: Side; score: number } } {
  const s = side === 'right' ? -1 : 1;
  const local: Vec3[] = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
  local[0] = { x: 0, y: 0.04, z: 0 }; local[5] = { x: -s * 0.035, y: -0.045, z: 0 }; local[9] = { x: -s * 0.01, y: -0.05, z: 0 };
  local[13] = { x: s * 0.012, y: -0.047, z: 0 }; local[17] = { x: s * 0.032, y: -0.04, z: 0 };
  const centre = at(w, { x: 0, y: -0.04, z: 0 });
  return {
    side, handedness: { side, score: 1 },
    landmarks: local.map((p) => project(at(centre, p))),
    world: local.map((p) => ({ ...p, visibility: 1 })),
  };
}

test('depth from size: the torso, 2.5 m away, measures 2.5 m', () => {
  const pose = poseOf({ left: HANGING, right: HANGING });
  const d = depthOf(pose.world, pose.landmarks, [[11, 12], [23, 24]], SIZE, f);
  assert.ok(d && Math.abs(d - 2.5) < 0.01, `2.5 m (${d})`);
});

test('arms crossed: the hand reaching forward is ahead of the one held across the body', () => {
  // The right forearm pointing forward and in; the left forearm lying across the stomach.
  const arms = { right: { upper: { x: 0, y: 1, z: -0.3 }, fore: { x: 0.4, y: -0.2, z: -1 } }, left: { upper: { x: 0, y: 1, z: 0 }, fore: { x: -1, y: 0, z: -0.15 } } };
  const pose = poseOf(arms);
  const truth = { right: joints('right', arms.right).wrist, left: joints('left', arms.left).wrist };
  const r = handPose(pose, handAt('right', truth.right), 'right', SIZE, FOV)!;
  const l = handPose(pose, handAt('left', truth.left), 'left', SIZE, FOV)!;
  // The player's frame: forward is −z.
  const ahead = (w: Vec3, side: Side) => -(w.z - SHOULDER[side].z);
  assert.ok(r.wrist.z < l.wrist.z - 0.15, `right ahead of left (${r.wrist.z.toFixed(2)} vs ${l.wrist.z.toFixed(2)})`);
  assert.ok(Math.abs(-r.wrist.z - ahead(truth.right, 'right')) < 0.04, `right as far forward as it is (${r.wrist.z.toFixed(2)})`);
  assert.ok(Math.abs(-l.wrist.z - ahead(truth.left, 'left')) < 0.04, `left as far forward as it is (${l.wrist.z.toFixed(2)})`);
});

test('a forearm pointing at the camera reads as forward, though the model gives no depths at all', () => {
  // The right upper arm hanging down, its forearm pointing straight at the camera.
  const pose = poseOf({ left: HANGING, right: { upper: { x: 0, y: 1, z: 0 }, fore: { x: 0, y: 0, z: -1 } } });
  const world = pose.world.map((p) => ({ ...p, z: 0 }));
  const r = handPose({ landmarks: pose.landmarks, world }, undefined, 'right', SIZE, FOV)!;
  assert.ok(Math.abs(r.wrist.z - -FORE) < 0.03, `a forearm forward (${r.wrist.z.toFixed(2)})`);
  assert.ok(Math.abs(r.wrist.y - -UPPER) < 0.03, `at the elbow's height (${r.wrist.y.toFixed(2)})`);
});

test('a wrist read as further than an arm from its shoulder is brought back within reach', () => {
  const shoulder = { x: -0.19, y: -0.5, z: 2.5 };
  const rayAt1 = { x: -0.1 / 1.9, y: -0.4 / 1.9, z: 1 };
  // A glitch: the hand measured a metre in front of the body.
  const t = reachable(rayAt1, 1.4, shoulder);
  const wrist = { x: rayAt1.x * t, y: rayAt1.y * t, z: t };
  const d = Math.hypot(wrist.x - shoulder.x, wrist.y - shoulder.y, wrist.z - shoulder.z);
  assert.ok(Math.abs(d - ARM) < 1e-6, `at an arm's length (${d.toFixed(3)})`);
  // A reading within reach is left alone.
  assert.equal(reachable(rayAt1, 2.2, shoulder), 2.2);
});

test('lateral position follows the picture: the right forearm out to the side is +x', () => {
  const arms = { left: HANGING, right: { upper: { x: 0, y: 1, z: 0 }, fore: { x: -1, y: 0, z: 0 } } };
  const truth = joints('right', arms.right).wrist;
  const r = handPose(poseOf(arms), handAt('right', truth), 'right', SIZE, FOV)!;
  assert.ok(Math.abs(r.wrist.x - FORE) < 0.03, `a forearm out to the player's right (${r.wrist.x.toFixed(2)})`);
  assert.ok(Math.abs(r.wrist.z) < 0.08, `and not forward (${r.wrist.z.toFixed(2)})`);
  assert.equal(r.from, 'hand');
});
