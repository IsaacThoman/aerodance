import { makeRandom } from '../../stages/shared/random.ts';
import * as THREE from 'three';
import { DOME, FLOOR_Y, HUB, LOWER_FALL, POOL, deckRadius, distanceToWalk } from './layout.ts';

// Where the forest's trees stand: canopy trees filling the dome, kept below the deck and the
// walkway where they'd reach them, with a few emergents towering over everything.

export interface Tree {
  x: number;
  z: number;
  /** The crown's centre height and horizontal radius (it's about 0.6 as tall). */
  y: number;
  r: number;
  /** Trunk radius at the base. */
  trunk: number;
  seed: number;
  /** 0..1 colour variation. */
  tone: number;
  /** A small tree of the understory. */
  under?: boolean;
}

/** The rocks round the pool and under the cliff, where no tree grows. */
export function inRocks(x: number, z: number): boolean {
  const dx = (x - (POOL.x - 4)) / 13;
  const dz = (z - POOL.z) / 12.5;
  return dx * dx + dz * dz < 1;
}

/** A glade east of the deck, open to the sky, so the forest floor and river show far below. */
export const GLADE = { x: 10.2, z: 0.5, rx: 4.8, rz: 7.0 } as const;
export function inGlade(x: number, z: number, margin = 0): boolean {
  const dx = (x - GLADE.x) / (GLADE.rx + margin);
  const dz = (z - GLADE.z) / (GLADE.rz + margin);
  return dx * dx + dz * dz < 1;
}

/** The dome's inside radius at height y, round its axis. */
export function domeRadiusAt(y: number): number {
  const dy = y - DOME.center.y;
  return Math.sqrt(Math.max(0, DOME.radius * DOME.radius - dy * dy));
}

/** The river's course across the floor, from the foot of the lower fall. */
export const RIVER = new THREE.CatmullRomCurve3([
  new THREE.Vector3(LOWER_FALL.x - 0.5, 0, LOWER_FALL.z - 4.5),
  new THREE.Vector3(-4, 0, -17),
  new THREE.Vector3(5, 0, -15),
  new THREE.Vector3(10.5, 0, -7),
  new THREE.Vector3(9.6, 0, 1),
  new THREE.Vector3(11.5, 0, 8),
  new THREE.Vector3(9, 0, 15),
  new THREE.Vector3(14, 0, 27),
  new THREE.Vector3(26, 0, 36),
  new THREE.Vector3(40, 0, 38),
]);
const RIVER_POINTS = RIVER.getSpacedPoints(120);

export function riverDistance(x: number, z: number): number {
  let best = Infinity;
  for (const p of RIVER_POINTS) best = Math.min(best, (p.x - x) ** 2 + (p.z - z) ** 2);
  return Math.sqrt(best);
}

const EMERGENTS: readonly Omit<Tree, 'seed' | 'tone'>[] = [
  { x: HUB.x, z: HUB.z, y: 11.5, r: 7.5, trunk: HUB.trunk + 0.35 },
  { x: -7.5, z: 21, y: 11, r: 7, trunk: 0.9 },
  { x: 17, z: -15.5, y: 12.5, r: 8, trunk: 1.0 },
  { x: -22, z: -22, y: 9, r: 7.5, trunk: 0.9 },
  { x: 33, z: -18, y: 8, r: 7, trunk: 0.85 },
  { x: -26, z: 14, y: 7.5, r: 7, trunk: 0.85 },
  { x: 10, z: 31, y: 6, r: 7.5, trunk: 0.85 },
  { x: -10, z: -33, y: 7, r: 7.5, trunk: 0.9 },
];

function buildTrees(): Tree[] {
  const rand = makeRandom(1907);
  const trees: Tree[] = EMERGENTS.map((t, i) => ({ ...t, seed: i * 13 + 1, tone: rand.next() }));
  const clear = (x: number, z: number, r: number, y: number, spacing: number): boolean => {
    for (const t of trees) {
      const d = Math.hypot(t.x - x, t.z - z);
      // Crowns may overlap where one is well above the other.
      const overlap = Math.abs(t.y - y) > 5 ? 0.4 : spacing;
      if (d < (t.r + r) * overlap) return false;
    }
    return true;
  };
  for (let i = 0; i < 26000 && trees.length < 330; i++) {
    const a = rand.range(0, Math.PI * 2);
    const rr = Math.sqrt(rand.next()) * 60;
    const x = DOME.center.x + Math.sin(a) * rr;
    const z = DOME.center.z + Math.cos(a) * rr;
    const r = rand.range(3.6, 7.2);
    let top = rand.range(-9, 3);
    const y = () => top - r * 0.66;
    if (Math.hypot(x - DOME.center.x, z - DOME.center.z) > domeRadiusAt(top) - r - 1.5) continue;
    if (inRocks(x, z) || inGlade(x, z, r * 0.7) || Math.hypot(x - HUB.x, z - HUB.z) < r + 4) continue;
    const fromDeck = Math.hypot(x, z) - deckRadius(Math.atan2(x, z));
    if (fromDeck < 0.5) top = Math.min(top, -2.6);
    else if (fromDeck < r + 0.6) top = Math.min(top, -0.9);
    else if (fromDeck < r + 4) top = Math.min(top, 1.2);
    if (distanceToWalk(x, z) < r + 0.8) top = Math.min(top, -1.1);
    if (top < FLOOR_Y + 9) continue;
    if (!clear(x, z, r, y(), 0.64)) continue;
    trees.push({ x, z, y: y(), r, trunk: 0.26 + r * 0.06, seed: i, tone: rand.next() });
  }
  // The understory: smaller crowns filling the gaps lower down, clear of the river.
  for (let i = 0; i < 16000 && trees.length < 560; i++) {
    const a = rand.range(0, Math.PI * 2);
    const rr = Math.sqrt(rand.next()) * 62;
    const x = DOME.center.x + Math.sin(a) * rr;
    const z = DOME.center.z + Math.cos(a) * rr;
    const r = rand.range(2.6, 4.2);
    const y = rand.range(-13, -6.5);
    if (Math.hypot(x - DOME.center.x, z - DOME.center.z) > domeRadiusAt(y) - r - 1) continue;
    if (inRocks(x, z) || inGlade(x, z, r * 0.6) || riverDistance(x, z) < r + 3) continue;
    if (!clear(x, z, r, y, 0.5)) continue;
    trees.push({ x, z, y, r, trunk: 0.18 + r * 0.05, seed: 50000 + i, tone: rand.next(), under: true });
  }
  return trees;
}

export const TREES: readonly Tree[] = buildTrees();

export interface Blob {
  c: THREE.Vector3;
  r: number;
  /** One of the few inside the crown, filling it out. */
  inner: boolean;
}

/** How far a tree is from the deck. */
export const fromCentre = (t: Tree): number => Math.hypot(t.x, t.z);

/** A crown's leaf clusters: on a broad, flattened shell, a few big ones inside. */
export function crownBlobs(t: Tree): Blob[] {
  const rand = makeRandom(t.seed * 31 + 7);
  const far = fromCentre(t) > 34;
  const count = t.under ? 6 : far ? Math.round(6 + t.r * 0.9) : Math.round(9 + t.r * 1.5);
  const out: Blob[] = [];
  for (let i = 0; i < count; i++) {
    const inner = i < 3;
    const a = rand.range(0, Math.PI * 2);
    const up = inner ? rand.range(-0.2, 0.5) : rand.range(-0.35, 1);
    const ring = Math.sqrt(Math.max(0, 1 - up * up));
    const shell = inner ? 0.3 : rand.range(0.8, 1.05);
    const c = new THREE.Vector3(t.x + Math.cos(a) * ring * 0.62 * shell * t.r, t.y + up * 0.36 * shell * t.r, t.z + Math.sin(a) * ring * 0.62 * shell * t.r);
    out.push({ c, r: t.r * rand.range(0.28, 0.4) * (inner ? 1.3 : 1), inner });
  }
  return out;
}
