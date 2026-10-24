// Edits to a dance, as JSON operations. The CLI's `apply`, the Studio and scripts all change a
// dance only through applyOps, which applies a batch atomically: every op succeeds and the
// result validates, or nothing changes. docs/dance-cli.md lists every op with examples.
//
// Values are frame coordinates (x, y from 0 to 1; z in frame widths) and degrees; times take
// any time.ts form. Where an op takes `controls`, it accepts controls and groups (format.ts).
import { evaluate } from './curves.ts';
import type { CurveKey } from './curves.ts';
import {
  BODY_FIELDS, CONTACT_CONTROLS, CONTROLS, GROUPS, MID_JOINTS, POINTS, SCALARS, aspectOf, assertDance, baseLayer, expandControls,
  findDancer, isGroup, isMidJoint, isPointControl, isScalarControl, newDancer, round, roundTime,
} from './format.ts';
import type {
  AnyKey, Body, Calibration, Contact, Control, Dance, Dancer, Ease, Interp, Layer, Marker, MarkerKind, PointControl, PointKey, PointValue,
  ScalarKey, SongInfo,
} from './format.ts';
import { createEvaluator } from './evaluate.ts';
import { fitBody, landmarksToRig, limbIK, limbRel, mirrorControl, mirrorRig, neutralPose } from './rig.ts';
import type { RigPose, Vec3 } from './rig.ts';
import { parseRange, parseTime, songToVideo, videoToSong } from './time.ts';
import type { TrackingData } from './tracking.ts';
import { isStageId } from '../../packages/stages/catalog.ts';

export type Op = { op: string; [field: string]: unknown };
export interface KeyCounts { added: number; changed: number; removed: number; }
export interface ChangeSummary {
  ops: number;
  keys: KeyCounts;
  /** Dancers whose animation changed. */
  dancers: string[];
  /** The song-time span the changed keys, contacts and exclusions cover, if any. */
  range: [number, number] | null;
  notes: string[];
}
export interface OpContext {
  /** Decoded tracking by id, for draft, fit-body and pose-from-tracking. */
  tracking?: (id: string) => TrackingData;
}

const TIME_EPS = 0.5;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
function fail(message: string): never { throw Error(message); }
function num(v: unknown, name: string): number {
  if (!finite(v)) fail(`${name} must be a number`);
  return v;
}
function optional<T>(v: unknown, read: (v: unknown) => T): T | undefined { return v === undefined ? undefined : read(v); }
const INTERPS: readonly Interp[] = ['smooth', 'linear', 'hold'];
const EASES: readonly Ease[] = ['auto', 'stop', 'sharp'];
const interpOf = (v: unknown): Interp => INTERPS.includes(v as Interp) ? v as Interp : fail(`interp must be ${INTERPS.join(', ')}`);
const easeOf = (v: unknown): Ease => EASES.includes(v as Ease) ? v as Ease : fail(`ease must be ${EASES.join(', ')}`);
const nextId = (prefix: string, taken: Iterable<string>) => {
  const used = new Set(taken);
  for (let i = 1; ; i++) if (!used.has(`${prefix}${i}`)) return `${prefix}${i}`;
};
const roundPoint = (v: readonly number[]): PointValue => v.length >= 3 && v[2] !== undefined ? [round(v[0]), round(v[1]), round(v[2])] : [round(v[0]), round(v[1])];

// ---- Keys ----

/** Inserts or replaces the key at t, keeping an existing key's interp and ease unless given. */
export function setKey(keys: AnyKey[], key: AnyKey): AnyKey[] {
  const t = roundTime(key.t);
  const i = keys.findIndex(k => Math.abs(k.t - t) < TIME_EPS);
  const next: AnyKey = { t, v: key.v } as AnyKey;
  const interp = key.interp ?? (i >= 0 ? keys[i].interp : undefined), ease = key.ease ?? (i >= 0 ? keys[i].ease : undefined);
  if (interp && interp !== 'smooth') next.interp = interp;
  if (ease && ease !== 'auto') next.ease = ease;
  const out = keys.filter((_, j) => j !== i);
  out.push(next);
  return out.sort((a, b) => a.t - b.t);
}
const inRange = (t: number, [a, b]: readonly [number, number]) => t >= a - TIME_EPS && t <= b + TIME_EPS;
function layerOf(dancer: Dancer, id: unknown): Layer {
  if (id === undefined || id === null) return baseLayer(dancer);
  const layer = dancer.layers.find(l => l.id === id);
  if (!layer) fail(`${dancer.id} has no layer "${String(id)}"; its layers are ${dancer.layers.map(l => l.id).join(', ')}`);
  return layer;
}
/** Times a key op selects: t, times, or range (inclusive). */
function timeFilter(op: Op, dance: Dance): (t: number) => boolean {
  if (op.range !== undefined) { const r = parseRange(op.range, dance); return t => inRange(t, r); }
  if (op.times !== undefined) {
    if (!Array.isArray(op.times)) fail('times must be a list');
    const times = op.times.map(t => parseTime(t, dance));
    return t => times.some(x => Math.abs(x - t) < TIME_EPS);
  }
  if (op.t !== undefined) { const at = parseTime(op.t, dance); return t => Math.abs(t - at) < TIME_EPS; }
  return () => true;
}
function controlNames(op: Op): string[] | null {
  if (op.controls === undefined) return null;
  const list = typeof op.controls === 'string' ? op.controls.split(',').map(s => s.trim()) : op.controls;
  if (!Array.isArray(list) || !list.every(v => typeof v === 'string')) fail('controls must be a list of control or group names');
  expandControls(list);
  return list;
}
function controlsOf(op: Op): Control[] {
  return expandControls(controlNames(op));
}
/**
 * Which of a layer's channels an op's `controls` select: all without them; a name the layer
 * has a channel for (a control, or a group an additive layer keys) selects that channel; any
 * other group selects its members.
 */
export function channelFilter(op: Op, layer: Layer): (name: string) => boolean {
  const names = controlNames(op);
  if (!names) return () => true;
  const selected = new Set<string>();
  for (const name of names) {
    if (layer.channels[name]) selected.add(name);
    else for (const c of expandControls([name])) selected.add(c);
  }
  return name => selected.has(name);
}

// ---- Values ----

/** The base layer's pose (no additive layers), as an absolute key would set it. */
function basePose(dance: Dance, dancer: Dancer, t: number): RigPose {
  return createEvaluator(dance, dancer, { additive: false }).rigAt(t);
}
/** A layer channel's current value at t (an additive layer's offset; 0 where unkeyed). */
function layerValue(layer: Layer, name: string, t: number, point: boolean): number[] {
  const keys = layer.channels[name];
  if (!keys?.length) return point ? [0, 0, 0] : [0];
  const v = evaluate(keys.map(k => ({ t: k.t, v: Array.isArray(k.v) ? [k.v[0], k.v[1], k.v[2] ?? 0] : [k.v], interp: k.interp, ease: k.ease })), t);
  return v;
}
/**
 * A point value from an op: [x, y(, z)] sets it; {x, y, z} sets the components given; {dx, dy,
 * dz} moves it from `current`. A missing z stays unkeyed unless the current key has one.
 */
function pointValue(v: unknown, current: readonly number[], keepZ: boolean, name: string): PointValue {
  if (Array.isArray(v)) {
    if (!(v.length === 2 || v.length === 3) || !v.every(finite)) fail(`${name}: a point is [x, y] or [x, y, z]`);
    return roundPoint(v);
  }
  if (!isObject(v)) fail(`${name}: expected [x, y], {x, y} or {dx, dy}`);
  for (const k of Object.keys(v)) if (!['x', 'y', 'z', 'dx', 'dy', 'dz'].includes(k)) fail(`${name}: unknown field ${k}`);
  const pick = (abs: string, rel: string, i: number) => {
    if (v[abs] !== undefined && v[rel] !== undefined) fail(`${name}: give ${abs} or ${rel}, not both`);
    return v[abs] !== undefined ? num(v[abs], `${name}.${abs}`) : current[i] + (v[rel] !== undefined ? num(v[rel], `${name}.${rel}`) : 0);
  };
  const out = [pick('x', 'dx', 0), pick('y', 'dy', 1)];
  if (v.z !== undefined || v.dz !== undefined || keepZ) out.push(pick('z', 'dz', 2));
  return roundPoint(out);
}
function scalarValue(v: unknown, current: number, name: string): number {
  if (finite(v)) return round(v, 3);
  if (isObject(v) && finite(v.d) && Object.keys(v).length === 1) return round(current + v.d, 3);
  fail(`${name}: an angle is a number of degrees or {d: change}`);
}
const keyAt = (keys: readonly AnyKey[] | undefined, t: number) => keys?.find(k => Math.abs(k.t - t) < TIME_EPS);

/**
 * Keys `set` (control or group → value) at t on a layer. Groups only take relative moves; on
 * the base layer a group keys the points it moves directly (elbows, knees and the head follow
 * them). With follow, an elbow or knee keyed at t keeps its place along its limb when the limb's
 * ends move, and a head keyed at t keeps its place over the shoulders.
 */
function keyValues(dance: Dance, dancer: Dancer, layer: Layer, t: number, set: Record<string, unknown>,
  { interp, ease, follow = true }: { interp?: Interp; ease?: Ease; follow?: boolean }) {
  const base = layer === baseLayer(dancer), aspect = aspectOf(dance);
  const before = base ? basePose(dance, dancer, t) : null;
  const entries: [string, unknown][] = [];
  for (const [name, value] of Object.entries(set)) {
    if (isPointControl(name) || isScalarControl(name)) { entries.push([name, value]); continue; }
    if (!isGroup(name) || name === 'all' || name === 'headAngles') fail(`Unknown control or point group "${name}"`);
    if (!base) { entries.push([name, value]); continue; }
    if (!isObject(value) || ['x', 'y', 'z'].some(k => k in value)) fail(`${name}: a group only moves relatively, e.g. {"dx": 0.02}`);
    const members = (GROUPS[name] as readonly string[]).filter(isPointControl), inGroup = new Set<string>(members);
    for (const m of members) {
      if (m === 'head' && (inGroup.has('leftShoulder') || inGroup.has('rightShoulder'))) continue;
      if (isMidJoint(m) && MID_JOINTS[m].some(e => inGroup.has(e))) continue;
      entries.push([m, value]);
    }
  }
  // Mid joints and the head keyed at t, as placed before the change, to follow their limbs.
  const followers: { control: PointControl; rel?: ReturnType<typeof limbRel>; offset?: Vec3 }[] = [];
  if (base && follow && before) {
    const moved = new Set(entries.map(([n]) => n));
    for (const [joint, [a, b]] of Object.entries(MID_JOINTS) as [PointControl, readonly [PointControl, PointControl]][])
      if (!moved.has(joint) && (moved.has(a) || moved.has(b)) && keyAt(layer.channels[joint], t))
        followers.push({ control: joint, rel: limbRel(before.points[a], before.points[joint], before.points[b], aspect) });
    if (!moved.has('head') && (moved.has('leftShoulder') || moved.has('rightShoulder')) && keyAt(layer.channels.head, t)) {
      const s = before.points.leftShoulder.map((v, i) => (v + before.points.rightShoulder[i]) / 2);
      followers.push({ control: 'head', offset: before.points.head.map((v, i) => v - s[i]) as Vec3 });
    }
  }
  for (const [name, value] of entries) {
    const point = !isScalarControl(name), keys = layer.channels[name] ?? [];
    const existing = keyAt(keys, t);
    let v: PointValue | number;
    if (point) {
      const current = base ? before!.points[name as PointControl] : layerValue(layer, name, t, true);
      const keepZ = existing ? Array.isArray(existing.v) && existing.v.length === 3 : !base;
      v = pointValue(value, current, keepZ, name);
    } else {
      const current = base ? before![name as 'turn'] : layerValue(layer, name, t, false)[0];
      v = scalarValue(value, current, name);
    }
    layer.channels[name] = setKey(keys, { t, v, ...(interp ? { interp } : {}), ...(ease ? { ease } : {}) } as AnyKey);
  }
  if (followers.length) {
    const after = basePose(dance, dancer, t);
    for (const f of followers) {
      const keys = layer.channels[f.control]!, key = keyAt(keys, t) as PointKey;
      let p: number[];
      if (f.rel) {
        const [a, b] = MID_JOINTS[f.control as keyof typeof MID_JOINTS];
        p = limbIK(after.points[a], after.points[b], f.rel, aspect);
      } else {
        const s = after.points.leftShoulder.map((v, i) => (v + after.points.rightShoulder[i]) / 2);
        p = s.map((v, i) => v + f.offset![i]);
      }
      layer.channels[f.control] = setKey(keys, { ...key, v: key.v.length === 3 ? roundPoint(p) : roundPoint(p.slice(0, 2)) });
    }
  }
}
/** Writes a whole rig pose (the selected controls) as base keys at t. */
function keyPose(dancer: Dancer, pose: RigPose, t: number, controls: readonly Control[], { depth = false, interp, ease }:
  { depth?: boolean; interp?: Interp; ease?: Ease } = {}) {
  const layer = baseLayer(dancer);
  for (const c of controls) {
    const v: PointValue | number = isPointControl(c)
      ? roundPoint(depth ? pose.points[c] : pose.points[c].slice(0, 2)) : round(pose[c as 'turn'], 3);
    layer.channels[c] = setKey(layer.channels[c] ?? [], { t, v, ...(interp ? { interp } : {}), ...(ease ? { ease } : {}) } as AnyKey);
  }
}

// ---- Tracking ----

function trackingFor(dance: Dance, ctx: OpContext, op: Op, dancer: Dancer): { data: TrackingData; slot: number } {
  const sources = dance.sources.tracking;
  if (!sources.length) fail('This dance has no tracking; run `dance track` first');
  // The newest tracking that follows this dancer, unless one is named.
  const source = op.tracking === undefined ? [...sources].reverse().find(s => s.dancers.includes(dancer.id)) ?? sources[sources.length - 1]
    : sources.find(s => s.id === op.tracking) ?? fail(`No tracking "${String(op.tracking)}"; have ${sources.map(s => s.id).join(', ')}`);
  if (!ctx.tracking) fail('Tracking data is not available here');
  const slot = op.slot !== undefined ? num(op.slot, 'slot') : source.dancers.indexOf(dancer.id);
  if (slot < 0) fail(`Tracking ${source.id} follows nobody as ${dancer.id}; pass "slot" or assign it with {"op":"tracking","id":"${source.id}","dancers":[...]}`);
  const data = ctx.tracking(source.id);
  if (slot >= data.slots) fail(`Tracking ${source.id} has ${data.slots} slots`);
  return { data, slot };
}
/** The tracked landmarks for a dancer at a dancer-clock time, or null. */
function trackedAt(dance: Dance, data: TrackingData, slot: number, dancer: Dancer, t: number) {
  return data.poseAt(slot, songToVideo(dance, t + dancer.timeOffsetMs));
}

// ---- Curve tools ----

const metricDistance = (a: readonly number[], b: readonly number[], aspect: number, point: boolean) =>
  point ? Math.hypot((a[0] - b[0]) * aspect, a[1] - b[1]) : Math.abs(a[0] - b[0]);
const asCurve = (keys: readonly AnyKey[]): CurveKey[] => keys.map(k => ({ t: k.t, v: Array.isArray(k.v) ? [k.v[0], k.v[1]] : [k.v], interp: k.interp, ease: k.ease }));
/** Keys that carry an intention and must survive smoothing and simplifying. */
const pinned = (k: AnyKey, boundaries: readonly number[]) => (k.ease && k.ease !== 'auto') || k.interp === 'hold' ||
  boundaries.some(b => Math.abs(b - k.t) < TIME_EPS);
/**
 * Drops keys, least needed first, while the curve stays within tolerance of the original (frame
 * heights for points, degrees for angles). Ends of the range and pinned keys stay.
 */
export function simplifyKeys(keys: AnyKey[], range: readonly [number, number], tolerance: number, aspect: number, boundaries: readonly number[] = []): AnyKey[] {
  if (keys.length < 3) return keys;
  const point = Array.isArray(keys[0].v), original = asCurve(keys);
  const lo = keys.findIndex(k => inRange(k.t, range)), hi = keys.length - 1 - [...keys].reverse().findIndex(k => inRange(k.t, range));
  if (lo < 0) return keys;
  // A doubly linked list of the keys still kept, by original index.
  const n = keys.length, prev = Array.from({ length: n }, (_, i) => i - 1), next = Array.from({ length: n }, (_, i) => i + 1);
  const alive = Array<boolean>(n).fill(true), version = Array<number>(n).fill(0);
  const removable = (i: number) => i > 0 && i < n - 1 && keys[i].t > keys[lo].t && keys[i].t < keys[hi].t && !pinned(keys[i], boundaries);
  /** The kept key `steps` kept keys before (prev) or after (next) i, clamped to the ends. */
  const walk = (i: number, steps: number, dir: number[]) => {
    for (let k = 0; k < steps; k++) { const j = dir[i]; if (j < 0 || j >= n) break; i = j; }
    return i;
  };
  // Removing key i reshapes the segments out to two kept keys either side (their tangents use
  // their neighbours), and only those: measure them against the original, using three keys either side.
  const errorWithout = (i: number) => {
    const around: AnyKey[] = [];
    for (let j = walk(i, 3, prev), last = walk(i, 3, next); ; j = next[j]) {
      if (j !== i) around.push(keys[j]);
      if (j === last) break;
    }
    const local = asCurve(around);
    const a = walk(i, 2, prev), b = walk(i, 2, next);
    // Long windows (where many keys have gone, so the curve is simple there) are measured at
    // most 120 points across, plus every point beside the key itself.
    let worst = 0;
    const first = a * 3, last = b * 3, stride = Math.max(1, Math.floor((last - first) / 120));
    const check = (s: number) => { worst = Math.max(worst, metricDistance(evaluate(local, sampleTimes[s], scratch), sampleValues[s], aspect, point)); };
    for (let s = first; s <= last; s += stride) check(s);
    if (stride > 1) for (let s = Math.max(first, i * 3 - 6); s <= Math.min(last, i * 3 + 6); s++) check(s);
    check(last);
    return worst;
  };
  // The original curve at each key and a third and two thirds of the way to the next, once:
  // sample s is at key floor(s / 3).
  const sampleTimes: number[] = [], sampleValues: number[][] = [], scratch: number[] = [];
  for (let k = 0; k < n; k++) for (const f of [0, 1 / 3, 2 / 3]) {
    const t = k + 1 < n ? keys[k].t + (keys[k + 1].t - keys[k].t) * f : keys[k].t;
    sampleTimes.push(t); sampleValues.push(evaluate(original, t));
  }
  // A min-heap of [error, index, version]; entries whose version has moved on are stale.
  const heap: [number, number, number][] = [];
  const push = (e: [number, number, number]) => {
    heap.push(e);
    for (let c = heap.length - 1; c > 0;) { const p = (c - 1) >> 1; if (heap[p][0] <= heap[c][0]) break; [heap[p], heap[c]] = [heap[c], heap[p]]; c = p; }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      for (let p = 0; ;) {
        const l = 2 * p + 1, r = l + 1;
        let m = p;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === p) break;
        [heap[p], heap[m]] = [heap[m], heap[p]]; p = m;
      }
    }
    return top;
  };
  const score = (i: number) => { version[i]++; if (removable(i)) { const e = errorWithout(i); if (e <= tolerance) push([e, i, version[i]]); } };
  for (let i = 0; i < n; i++) score(i);
  // Greedy: drop the key whose loss changes the curve least, re-measuring only its neighbours.
  while (heap.length) {
    const [, i, v] = pop();
    if (!alive[i] || v !== version[i]) continue;
    alive[i] = false;
    next[prev[i]] = next[i];
    prev[next[i]] = prev[i];
    for (let j = walk(prev[i], 3, prev), last = walk(next[i], 3, next); ; j = next[j]) {
      score(j);
      if (j === last) break;
    }
  }
  return keys.filter((_, i) => alive[i]);
}
/** Gaussian-smooths key values over neighbouring keys in the range; pinned keys keep theirs. */
export function smoothKeys(keys: AnyKey[], range: readonly [number, number], windowMs: number, boundaries: readonly number[] = []): AnyKey[] {
  const sigma = Math.max(1, windowMs / 2);
  let from = 0;
  return keys.map(k => {
    if (!inRange(k.t, range) || pinned(k, boundaries)) return k;
    let total = 0;
    const sum = (Array.isArray(k.v) ? k.v.map(() => 0) : [0]);
    const hasZ = Array.isArray(k.v) && k.v.length === 3;
    // Keys are in time order: only those within three sigmas count.
    while (keys[from].t < k.t - 3 * sigma) from++;
    for (let j = from; j < keys.length && keys[j].t <= k.t + 3 * sigma; j++) {
      const o = keys[j];
      if (hasZ && (!Array.isArray(o.v) || o.v.length !== 3)) continue;
      const w = Math.exp(-0.5 * ((o.t - k.t) / sigma) ** 2);
      total += w;
      const v = Array.isArray(o.v) ? o.v : [o.v];
      sum.forEach((_, i) => { sum[i] += v[i] * w; });
    }
    const v = sum.map(s => s / total);
    return { ...k, v: Array.isArray(k.v) ? roundPoint(v) : round(v[0], 3) } as AnyKey;
  });
}
const contactBoundaries = (dancer: Dancer) => dancer.contacts.flatMap(c => [c.startMs, c.endMs]);

// ---- Ops ----

type Handler = (dance: Dance, op: Op, ctx: OpContext, notes: string[]) => void;
function dancerOf(dance: Dance, op: Op): Dancer {
  if (op.dancer === undefined) {
    if (dance.dancers.length === 1) return dance.dancers[0];
    fail(`Name the dancer: "dancer": ${dance.dancers.map(d => JSON.stringify(d.id)).join(' | ')}`);
  }
  return findDancer(dance, op.dancer);
}
function dancersOf(dance: Dance, op: Op): Dancer[] {
  return op.dancer === undefined || op.dancer === 'all' ? dance.dancers : [findDancer(dance, op.dancer)];
}
function fields(op: Op, allowed: readonly string[]) {
  for (const k of Object.keys(op)) if (k !== 'op' && !allowed.includes(k)) fail(`unknown field "${k}" (${op.op} takes ${allowed.join(', ')})`);
}
const KEY_FIELDS = ['dancer', 'layer', 'interp', 'ease'];

const HANDLERS: Record<string, Handler> = {
  key(dance, op) {
    fields(op, [...KEY_FIELDS, 't', 'set', 'follow']);
    const dancer = dancerOf(dance, op), layer = layerOf(dancer, op.layer);
    if (!isObject(op.set) || !Object.keys(op.set).length) fail('set must map controls to values, e.g. {"leftWrist": [0.42, 0.31]}');
    keyValues(dance, dancer, layer, parseTime(op.t, dance), op.set, {
      interp: optional(op.interp, interpOf), ease: optional(op.ease, easeOf), follow: op.follow !== false });
  },
  pose(dance, op, ctx) {
    fields(op, [...KEY_FIELDS, 't', 'from', 'controls', 'mirror', 'tracking', 'slot', 'depth']);
    const dancer = dancerOf(dance, op), t = parseTime(op.t, dance), aspect = aspectOf(dance);
    if (op.layer !== undefined && op.layer !== 'base') fail('pose keys the base layer');
    let pose: RigPose;
    const from = op.from ?? 'current';
    if (from === 'current') pose = basePose(dance, dancer, t);
    else if (from === 'neutral') pose = neutralPose(dancer.body, dancer.home, aspect);
    else if (from === 'tracking') {
      const { data, slot } = trackingFor(dance, ctx, op, dancer);
      const landmarks = trackedAt(dance, data, slot, dancer, t);
      if (!landmarks) fail(`Tracking has no pose for ${dancer.id} at ${t} ms`);
      pose = landmarksToRig(landmarks, dancer.body, aspect);
    } else if (isObject(from)) {
      const source = from.dancer === undefined ? dancer : findDancer(dance, from.dancer);
      pose = basePose(dance, source, parseTime(from.t, dance));
      if (op.mirror !== undefined && op.mirror !== 'frame' && op.mirror !== 'self') fail('mirror must be "frame" or "self"');
      // Reflected about the frame's centre, it lands where a mirrored duet partner stands; about
      // itself, in place. Either way, from another dancer it then moves to this dancer's home.
      if (op.mirror === 'self') pose = mirrorRig(pose, source.home[0]);
      if (op.mirror === 'frame') pose = mirrorRig(pose, 0.5);
      else if (source !== dancer) {
        const dx = dancer.home[0] - source.home[0], dy = dancer.home[1] - source.home[1];
        for (const c of POINTS) pose.points[c] = [pose.points[c][0] + dx, pose.points[c][1] + dy, pose.points[c][2]];
      }
    } else fail('from must be "current", "neutral", "tracking" or {"t": time, "dancer"?: id}');
    if (op.mirror !== undefined && !isObject(from)) pose = mirrorRig(pose, op.mirror === 'frame' ? 0.5 : op.mirror === 'self' ? dancer.home[0]
      : fail('mirror must be "frame" or "self"'));
    keyPose(dancer, pose, t, controlsOf(op), { depth: op.depth === true, interp: optional(op.interp, interpOf), ease: optional(op.ease, easeOf) });
  },
  delete(dance, op) {
    fields(op, ['dancer', 'layer', 'controls', 't', 'times', 'range']);
    if (op.t === undefined && op.times === undefined && op.range === undefined) fail('delete needs t, times or range');
    const match = timeFilter(op, dance);
    for (const dancer of dancersOf(dance, op)) {
      const layer = layerOf(dancer, op.layer), selects = channelFilter(op, layer);
      for (const [name, keys] of Object.entries(layer.channels)) {
        if (!selects(name)) continue;
        const kept = keys.filter(k => !match(k.t));
        if (kept.length) layer.channels[name] = kept; else delete layer.channels[name];
      }
    }
  },
  interp(dance, op) {
    fields(op, ['dancer', 'layer', 'controls', 't', 'times', 'range', 'interp', 'ease']);
    if (op.interp === undefined && op.ease === undefined) fail('interp needs interp and/or ease');
    const interp = optional(op.interp, interpOf), ease = optional(op.ease, easeOf);
    const match = timeFilter(op, dance);
    let count = 0;
    for (const dancer of dancersOf(dance, op)) {
      const layer = layerOf(dancer, op.layer), selects = channelFilter(op, layer);
      for (const [name, keys] of Object.entries(layer.channels)) {
        if (!selects(name)) continue;
        layer.channels[name] = keys.map(k => {
          if (!match(k.t)) return k;
          count++;
          const next = { ...k };
          if (interp) { if (interp === 'smooth') delete next.interp; else next.interp = interp; }
          if (ease) { if (ease === 'auto') delete next.ease; else next.ease = ease; }
          return next;
        });
      }
    }
    if (!count) fail('No keys matched');
  },
  retime(dance, op) {
    fields(op, ['dancer', 'layer', 'controls', 'range', 'shift', 'scale', 'pivot', 'replace']);
    const [a, b] = parseRange(op.range, dance);
    const shift = op.shift === undefined ? 0 : parseTime(op.shift, dance), scale = op.scale === undefined ? 1 : num(op.scale, 'scale');
    if (!(scale > 0)) fail('scale must be positive');
    const pivot = op.pivot === undefined ? a : parseTime(op.pivot, dance);
    const map = (t: number) => roundTime(pivot + (t - pivot) * scale + shift);
    const all = op.controls === undefined;
    for (const dancer of dancersOf(dance, op)) {
      // Every layer, or just the one named.
      const layers = op.layer === undefined ? dancer.layers : [layerOf(dancer, op.layer)];
      for (const layer of layers) for (const [name, keys] of Object.entries(layer.channels)) {
        if (!channelFilter(op, layer)(name)) continue;
        const moving = keys.filter(k => inRange(k.t, [a, b])), staying = keys.filter(k => !inRange(k.t, [a, b]));
        const moved = moving.map(k => ({ ...k, t: map(k.t) }));
        for (const k of moved) {
          const clash = staying.findIndex(s => Math.abs(s.t - k.t) < TIME_EPS);
          if (clash >= 0) {
            if (op.replace !== true) fail(`${dancer.id} ${name}: a retimed key lands on the key at ${staying[clash].t} ms; pass "replace": true to overwrite it`);
            staying.splice(clash, 1);
          }
        }
        layer.channels[name] = [...staying, ...moved].sort((x, y) => x.t - y.t) as AnyKey[];
      }
      if (all) {
        for (const c of dancer.contacts) if (c.startMs >= a - TIME_EPS && c.endMs <= b + TIME_EPS) { c.startMs = map(c.startMs); c.endMs = map(c.endMs); }
        for (const x of dancer.exclusions) if (x.startMs >= a - TIME_EPS && x.endMs <= b + TIME_EPS) { x.startMs = map(x.startMs); x.endMs = map(x.endMs); }
      }
    }
  },
  contact(dance, op) {
    fields(op, ['dancer', 'control', 'start', 'end', 'blendMs', 'position', 'id']);
    const dancer = dancerOf(dance, op);
    if (!(CONTACT_CONTROLS as readonly unknown[]).includes(op.control)) fail(`control must be one of ${CONTACT_CONTROLS.join(', ')}`);
    const id = op.id === undefined ? nextId('c', dancer.contacts.map(c => c.id)) : String(op.id);
    let position: PointValue | null = null;
    if (op.position !== undefined && op.position !== null) {
      if (!Array.isArray(op.position) || !(op.position.length === 2 || op.position.length === 3) || !op.position.every(finite)) fail('position must be [x, y(, z)]');
      position = roundPoint(op.position);
    }
    const contact: Contact = { id, control: op.control as Contact['control'], startMs: roundTime(parseTime(op.start, dance)), endMs: roundTime(parseTime(op.end, dance)),
      blendMs: op.blendMs === undefined ? 80 : num(op.blendMs, 'blendMs'), position };
    dancer.contacts = [...dancer.contacts.filter(c => c.id !== id), contact].sort((x, y) => x.startMs - y.startMs);
  },
  uncontact(dance, op) {
    fields(op, ['dancer', 'id', 'control', 'range']);
    const dancer = dancerOf(dance, op), before = dancer.contacts.length;
    const r = op.range === undefined ? null : parseRange(op.range, dance);
    dancer.contacts = dancer.contacts.filter(c => !(op.id !== undefined ? c.id === op.id
      : (op.control === undefined || c.control === op.control) && (!r || c.endMs > r[0] && c.startMs < r[1])));
    if (dancer.contacts.length === before) fail('No contact matched');
  },
  copy(dance, op) {
    fields(op, ['from', 'to', 'mirror', 'timeScale', 'repeat', 'controls', 'contacts', 'replace', 'offset']);
    if (!isObject(op.from) || !isObject(op.to)) fail('copy needs from: {dancer, range} and to: {dancer, t}');
    const source = findDancer(dance, op.from.dancer ?? (dance.dancers.length === 1 ? 1 : undefined));
    const target = findDancer(dance, op.to.dancer ?? source.id);
    const [a, b] = parseRange(op.from.range, dance), at = parseTime(op.to.t, dance);
    const scale = op.timeScale === undefined ? 1 : num(op.timeScale, 'timeScale'), repeat = op.repeat === undefined ? 1 : num(op.repeat, 'repeat');
    if (!(scale > 0) || !Number.isInteger(repeat) || repeat < 1 || repeat > 64) fail('timeScale must be positive and repeat 1 to 64');
    const mirror = op.mirror ?? null;
    if (mirror !== null && mirror !== 'frame' && mirror !== 'self') fail('mirror must be "frame", "self" or null');
    const about = mirror === 'frame' ? 0.5 : source.home[0];
    let offset: [number, number] = [0, 0];
    if (op.offset === undefined) {
      if (source !== target && mirror !== 'frame') offset = [target.home[0] - source.home[0], target.home[1] - source.home[1]];
    } else if (op.offset !== null) {
      if (!Array.isArray(op.offset) || op.offset.length !== 2 || !op.offset.every(finite)) fail('offset must be [dx, dy] or null');
      offset = op.offset as [number, number];
    }
    const controls = controlsOf(op);
    const src = baseLayer(source), dst = baseLayer(target);
    const snapshot = structuredClone(src.channels);
    const span = (b - a) * scale;
    const transform = (c: Control, v: AnyKey['v']): AnyKey['v'] => {
      // Mirroring turns and head yaw/roll the other way; pitch stays.
      if (!Array.isArray(v)) return mirror && c !== 'headPitch' ? -v : v;
      const x = mirror ? 2 * about - v[0] : v[0];
      return roundPoint([x + offset[0], v[1] + offset[1], ...(v.length === 3 ? [v[2]!] : [])]);
    };
    for (let r = 0; r < repeat; r++) {
      const start = at + r * span, map = (t: number) => roundTime(start + (t - a) * scale);
      for (const c of controls) {
        const from = mirror && isPointControl(c) ? mirrorControl(c) : c;
        const keys = (snapshot[from] ?? []).filter(k => inRange(k.t, [a, b]));
        let existing = dst.channels[c] ?? [];
        if (op.replace !== false) existing = existing.filter(k => !inRange(k.t, [start, start + span]));
        for (const k of keys) existing = setKey(existing, { ...k, t: map(k.t), v: transform(c, k.v) } as AnyKey);
        if (existing.length) dst.channels[c] = existing; else delete dst.channels[c];
      }
      if (op.contacts !== false) for (const c of source.contacts.filter(c => c.startMs >= a - TIME_EPS && c.endMs <= b + TIME_EPS)) {
        const control = (mirror ? mirrorControl(c.control) : c.control) as Contact['control'];
        const startMs = map(c.startMs), endMs = map(c.endMs);
        target.contacts = target.contacts.filter(o => !(o.control === control && o.endMs > startMs && o.startMs < endMs));
        target.contacts.push({ ...c, id: nextId('c', target.contacts.map(o => o.id)), control, startMs, endMs,
          position: c.position ? transform(control, c.position) as PointValue : null });
      }
    }
    target.contacts.sort((x, y) => x.startMs - y.startMs);
  },
  mirror(dance, op) {
    fields(op, ['dancer', 'range', 'about']);
    const dancer = dancerOf(dance, op), [a, b] = op.range === undefined ? [-Infinity, Infinity] : parseRange(op.range, dance);
    const about = op.about === undefined || op.about === 'self' ? dancer.home[0] : op.about === 'frame' ? 0.5 : fail('about must be "frame" or "self"');
    // Every layer: the base's positions reflect about `about`; additive offsets just flip in x.
    // Left and right swap, and turns and head yaw and roll go the other way (pitch stays).
    const swapGroup: Record<string, string> = { leftArm: 'rightArm', rightArm: 'leftArm', leftLeg: 'rightLeg', rightLeg: 'leftLeg' };
    const mirrorName = (n: string) => isPointControl(n) ? mirrorControl(n) : swapGroup[n] ?? n;
    dancer.layers.forEach((layer, li) => {
      const before = structuredClone(layer.channels);
      const names = new Set([...Object.keys(before), ...Object.keys(before).map(mirrorName)]);
      for (const c of names) {
        const from = mirrorName(c);
        const outside = (before[c] ?? []).filter(k => !inRange(k.t, [a, b]));
        const inside = (before[from] ?? []).filter(k => inRange(k.t, [a, b])).map(k => ({ ...k,
          v: Array.isArray(k.v) ? roundPoint([li === 0 ? 2 * about - k.v[0] : -k.v[0], k.v[1], ...(k.v.length === 3 ? [k.v[2]!] : [])])
            : c === 'headPitch' ? k.v : -k.v } as AnyKey));
        const keys = [...outside, ...inside].sort((x, y) => x.t - y.t);
        if (keys.length) layer.channels[c] = keys; else delete layer.channels[c];
      }
    });
    for (const c of dancer.contacts) if (c.startMs >= a && c.endMs <= b) {
      c.control = mirrorControl(c.control) as Contact['control'];
      if (c.position) c.position = roundPoint([2 * about - c.position[0], ...c.position.slice(1)]);
    }
  },
  smooth(dance, op) {
    fields(op, ['dancer', 'layer', 'range', 'controls', 'windowMs']);
    const dancer = dancerOf(dance, op), layer = layerOf(dancer, op.layer);
    const range = op.range === undefined ? [-Infinity, Infinity] as [number, number] : parseRange(op.range, dance);
    const windowMs = op.windowMs === undefined ? 120 : num(op.windowMs, 'windowMs');
    const selects = channelFilter(op, layer);
    for (const c of Object.keys(layer.channels)) if (selects(c)) layer.channels[c] = smoothKeys(layer.channels[c], range, windowMs, contactBoundaries(dancer));
  },
  simplify(dance, op, _ctx, notes) {
    fields(op, ['dancer', 'layer', 'range', 'controls', 'tolerance', 'angleTolerance']);
    const dancer = dancerOf(dance, op), layer = layerOf(dancer, op.layer), aspect = aspectOf(dance);
    const range = op.range === undefined ? [-Infinity, Infinity] as [number, number] : parseRange(op.range, dance);
    const tolerance = op.tolerance === undefined ? 0.004 : num(op.tolerance, 'tolerance');
    const angle = op.angleTolerance === undefined ? 3 : num(op.angleTolerance, 'angleTolerance');
    let removed = 0;
    const selects = channelFilter(op, layer);
    for (const c of Object.keys(layer.channels)) {
      const keys = layer.channels[c];
      if (!selects(c)) continue;
      const next = simplifyKeys(keys, range, isScalarControl(c) ? angle : tolerance, aspect, contactBoundaries(dancer));
      removed += keys.length - next.length;
      layer.channels[c] = next;
    }
    notes.push(`simplify removed ${removed} keys from ${dancer.id}`);
  },
  draft(dance, op, ctx, notes) {
    fields(op, ['dancer', 'tracking', 'slot', 'range', 'controls', 'everyMs', 'tolerance', 'angleTolerance', 'depth', 'fitBody', 'smoothMs']);
    const dancer = dancerOf(dance, op), aspect = aspectOf(dance), { data, slot } = trackingFor(dance, ctx, op, dancer);
    const range = op.range === undefined
      ? [dance.song.playableStartMs - dancer.timeOffsetMs, dance.song.playableEndMs - dancer.timeOffsetMs] as [number, number]
      : parseRange(op.range, dance);
    const controls = controlsOf(op);
    // Tracked frames inside the range, on the dancer's clock.
    const frames: { t: number; landmarks: NonNullable<ReturnType<TrackingData['poseAtFrame']>> }[] = [];
    for (let i = 0; i < data.times.length; i++) {
      const t = videoToSong(dance, data.times[i]) - dancer.timeOffsetMs;
      if (!inRange(t, range)) continue;
      const landmarks = data.poseAtFrame(slot, i);
      if (landmarks) frames.push({ t: roundTime(t), landmarks });
    }
    if (frames.length < 2) fail(`Tracking has fewer than two poses for ${dancer.id} in that range`);
    if (op.fitBody !== false) {
      dancer.body = fitBody(frames.map(f => f.landmarks), aspect);
      const hips = frames.map(f => [(f.landmarks[23].x + f.landmarks[24].x) / 2, (f.landmarks[23].y + f.landmarks[24].y) / 2]);
      const median = (v: number[]) => [...v].sort((x, y) => x - y)[v.length >> 1];
      dancer.home = [round(median(hips.map(h => h[0])), 4), round(median(hips.map(h => h[1])), 4)];
      notes.push(`fitted ${dancer.id}'s body and home from ${frames.length} tracked poses`);
    }
    const rigs = frames.map(f => ({ t: f.t, rig: landmarksToRig(f.landmarks, dancer.body, aspect), landmarks: f.landmarks }));
    const layer = baseLayer(dancer), depth = op.depth === true;
    const everyMs = op.everyMs === undefined ? null : num(op.everyMs, 'everyMs');
    if (everyMs !== null && !(everyMs >= 1)) fail('everyMs must be at least 1 ms');
    const smoothMs = op.smoothMs === undefined ? 80 : num(op.smoothMs, 'smoothMs');
    let added = 0;
    for (const c of controls) {
      // Joints tracked with low confidence are left out of their channel.
      const lm = isPointControl(c) && c !== 'head' ? ({ leftShoulder: 11, rightShoulder: 12, leftElbow: 13, rightElbow: 14, leftWrist: 15, rightWrist: 16,
        leftHip: 23, rightHip: 24, leftKnee: 25, rightKnee: 26, leftAnkle: 27, rightAnkle: 28 } as Record<string, number>)[c] : null;
      const usable = rigs.filter(r => lm === null || r.landmarks[lm].confidence === null || r.landmarks[lm].confidence! >= 0.5);
      if (usable.length < 2) continue;
      let keys: AnyKey[] = usable.map(r => ({ t: r.t, v: isPointControl(c) ? roundPoint(depth ? r.rig.points[c] : r.rig.points[c].slice(0, 2)) : round(r.rig[c as 'turn'], 3) } as AnyKey));
      keys = smoothKeys(keys, [-Infinity, Infinity], smoothMs);
      if (everyMs) {
        const curve = asCurve(keys), out: AnyKey[] = [];
        const depthCurve: CurveKey[] = depth && isPointControl(c) ? keys.map(k => ({ t: k.t, v: [(k.v as number[])[2] ?? 0] })) : [];
        for (let t = range[0]; t <= range[1] + TIME_EPS; t += everyMs) {
          const v = evaluate(curve, t);
          out.push({ t: roundTime(t), v: isPointControl(c) ? roundPoint(depthCurve.length ? [...v, evaluate(depthCurve, t)[0]] : v) : round(v[0], 3) } as AnyKey);
        }
        keys = out;
      } else keys = simplifyKeys(keys, [-Infinity, Infinity], isScalarControl(c) ? (op.angleTolerance === undefined ? 4 : num(op.angleTolerance, 'angleTolerance'))
        : op.tolerance === undefined ? 0.006 : num(op.tolerance, 'tolerance'), aspect);
      const kept = (layer.channels[c] ?? []).filter(k => !inRange(k.t, range));
      layer.channels[c] = [...kept, ...keys].sort((x, y) => x.t - y.t);
      added += keys.length;
    }
    notes.push(`drafted ${added} keys for ${dancer.id} from tracking`);
  },
  arc(dance, op) {
    fields(op, ['dancer', 'control', 'from', 'to', 'via', 'at']);
    const dancer = dancerOf(dance, op);
    if (!isPointControl(op.control)) fail('arc needs a point control');
    const from = parseTime(op.from, dance), to = parseTime(op.to, dance), at = op.at === undefined ? 0.5 : num(op.at, 'at');
    if (!(to > from) || !(at > 0 && at < 1)) fail('arc needs from < to and 0 < at < 1');
    if (!Array.isArray(op.via) || op.via.length < 2 || !op.via.every(finite)) fail('via must be [x, y]');
    keyValues(dance, dancer, baseLayer(dancer), roundTime(from + (to - from) * at), { [op.control]: op.via }, {});
  },
  nudge(dance, op) {
    fields(op, ['dancer', 'layer', 't', 'set', 'fadeMs']);
    const dancer = dancerOf(dance, op), t = parseTime(op.t, dance), fade = op.fadeMs === undefined ? 150 : num(op.fadeMs, 'fadeMs');
    if (!isObject(op.set) || !Object.keys(op.set).length) fail('set must map controls or groups to offsets, e.g. {"leftWrist": [0, -0.02]}');
    const id = op.layer === undefined ? 'fix' : String(op.layer);
    let layer = dancer.layers.find(l => l.id === id);
    if (!layer) { layer = { id, label: 'Fixes', mode: 'additive', enabled: true, weight: 1, channels: {} }; dancer.layers.push(layer); }
    if (layer === baseLayer(dancer)) fail('nudge offsets an additive layer, not the base');
    for (const [name, value] of Object.entries(op.set)) {
      const point = isPointControl(name) || isGroup(name);
      if (!point && !isScalarControl(name)) fail(`Unknown control or group "${name}"`);
      const delta = point ? (Array.isArray(value) && value.length >= 2 && value.every(finite) ? roundPoint(value) : fail(`${name}: an offset is [dx, dy] or [dx, dy, dz]`))
        : finite(value) ? round(value, 3) : fail(`${name}: an angle offset is a number`);
      const zero = point ? (delta as number[]).map(() => 0) as PointValue : 0;
      let keys = layer.channels[name] ?? [];
      if (fade > 0) {
        keys = keys.filter(k => !(k.t > t - fade && k.t < t + fade));
        keys = setKey(keys, { t: t - fade, v: zero } as AnyKey);
        keys = setKey(keys, { t: t + fade, v: zero } as AnyKey);
      }
      layer.channels[name] = setKey(keys, { t, v: delta } as AnyKey);
    }
  },
  layer(dance, op) {
    fields(op, ['dancer', 'action', 'id', 'label', 'enabled', 'weight']);
    const dancer = dancerOf(dance, op), id = String(op.id ?? '');
    const action = op.action ?? 'update';
    if (action === 'add') {
      if (dancer.layers.some(l => l.id === id)) fail(`${dancer.id} already has layer ${id}`);
      dancer.layers.push({ id: id || nextId('layer', dancer.layers.map(l => l.id)), label: typeof op.label === 'string' ? op.label : 'Adjustments',
        mode: 'additive', enabled: op.enabled !== false, weight: op.weight === undefined ? 1 : num(op.weight, 'weight'), channels: {} });
      return;
    }
    const layer = layerOf(dancer, id);
    if (action === 'remove') {
      if (layer === baseLayer(dancer)) fail('The base layer cannot be removed');
      dancer.layers = dancer.layers.filter(l => l !== layer);
    } else if (action === 'update') {
      if (op.label !== undefined) layer.label = String(op.label);
      if (op.enabled !== undefined) layer.enabled = op.enabled === true;
      if (op.weight !== undefined) layer.weight = num(op.weight, 'weight');
    } else fail('action must be add, update or remove');
  },
  dancer(dance, op) {
    fields(op, ['action', 'dancer', 'id', 'label', 'timeOffsetMs', 'home', 'body', 'calibration']);
    const action = op.action ?? 'update';
    if (action === 'add') {
      if (dance.dancers.length >= 4) fail('A dance has at most four dancers');
      const index = dance.dancers.length, id = op.id === undefined ? nextId('P', dance.dancers.map(d => d.id)) : String(op.id);
      const dancer = newDancer(index, index + 1, id);
      dance.dancers.push(dancer);
      Object.assign(op, { dancer: id });
    } else if (action === 'remove') {
      const dancer = dancerOf(dance, op);
      if (dance.dancers.length === 1) fail('A dance needs at least one dancer');
      dance.dancers = dance.dancers.filter(d => d !== dancer);
      for (const p of dance.phrases) if (p.dancer === dancer.id) p.dancer = null;
      for (const s of dance.sources.tracking) s.dancers = s.dancers.map(d => d === dancer.id ? null : d);
      return;
    } else if (action !== 'update') fail('action must be add, update or remove');
    const dancer = dancerOf(dance, op);
    if (op.label !== undefined) dancer.label = String(op.label);
    if (op.timeOffsetMs !== undefined) dancer.timeOffsetMs = roundTime(parseTime(op.timeOffsetMs, dance));
    if (op.home !== undefined) {
      if (!Array.isArray(op.home) || op.home.length !== 2 || !op.home.every(finite)) fail('home must be [x, y]');
      dancer.home = [round(op.home[0], 4), round(op.home[1], 4)];
    }
    if (op.body !== undefined) {
      if (!isObject(op.body)) fail('body must be an object of lengths');
      for (const [k, v] of Object.entries(op.body)) {
        if (!(BODY_FIELDS as readonly string[]).includes(k)) fail(`body has no field ${k}; fields are ${BODY_FIELDS.join(', ')}`);
        dancer.body[k as keyof Body] = round(num(v, `body.${k}`));
      }
    }
    if (op.calibration !== undefined) dancer.calibration = op.calibration === null ? null : op.calibration as Calibration;
  },
  'fit-body'(dance, op, ctx, notes) {
    fields(op, ['dancer', 'from', 't', 'range', 'tracking', 'slot', 'home']);
    const dancer = dancerOf(dance, op), aspect = aspectOf(dance);
    let poses: ReturnType<TrackingData['poseAtFrame']>[];
    if (op.from === 'tracking') {
      const { data, slot } = trackingFor(dance, ctx, op, dancer);
      const range = op.range === undefined ? null : parseRange(op.range, dance);
      poses = Array.from(data.times, (v, i) => {
        const t = videoToSong(dance, v) - dancer.timeOffsetMs;
        return !range || inRange(t, range) ? data.poseAtFrame(slot, i) : null;
      }).filter(Boolean);
    } else {
      const evaluator = createEvaluator(dance, dancer, { additive: false });
      const times = op.t !== undefined ? [parseTime(op.t, dance)] : [...new Set(Object.values(baseLayer(dancer).channels).flatMap(k => k.map(x => x.t)))];
      poses = times.map(t => evaluator.landmarks(t + dancer.timeOffsetMs));
    }
    const list = poses.filter((p): p is NonNullable<typeof p> => p !== null);
    if (!list.length) fail('No poses to fit the body from');
    dancer.body = fitBody(list, aspect);
    if (op.home !== false) {
      const median = (v: number[]) => [...v].sort((x, y) => x - y)[v.length >> 1];
      dancer.home = [round(median(list.map(l => (l[23].x + l[24].x) / 2)), 4), round(median(list.map(l => (l[23].y + l[24].y) / 2)), 4)];
    }
    notes.push(`fitted ${dancer.id}'s body from ${list.length} poses`);
  },
  song(dance, op) {
    fields(op, ['set']);
    if (!isObject(op.set)) fail('set must be an object of song fields');
    const allowed: (keyof SongInfo)[] = ['title', 'artist', 'songwriters', 'choreographers', 'difficulty', 'stage', 'tags', 'description', 'bpm', 'beatOffsetMs', 'durationMs', 'playableStartMs', 'playableEndMs'];
    for (const [k, v] of Object.entries(op.set)) {
      if (!allowed.includes(k as keyof SongInfo)) fail(`song has no field ${k}; fields are ${allowed.join(', ')}`);
      if (k === 'stage' && !isStageId(v)) fail('stage must be one of sanctuary, reef, openreef, falls, club, beach');
      (dance.song as unknown as Record<string, unknown>)[k] = ['beatOffsetMs', 'durationMs', 'playableStartMs', 'playableEndMs'].includes(k) ? roundTime(parseTime(v, dance)) : v;
    }
  },
  video(dance, op) {
    fields(op, ['startMs', 'rate']);
    const video = dance.sources.video ?? fail('This dance has no video');
    if (op.startMs !== undefined) video.startMs = roundTime(parseTime(op.startMs, dance));
    if (op.rate !== undefined) video.rate = num(op.rate, 'rate');
  },
  tracking(dance, op) {
    fields(op, ['id', 'dancers']);
    const source = dance.sources.tracking.find(s => s.id === op.id) ?? fail(`No tracking "${String(op.id)}"`);
    if (!Array.isArray(op.dancers) || op.dancers.length > 4) fail('dancers lists the dancer each slot follows (or null)');
    source.dancers = op.dancers.map(d => d === null ? null : findDancer(dance, d).id);
  },
  exclude(dance, op) {
    fields(op, ['dancer', 'start', 'end', 'reason', 'controls', 'id']);
    const dancer = dancerOf(dance, op);
    if (typeof op.reason !== 'string' || !op.reason.trim()) fail('exclude needs a reason');
    let controls: string[] | null = null;
    if (op.controls !== undefined && op.controls !== null) {
      if (!Array.isArray(op.controls) || !op.controls.every(c => typeof c === 'string')) fail('controls must be a list of control or group names');
      expandControls(op.controls);
      controls = op.controls;
    }
    const id = op.id === undefined ? nextId('x', dancer.exclusions.map(x => x.id)) : String(op.id);
    dancer.exclusions = [...dancer.exclusions.filter(x => x.id !== id),
      { id, startMs: roundTime(parseTime(op.start, dance)), endMs: roundTime(parseTime(op.end, dance)), reason: op.reason, controls }]
      .sort((x, y) => x.startMs - y.startMs);
  },
  include(dance, op) {
    fields(op, ['dancer', 'id']);
    const dancer = dancerOf(dance, op), before = dancer.exclusions.length;
    dancer.exclusions = dancer.exclusions.filter(x => x.id !== op.id);
    if (dancer.exclusions.length === before) fail(`${dancer.id} has no exclusion ${String(op.id)}`);
  },
  phrase(dance, op) {
    fields(op, ['action', 'id', 'label', 'start', 'end', 'dancer']);
    const action = op.action ?? 'add';
    if (action === 'remove') { dance.phrases = dance.phrases.filter(p => p.id !== op.id); return; }
    const existing = dance.phrases.find(p => p.id === op.id);
    if (action === 'update' && !existing) fail(`No phrase ${String(op.id)}`);
    const id = existing?.id ?? (op.id === undefined ? nextId('ph', dance.phrases.map(p => p.id)) : String(op.id));
    const phrase = { id, label: String(op.label ?? existing?.label ?? id),
      startMs: op.start === undefined ? existing?.startMs ?? fail('phrase needs start') : roundTime(parseTime(op.start, dance)),
      endMs: op.end === undefined ? existing?.endMs ?? fail('phrase needs end') : roundTime(parseTime(op.end, dance)),
      dancer: op.dancer === undefined ? existing?.dancer ?? null : op.dancer === null ? null : findDancer(dance, op.dancer).id };
    dance.phrases = [...dance.phrases.filter(p => p.id !== id), phrase].sort((x, y) => x.startMs - y.startMs);
  },
  marker(dance, op) {
    fields(op, ['action', 'id', 't', 'kind', 'label']);
    if ((op.action ?? 'add') === 'remove') { dance.markers = dance.markers.filter(m => m.id !== op.id); return; }
    const kinds: MarkerKind[] = ['beat', 'phrase', 'note'];
    const kind = op.kind === undefined ? 'note' : kinds.includes(op.kind as MarkerKind) ? op.kind as MarkerKind : fail('kind must be beat, phrase or note');
    const id = op.id === undefined ? nextId('m', dance.markers.map(m => m.id)) : String(op.id);
    const marker: Marker = { id, timeMs: roundTime(parseTime(op.t, dance)), kind, label: String(op.label ?? '') };
    dance.markers = [...dance.markers.filter(m => m.id !== id), marker].sort((x, y) => x.timeMs - y.timeMs);
  },
};
export const OP_NAMES = Object.keys(HANDLERS);

// ---- Applying ----

type KeyIndex = Map<string, string>;
function indexKeys(dance: Dance): KeyIndex {
  const index: KeyIndex = new Map();
  for (const d of dance.dancers) for (const l of d.layers) for (const [name, keys] of Object.entries(l.channels))
    for (const k of keys) index.set(`${d.id}|${l.id}|${name}|${k.t}`, JSON.stringify(k));
  return index;
}
function summarize(before: Dance, after: Dance, ops: number, notes: string[]): ChangeSummary {
  const a = indexKeys(before), b = indexKeys(after);
  const keys: KeyCounts = { added: 0, changed: 0, removed: 0 };
  const dancers = new Set<string>();
  let lo = Infinity, hi = -Infinity;
  const touch = (id: string, t: number) => {
    dancers.add(id);
    const offset = after.dancers.find(d => d.id === id)?.timeOffsetMs ?? before.dancers.find(d => d.id === id)?.timeOffsetMs ?? 0;
    lo = Math.min(lo, t + offset); hi = Math.max(hi, t + offset);
  };
  for (const [k, v] of b) {
    const [id, , , t] = k.split('|');
    if (!a.has(k)) { keys.added++; touch(id, Number(t)); } else if (a.get(k) !== v) { keys.changed++; touch(id, Number(t)); }
  }
  for (const k of a.keys()) if (!b.has(k)) { const [id, , , t] = k.split('|'); keys.removed++; touch(id, Number(t)); }
  for (const d of after.dancers) {
    const old = before.dancers.find(o => o.id === d.id);
    const json = (v: unknown) => JSON.stringify(v);
    if (!old) { dancers.add(d.id); continue; }
    for (const [list, oldList] of [[d.contacts, old.contacts], [d.exclusions, old.exclusions]] as const) {
      const was = new Map<string, string>(oldList.map((x: { id: string }) => [x.id, json(x)]));
      for (const x of list as readonly (Contact | { id: string; startMs: number; endMs: number })[])
        if (was.get(x.id) !== json(x)) { touch(d.id, x.startMs); touch(d.id, x.endMs); }
      for (const x of oldList) if (!list.some((y: { id: string }) => y.id === x.id)) { touch(d.id, x.startMs); touch(d.id, x.endMs); }
    }
    if (json({ ...d, layers: d.layers.map(l => ({ ...l, channels: {} })), contacts: [], exclusions: [] }) !==
      json({ ...old, layers: old.layers.map(l => ({ ...l, channels: {} })), contacts: [], exclusions: [] })) dancers.add(d.id);
  }
  for (const d of before.dancers) if (!after.dancers.some(o => o.id === d.id)) dancers.add(d.id);
  return { ops, keys, dancers: [...dancers], range: lo <= hi ? [roundTime(lo), roundTime(hi)] : null, notes };
}
/**
 * Applies ops in order to a copy of the dance and validates the result. Throws, naming the op,
 * if any op fails; the dance passed in is never changed.
 */
export function applyOps(dance: Dance, ops: readonly unknown[], ctx: OpContext = {}): { dance: Dance; summary: ChangeSummary } {
  if (!Array.isArray(ops) || !ops.length) fail('Expected a non-empty list of ops');
  const next = structuredClone(dance), notes: string[] = [];
  ops.forEach((raw, i) => {
    if (!isObject(raw) || typeof raw.op !== 'string') fail(`op ${i + 1}: each op is an object with an "op" name (${OP_NAMES.join(', ')})`);
    const handler = HANDLERS[raw.op];
    if (!handler) fail(`op ${i + 1}: unknown op "${raw.op}"; ops are ${OP_NAMES.join(', ')}`);
    try { handler(next, { ...raw } as Op, ctx, notes); }
    catch (e) { throw Error(`op ${i + 1} (${raw.op}): ${e instanceof Error ? e.message : String(e)}`, { cause: e }); }
  });
  try { assertDance(next); }
  catch (e) { throw Error(`The edit would leave the dance invalid: ${e instanceof Error ? e.message : String(e)}`, { cause: e }); }
  return { dance: next, summary: summarize(dance, next, ops.length, notes) };
}
/** Key channel names in a layer: controls in CONTROLS order, then groups. */
export const channelNames = (layer: Layer) => Object.keys(layer.channels).sort((a, b) => {
  const ia = CONTROLS.indexOf(a as Control), ib = CONTROLS.indexOf(b as Control);
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
});
export type { PointKey, ScalarKey };
export { SCALARS, POINTS };
