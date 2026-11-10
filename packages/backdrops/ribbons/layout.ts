import * as THREE from 'three';
import type { Vec3 } from '../../stages/catalog.ts';
import { makeRandom } from '../../stages/shared/random.ts';
import { RIBBON } from './palette.ts';

/**
 * A sweep of several strands sharing one path, each jittered, fanned and phased a little
 * differently so they cross and part as they ripple. World units: the camera sits at z 22
 * looking at the origin, where the 16:9 frame spans about ±15 by ±8.5 (4:3: ±15 by ±11.3).
 */
export type Path = readonly [Vec3, Vec3, Vec3, Vec3];

export interface Bundle {
  /** Bézier control points of the bundle's middle strand. */
  path: Path;
  strands: number;
  /** How far apart the strands fan at each control point (sideways, world units). */
  fan: readonly [number, number, number, number];
  /** Random scatter of each strand's control points. */
  jitter: number;
  /** [min, max] half-width. */
  width: readonly [number, number];
  colors: readonly (readonly [string, string])[];
  /** How much each strand tints what's behind it (0..1). */
  tint: number;
  /** Edge brightness. */
  rim: number;
  /** [min, max] overall brightness. */
  brightness: readonly [number, number];
  /** Sideways ripple amplitude and depth ripple amplitude. */
  ripple: readonly [number, number];
  /** Flow speed (radians a second of the ripples). */
  speed: number;
  /** Twist turns along the length, [min, max]. */
  turns: readonly [number, number];
  seed: number;
}

// Per-instance attribute sizes, shared by the ribbons and the glints that ride them.
export const STRAND_ATTRIBUTES = { aP0: 4, aP1: 4, aP2: 4, aP3: 4, aWave: 4, aTwist: 4, aColA: 4, aColB: 4 } as const;
export type StrandAttribute = keyof typeof STRAND_ATTRIBUTES;
export type StrandData = Record<StrandAttribute, number[]>;

const color = new THREE.Color();

/** Every strand of the bundles, as flat per-instance arrays. */
export function strandData(bundles: readonly Bundle[]): StrandData {
  const out = Object.fromEntries(Object.keys(STRAND_ATTRIBUTES).map((k) => [k, [] as number[]])) as StrandData;
  for (const b of bundles) {
    const rand = makeRandom(b.seed);
    for (let i = 0; i < b.strands; i++) {
      const f = b.strands > 1 ? i / (b.strands - 1) - 0.5 : 0;
      const points = b.path.map((p, k) => {
        // Fan sideways (y here, as the bundles run mostly left to right), scatter a little.
        const spread = b.fan[k] * f;
        return [p[0] + rand.range(-1, 1) * b.jitter, p[1] + spread + rand.range(-1, 1) * b.jitter, p[2] + rand.range(-1, 1) * b.jitter * 0.6];
      });
      const [colA, colB] = rand.pick(b.colors);
      out.aP0.push(...points[0], rand.range(b.width[0], b.width[1]));
      out.aP1.push(...points[1], rand.range(b.brightness[0], b.brightness[1]));
      out.aP2.push(...points[2], rand.range(0, Math.PI * 2));
      out.aP3.push(...points[3], b.speed * rand.range(0.8, 1.2));
      out.aWave.push(b.ripple[0] * rand.range(0.7, 1.3), rand.range(0.7, 1.3), b.ripple[1] * rand.range(0.7, 1.3), rand.range(0.6, 1.2));
      out.aTwist.push(rand.range(-0.6, 0.6), rand.sign() * rand.range(b.turns[0], b.turns[1]), rand.range(0.5, 1.1), rand.range(0.8, 1.6));
      color.set(colA);
      out.aColA.push(color.r, color.g, color.b, b.tint * rand.range(0.7, 1.2));
      color.set(colB);
      out.aColB.push(color.r, color.g, color.b, b.rim * rand.range(0.8, 1.2));
    }
  }
  return out;
}

const { lime, green, white, cyan, aqua, sky, deep } = RIBBON;

// Far: wide, faint sheets high in the sky, for depth.
export const FAR: readonly Bundle[] = [
  {
    path: [[-42, 10, -26], [-14, 13, -24], [10, 21, -28], [44, 14, -30]],
    strands: 3,
    fan: [2, 6, 7, 4],
    jitter: 1.5,
    width: [2.6, 4],
    colors: [[sky, cyan], [white, sky]],
    tint: 0.06,
    rim: 0.6,
    brightness: [0.22, 0.32],
    ripple: [1.6, 1.4],
    speed: 0.16,
    turns: [0.2, 0.5],
    seed: 11,
  },
  {
    path: [[-44, -14, -22], [-20, -15, -20], [8, -6, -24], [42, -12, -26]],
    strands: 2,
    fan: [2, 5, 5, 3],
    jitter: 1.5,
    width: [2.4, 3.6],
    colors: [[sky, aqua], [white, sky]],
    tint: 0.05,
    rim: 0.6,
    brightness: [0.2, 0.28],
    ripple: [1.4, 1.2],
    speed: 0.14,
    turns: [0.2, 0.5],
    seed: 12,
  },
];

// The hero sweep rises across the top towards the light; the cool sweep runs low along the
// bottom and up the right edge behind the dancers.
const HERO: Path = [[-21, 4.4, 1], [-8, 6.8, 2], [4, 3.4, 0], [21, 6.6, -3]];
const LOW: Path = [[-22, -11, -4], [-6, -10.5, -3], [10, -10, -6], [20, 6, -8]];

// A path moved up by dy at each control point and towards the camera by dz.
const shift = (p: Vec3, dy: number, dz: number): Vec3 => [p[0], p[1] + dy, p[2] + dz];
const offset = ([a, b, c, d]: Path, dy: readonly [number, number, number, number], dz = 0): Path =>
  [shift(a, dy[0], dz), shift(b, dy[1], dz), shift(c, dy[2], dz), shift(d, dy[3], dz)];

// Mid: the showpiece. Each sweep is a broad, strongly twisting ribbon with a narrower partner,
// crossed by thin bright threads of light.
export const MID: readonly Bundle[] = [
  {
    path: HERO,
    strands: 1,
    fan: [0, 0, 0, 0],
    jitter: 0,
    width: [2.3, 2.3],
    colors: [[green, lime]],
    tint: 0.8,
    rim: 2.2,
    brightness: [1, 1],
    ripple: [0.5, 1],
    speed: 0.3,
    turns: [0.9, 0.9],
    seed: 21,
  },
  {
    path: offset(HERO, [0.6, -0.8, 1.2, -0.4], -1),
    strands: 1,
    fan: [0, 0, 0, 0],
    jitter: 0,
    width: [1.4, 1.4],
    colors: [[deep, cyan]],
    tint: 0.7,
    rim: 2,
    brightness: [0.85, 0.85],
    ripple: [0.6, 0.8],
    speed: 0.26,
    turns: [0.7, 0.7],
    seed: 23,
  },
  {
    path: LOW,
    strands: 1,
    fan: [0, 0, 0, 0],
    jitter: 0,
    width: [1.6, 1.6],
    colors: [[aqua, cyan]],
    tint: 0.65,
    rim: 1.6,
    brightness: [0.7, 0.7],
    ripple: [0.6, 1],
    speed: 0.24,
    turns: [0.6, 0.6],
    seed: 22,
  },
  {
    path: offset(LOW, [-0.8, 0.9, 0.6, 0.4], 1),
    strands: 1,
    fan: [0, 0, 0, 0],
    jitter: 0,
    width: [1.1, 1.1],
    colors: [[cyan, lime]],
    tint: 0.55,
    rim: 1.6,
    brightness: [0.6, 0.6],
    ripple: [0.5, 0.9],
    speed: 0.21,
    turns: [0.45, 0.45],
    seed: 26,
  },
];

// Threads: thin bright strands along the sweeps, for the glints to ride.
export const THREADS: readonly Bundle[] = [
  {
    path: HERO,
    strands: 4,
    fan: [1.4, 2.6, 3.4, 2.4],
    jitter: 0.4,
    width: [0.1, 0.22],
    colors: [[white, lime], [white, cyan], [lime, white]],
    tint: 0.1,
    rim: 0.4,
    brightness: [1.3, 1.9],
    ripple: [0.7, 0.9],
    speed: 0.34,
    turns: [0.2, 0.5],
    seed: 24,
  },
  {
    path: LOW,
    strands: 3,
    fan: [1.6, 2.4, 3, 2],
    jitter: 0.5,
    width: [0.1, 0.2],
    colors: [[white, cyan], [cyan, white], [lime, white]],
    tint: 0.1,
    rim: 0.4,
    brightness: [1, 1.5],
    ripple: [0.7, 1],
    speed: 0.3,
    turns: [0.2, 0.5],
    seed: 25,
  },
];

// Near: a big soft swoosh across the top-right corner, out of focus in front of the light.
// (At z 8 the 16:9 frame spans about ±9.6 by ±5.4.)
export const NEAR: readonly Bundle[] = [
  {
    path: [[-1, 8.5, 8], [5, 3.6, 8], [9, 6.4, 8], [15, 2.5, 7]],
    strands: 1,
    fan: [0, 0, 0, 0],
    jitter: 0,
    width: [1.1, 1.1],
    colors: [[lime, white]],
    tint: 0.2,
    rim: 1,
    brightness: [0.45, 0.45],
    ripple: [0.3, 0.4],
    speed: 0.2,
    turns: [0.3, 0.3],
    seed: 31,
  },
];

export interface GlintData {
  strands: StrandData;
  /** across, speed, phase, size per glint. */
  glint: number[];
  color: number[];
}

/** `count` glints spread over the bundles' strands, riding their edges at their own pace. */
export function glintData(bundles: readonly Bundle[], count: number, seed: number): GlintData {
  const strands = strandData(bundles);
  const total = strands.aP0.length / 4;
  const rand = makeRandom(seed);
  const out: GlintData = { strands: strandData([]), glint: [], color: [] };
  const tints = [white, white, lime, cyan];
  for (let i = 0; i < count; i++) {
    const strand = i % total;
    for (const key of Object.keys(STRAND_ATTRIBUTES) as StrandAttribute[]) {
      out.strands[key].push(...strands[key].slice(strand * 4, strand * 4 + 4));
    }
    out.glint.push(rand.pick([-1, 1, -0.95, 0.95, 0]), rand.range(0.018, 0.035), rand.next(), rand.range(0.9, 1.6));
    color.set(rand.pick(tints));
    out.color.push(color.r, color.g, color.b);
  }
  return out;
}

export interface BokehData {
  bokeh: number[];
  drift: number[];
  color: number[];
}

/** Soft discs scattered through the sky, mostly up high and off to the right. */
export function bokehData(count: number, height: number, seed: number): BokehData {
  const rand = makeRandom(seed);
  const out: BokehData = { bokeh: [], drift: [], color: [] };
  const tints = [white, cyan, lime, aqua, cyan];
  for (let i = 0; i < count; i++) {
    const z = rand.range(-14, 6);
    // Further away is wider: keep them inside the view at their depth, biased right.
    const reach = (22 - z) * 0.68;
    const x = THREE.MathUtils.lerp(-reach, reach, Math.pow(rand.next(), 0.55));
    out.bokeh.push(x, rand.range(-0.5, 0.5) * height, z, rand.range(0.25, 0.8) * (1 + (6 - z) * 0.03));
    out.drift.push(rand.range(0.08, 0.22), rand.range(0.2, 0.8), rand.range(0, Math.PI * 2), rand.range(0.03, 0.11));
    color.set(rand.pick(tints));
    out.color.push(color.r, color.g, color.b);
  }
  return out;
}
