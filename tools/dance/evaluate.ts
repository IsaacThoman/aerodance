// A dancer's pose at any time, from its layers, contacts and rig (format.ts, rig.ts).
//
// The order matters and is the same everywhere (CLI, Studio, export):
//   1. The base layer's shoulders, wrists, hips and ankles, angles and head offset; a control
//      with no keys stays in the neutral stance at the dancer's home.
//   2. Additive layers add their weighted offsets. A group offset (body, arms, ...) moves the
//      group's shoulders, wrists, hips and ankles; elbows, knees and the head follow those.
//   3. Contacts plant ankles or wrists where they were when the contact starts.
//   4. The head follows the shoulders: its keys are offsets from the base layer's shoulder
//      midpoint, so moving the torso (by keys, offsets or contacts) carries it. Unkeyed, it sits
//      a neck's length up the torso.
//   5. Elbows and knees are interpolated against their limb (rig.ts limbRel, measured on the
//      base layer), so a keyed elbow is exactly where it was keyed at its key, the arm stays
//      whole between keys, and offsets or contacts on a wrist or ankle carry the elbow or knee
//      with it. When the limb folds (its ends close together, where that solve is unstable),
//      the joint blends into a bone turning with the torso instead (rig.ts ikTrust). Unkeyed,
//      they bend naturally (rig.ts autoLimb).
//   6. Depths without keys follow the dancer's turn.
import { evaluate } from './curves.ts';
import type { CurveKey } from './curves.ts';
import { CONTACT_CONTROLS, GROUPS, MID_JOINTS, POINTS, SCALARS, aspectOf, baseLayer, isGroup, isMidJoint, isPointControl, isScalarControl } from './format.ts';
import type { AnyKey, Contact, Dance, Dancer, MidJoint, PointControl, PointKey, ScalarControl, ScalarKey } from './format.ts';
import { autoLimb, boneEnd, ikTrust, lerp3, limbBone, limbIK, limbRel, neutralPose, rigToLandmarks, torsoAngle, turnDepth } from './rig.ts';
import type { LimbRel, RigPose, Vec3 } from './rig.ts';
import type { Landmark } from '../../packages/pose/choreography.ts';

/** Shoulders, wrists, hips and ankles: animated directly in the frame. */
export const PRIMARY: readonly PointControl[] = POINTS.filter(p => p !== 'head' && !isMidJoint(p));
const MIDS = Object.keys(MID_JOINTS) as MidJoint[];

export interface EvaluatorOptions {
  /** Include additive layers (default true). Off: the base layer alone, e.g. to key into it. */
  additive?: boolean;
  /** Apply contacts (default true). */
  contacts?: boolean;
}
export interface DancerEvaluator {
  readonly dancer: Dancer;
  readonly aspect: number;
  /** The rig pose at a song time. */
  rig(songMs: number): RigPose;
  /** The 33 landmarks at a song time. */
  landmarks(songMs: number): Landmark[];
  /** The rig pose on the dancer's own clock. */
  rigAt(dancerMs: number): RigPose;
}

/** Splits point keys into x/y keys and the keys that set z. */
function pointCurves(keys: readonly PointKey[]) {
  const xy: CurveKey[] = keys.map(k => ({ t: k.t, v: [k.v[0], k.v[1]], interp: k.interp, ease: k.ease }));
  const z: CurveKey[] = keys.filter(k => k.v.length === 3).map(k => ({ t: k.t, v: [k.v[2]!], interp: k.interp, ease: k.ease }));
  return { xy, z };
}
type PointCurves = ReturnType<typeof pointCurves>;
const scalarCurve = (keys: readonly ScalarKey[]): CurveKey[] => keys.map(k => ({ t: k.t, v: [k.v], interp: k.interp, ease: k.ease }));
const mid = (a: readonly number[], b: readonly number[]): Vec3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
const smoothstep = (u: number) => u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u);

/** How much a contact holds its control at dancer time t: 0 off, 1 planted. */
export function contactWeight(c: Contact, t: number): number {
  if (t >= c.startMs && t <= c.endMs) return 1;
  if (c.blendMs <= 0) return 0;
  if (t < c.startMs) return smoothstep((t - (c.startMs - c.blendMs)) / c.blendMs);
  return smoothstep(((c.endMs + c.blendMs) - t) / c.blendMs);
}

interface Additive { weight: number; points: Map<PointControl, PointCurves[]>; scalars: Map<ScalarControl, CurveKey[][]>; }

export function createEvaluator(dance: Dance, dancer: Dancer, { additive = true, contacts = true }: EvaluatorOptions = {}): DancerEvaluator {
  const aspect = aspectOf(dance), body = dancer.body;
  const neutral = neutralPose(body, dancer.home, aspect);
  const base = baseLayer(dancer).channels;
  const keysOf = (name: string): AnyKey[] => base[name] ?? [];
  const basePoints = new Map<PointControl, PointCurves>();
  for (const p of POINTS) if (keysOf(p).length) basePoints.set(p, pointCurves(keysOf(p) as PointKey[]));
  const baseScalars = new Map<ScalarControl, CurveKey[]>();
  for (const s of SCALARS) if (keysOf(s).length) baseScalars.set(s, scalarCurve(keysOf(s) as ScalarKey[]));

  // Additive layers, with each group channel resolved to the points it moves directly.
  const layers: Additive[] = [];
  if (additive) for (const layer of dancer.layers.slice(1)) {
    if (!layer.enabled || layer.weight <= 0) continue;
    const entry: Additive = { weight: layer.weight, points: new Map(), scalars: new Map() };
    for (const [name, keys] of Object.entries(layer.channels)) {
      if (!keys.length) continue;
      if (isScalarControl(name)) {
        entry.scalars.set(name, [...entry.scalars.get(name) ?? [], scalarCurve(keys as ScalarKey[])]);
        continue;
      }
      const curves = pointCurves(keys as PointKey[]);
      const members: readonly PointControl[] = isPointControl(name) ? [name] : isGroup(name) ? (GROUPS[name] as readonly string[]).filter(isPointControl) : [];
      const inGroup = new Set(members);
      for (const m of members) {
        // In a group, a joint that follows other members is carried by them instead.
        if (!isPointControl(name) && m === 'head' && (inGroup.has('leftShoulder') || inGroup.has('rightShoulder'))) continue;
        if (!isPointControl(name) && isMidJoint(m) && MID_JOINTS[m].some(e => inGroup.has(e))) continue;
        entry.points.set(m, [...entry.points.get(m) ?? [], curves]);
      }
    }
    layers.push(entry);
  }
  const scratch: number[] = [];
  const offsetOf = (control: PointControl, t: number): Vec3 => {
    const d: Vec3 = [0, 0, 0];
    for (const layer of layers) for (const c of layer.points.get(control) ?? []) {
      const xy = evaluate(c.xy, t, scratch);
      d[0] += xy[0] * layer.weight; d[1] += xy[1] * layer.weight;
      if (c.z.length) d[2] += evaluate(c.z, t, scratch)[0] * layer.weight;
    }
    return d;
  };
  const scalarAt = (s: ScalarControl, t: number) => {
    const curve = baseScalars.get(s);
    let v = curve ? evaluate(curve, t, scratch)[0] : 0;
    for (const layer of layers) for (const c of layer.scalars.get(s) ?? []) v += evaluate(c, t, scratch)[0] * layer.weight;
    return v;
  };

  // Steps 1-3 for the primary points: base, offsets, then contacts.
  const planted = contacts ? dancer.contacts.filter(c => (CONTACT_CONTROLS as readonly string[]).includes(c.control)) : [];
  function primary(t: number, withContacts: boolean, withLayers = true): { points: Record<PointControl, Vec3>; turn: number } {
    const points = {} as Record<PointControl, Vec3>;
    const turn = withLayers ? scalarAt('turn', t) : baseScalars.get('turn') ? evaluate(baseScalars.get('turn')!, t, scratch)[0] : 0;
    // Shoulders and hips first: limbs without a keyed depth take theirs.
    for (const p of ['leftShoulder', 'rightShoulder', 'leftHip', 'rightHip', 'leftWrist', 'rightWrist', 'leftAnkle', 'rightAnkle'] as const) {
      const curves = basePoints.get(p);
      const xy = curves ? evaluate(curves.xy, t, scratch) : neutral.points[p];
      const x = xy[0], y = xy[1];
      const z = curves?.z.length ? evaluate(curves.z, t, scratch)[0] : turnDepth(p, turn, body, aspect, points);
      const d = withLayers ? offsetOf(p, t) : [0, 0, 0];
      points[p] = [x + d[0], y + d[1], z + d[2]];
    }
    if (withContacts) for (const c of planted) {
      const w = contactWeight(c, t);
      if (w <= 0) continue;
      const anchor = anchors.get(c.id)!, p = points[c.control];
      points[c.control] = [p[0] + (anchor[0] - p[0]) * w, p[1] + (anchor[1] - p[1]) * w, p[2] + (anchor[2] - p[2]) * w];
    }
    return { points, turn };
  }
  const anchors = new Map<string, Vec3>();
  for (const c of planted) {
    const at = primary(c.startMs, false).points[c.control];
    anchors.set(c.id, c.position ? [c.position[0], c.position[1], c.position[2] ?? at[2]] : at);
  }

  // Step 4: the head's keys as offsets from the base layer's shoulder midpoint at each key, so
  // the head follows whatever moves the shoulders afterwards (offsets, contacts).
  const headKeys = keysOf('head') as PointKey[];
  const headCurves = headKeys.length ? pointCurves(headKeys.map(k => {
    const p = primary(k.t, false, false).points, s = mid(p.leftShoulder, p.rightShoulder);
    const v: PointKey['v'] = k.v.length === 3 ? [k.v[0] - s[0], k.v[1] - s[1], k.v[2]! - s[2]] : [k.v[0] - s[0], k.v[1] - s[1]];
    return { ...k, v };
  })) : null;

  // Step 5: elbow and knee keys as limb-relative values, against the base layer's limb ends.
  const limbCurves = new Map<MidJoint, CurveKey[]>();
  for (const joint of MIDS) {
    const keys = keysOf(joint) as PointKey[];
    if (!keys.length) continue;
    const [a, b] = MID_JOINTS[joint];
    let lastAngle: number | null = null;
    limbCurves.set(joint, keys.map(k => {
      const p = primary(k.t, false, false).points;
      const start = p[a], end = p[b];
      // Without a keyed depth, the joint sits on the line between its ends.
      const z = k.v.length === 3 ? k.v[2]! : NaN;
      const rel: LimbRel = limbRel(start, [k.v[0], k.v[1], Number.isNaN(z) ? (start[2] + end[2]) / 2 : z], end, aspect);
      if (Number.isNaN(z)) rel.dz = 0;
      // The same joint as a bone in the torso's frame, its angle unwrapped so it turns the short way.
      const bone = limbBone(start, k.v, torsoAngle(p, aspect), aspect);
      if (lastAngle !== null) bone.angle = lastAngle + Math.atan2(Math.sin(bone.angle - lastAngle), Math.cos(bone.angle - lastAngle));
      lastAngle = bone.angle;
      return { t: k.t, v: [rel.l1, rel.l2, rel.side, rel.dz, bone.angle, bone.length], interp: k.interp, ease: k.ease };
    }));
  }

  function rigAt(t: number): RigPose {
    const { points, turn } = primary(t, true);
    const p = points, s = mid(p.leftShoulder, p.rightShoulder);
    if (headCurves) {
      const o = evaluate(headCurves.xy, t, scratch), ox = o[0], oy = o[1];
      const oz = headCurves.z.length ? evaluate(headCurves.z, t, scratch)[0] : 0;
      points.head = [s[0] + ox, s[1] + oy, s[2] + oz];
    } else {
      // A neck's length up the torso's axis.
      const h = mid(p.leftHip, p.rightHip);
      const ux = (s[0] - h[0]) * aspect, uy = s[1] - h[1], l = Math.hypot(ux, uy) || 1;
      points.head = [s[0] + ux / l * body.neck / aspect, s[1] + uy / l * body.neck, s[2]];
    }
    const dh = offsetOf('head', t);
    points.head = [points.head[0] + dh[0], points.head[1] + dh[1], points.head[2] + dh[2]];
    const torso = torsoAngle(p, aspect);
    for (const joint of MIDS) {
      const [a, b] = MID_JOINTS[joint], curve = limbCurves.get(joint);
      let j: Vec3;
      if (curve) {
        const v = evaluate(curve, t, scratch);
        j = limbIK(points[a], points[b], { l1: v[0], l2: v[1], side: v[2], dz: v[3] }, aspect);
        // Both placements are exact at the keys; the bone takes over where the solve can't be
        // trusted (the limb folded, its ends close together).
        const trust = ikTrust(points[a], points[b], v[0] + v[1], aspect);
        if (trust < 1) j = lerp3(boneEnd(points[a], { angle: v[4], length: v[5] }, torso, aspect, j[2]), j, trust);
      } else j = autoLimb(joint, points[a], points[b], body, aspect, torso);
      const d = offsetOf(joint, t);
      points[joint] = [j[0] + d[0], j[1] + d[1], j[2] + d[2]];
    }
    return { points, turn, headYaw: scalarAt('headYaw', t), headPitch: scalarAt('headPitch', t), headRoll: scalarAt('headRoll', t) };
  }
  return {
    dancer, aspect,
    rigAt,
    rig: (songMs) => rigAt(songMs - dancer.timeOffsetMs),
    landmarks: (songMs) => rigToLandmarks(rigAt(songMs - dancer.timeOffsetMs), body, aspect),
  };
}

/** Every key time of a dancer's layer (dancer clock), sorted. */
export function keyTimes(dancer: Dancer, layerIndex = 0, controls?: readonly string[]): number[] {
  const layer = dancer.layers[layerIndex];
  if (!layer) return [];
  const times = new Set<number>();
  for (const [name, keys] of Object.entries(layer.channels)) {
    if (controls && !controls.includes(name)) continue;
    for (const k of keys) times.add(k.t);
  }
  return [...times].sort((a, b) => a - b);
}
/** Whether an elbow or knee is placed by keys or by the automatic bend. */
export const isKeyed = (dancer: Dancer, control: string) => (baseLayer(dancer).channels[control]?.length ?? 0) > 0;
