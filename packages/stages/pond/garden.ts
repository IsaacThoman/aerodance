import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeRandom } from '../shared/random.ts';
import type { Random } from '../shared/random.ts';
import type { Vec2 } from '../catalog.ts';
import { BRIDGE, CAMERA, CHERRIES, INLET, LANTERNS, PINES, groundHeight, onBank, shoreRadius, shoreScatter } from './layout.ts';
import type { Tree } from './layout.ts';

// ---------------------------------------------------------------------------
// The garden round the pond, built once into one geometry for one material (Garden.tsx): shore
// stones, cherry trees, cloud-pruned pines, clipped azalea mounds, stone lanterns and the
// vermilion bridge. Each vertex carries its albedo, what it is (KIND, which the shader details
// and lights) and how far the wind sways it.
// ---------------------------------------------------------------------------

export const KIND = { stone: 0, bark: 1, blossom: 2, needles: 3, leaves: 4, flowers: 5, lacquer: 6, wood: 7, lantern: 8, glow: 9, brass: 10 } as const;

class Builder {
  positions: number[] = [];
  normals: number[] = [];
  colors: number[] = [];
  kinds: number[] = [];
  sways: number[] = [];
  indices: number[] = [];

  /** Adds `geometry` transformed by `matrix` (and disposes of it). sway: per vertex, from its world position. */
  add(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4, color: THREE.Color, kind: number, sway: number | ((p: THREE.Vector3) => number) = 0): void {
    const g = geometry.index ? geometry : mergeVertices(geometry);
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    const pos = g.getAttribute('position');
    const nor = g.getAttribute('normal');
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);
    const base = this.positions.length / 3;
    const p = new THREE.Vector3();
    const n = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i).applyMatrix4(matrix);
      n.fromBufferAttribute(nor, i).applyMatrix3(normalMatrix).normalize();
      this.positions.push(p.x, p.y, p.z);
      this.normals.push(n.x, n.y, n.z);
      this.colors.push(color.r, color.g, color.b);
      this.kinds.push(kind);
      this.sways.push(typeof sway === 'number' ? sway : sway(p));
    }
    const index = g.getIndex();
    if (index) for (let i = 0; i < index.count; i++) this.indices.push(base + index.getX(i));
    if (g !== geometry) g.dispose();
    geometry.dispose();
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    g.setAttribute('aKind', new THREE.Float32BufferAttribute(this.kinds, 1));
    g.setAttribute('aSway', new THREE.Float32BufferAttribute(this.sways, 1));
    g.setIndex(this.indices);
    return g;
  }
}

const Q = new THREE.Quaternion();
const E = new THREE.Euler();
const V = new THREE.Vector3();
const S = new THREE.Vector3();
/** A transform: position, Euler rotation, scale. */
function at(position: THREE.Vector3Tuple, rotation: THREE.Vector3Tuple = [0, 0, 0], scale: THREE.Vector3Tuple | number = 1): THREE.Matrix4 {
  const s = typeof scale === 'number' ? [scale, scale, scale] as THREE.Vector3Tuple : scale;
  return new THREE.Matrix4().compose(V.set(...position), Q.setFromEuler(E.set(...rotation)), S.set(...s));
}

/** Smoothly lumpy: pushes each vertex of a merged sphere-like geometry along its normal by a sum of seeded waves. */
function lumpy(geometry: THREE.BufferGeometry, amount: number, frequency: number, random: Random): THREE.BufferGeometry {
  geometry.deleteAttribute('normal');
  geometry.deleteAttribute('uv');
  const g = mergeVertices(geometry);
  geometry.dispose();
  const waves = Array.from({ length: 5 }, () => ({
    k: new THREE.Vector3(random.range(-1, 1), random.range(-1, 1), random.range(-1, 1)).normalize().multiplyScalar(frequency * random.range(0.7, 1.6)),
    phase: random.range(0, Math.PI * 2),
    weight: random.range(0.5, 1),
  }));
  const pos = g.getAttribute('position');
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    let d = 0;
    for (const w of waves) d += Math.sin(w.k.dot(p) + w.phase) * w.weight;
    p.multiplyScalar(1 + (d / waves.length) * amount);
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  g.computeVertexNormals();
  return g;
}

const blob = (random: Random, detail = 2, amount = 0.22, frequency = 2.6) => lumpy(new THREE.IcosahedronGeometry(1, detail), amount, frequency, random);

/** A tube along `curve` narrowing from r0 to r1. */
function taperedTube(curve: THREE.Curve<THREE.Vector3>, segments: number, radial: number, r0: number, r1: number): THREE.BufferGeometry {
  const frames = curve.computeFrenetFrames(segments, false);
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    curve.getPointAt(t, p);
    const r = r0 + (r1 - r0) * t;
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      n.copy(frames.normals[i]).multiplyScalar(Math.cos(a)).addScaledVector(frames.binormals[i], Math.sin(a)).normalize();
      positions.push(p.x + n.x * r, p.y + n.y * r, p.z + n.z * r);
      normals.push(n.x, n.y, n.z);
    }
  }
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * (radial + 1) + j;
      const b = a + radial + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setIndex(indices);
  return g;
}

const color = (r: number, g: number, b: number, random?: Random, jitter = 0.08) => {
  const k = random ? 1 + random.range(-jitter, jitter) : 1;
  return new THREE.Color(r * k, g * k, b * k);
};

/** Unit vector (x, z) from a point towards the pond's middle. */
const towardsWater = (p: Vec2): THREE.Vector3 => new THREE.Vector3(-p[0], 0, -p[1]).normalize();

/** Song Select's preview circles the camera round the dancers: nothing tall may come within this of the middle. */
const CAMERA_CLEARANCE = Math.hypot(CAMERA.position[0] - CAMERA.target[0], CAMERA.position[2] - CAMERA.target[2]) + 2.5;

/** A tree's foot moved up the bank as far as it takes for its crown, reaching `reach` towards the water, to clear the camera. */
function clearOfCamera(at: Vec2, reach: number): Vec2 {
  const k = Math.max(1, (CAMERA_CLEARANCE + reach) / Math.hypot(at[0], at[1]));
  return [at[0] * k, at[1] * k];
}

// --- Stones ----------------------------------------------------------------

function stone(b: Builder, x: number, z: number, size: number, random: Random, sink = 0.35): void {
  const tone = random.next();
  const albedo = tone < 0.5 ? color(0.5, 0.49, 0.46, random) : tone < 0.8 ? color(0.62, 0.58, 0.5, random) : color(0.36, 0.38, 0.37, random);
  const y = groundHeight(x, z) - size * sink;
  b.add(blob(random, 1, 0.24, 1.8), at([x, y, z], [random.range(-0.2, 0.2), random.range(0, 6.28), random.range(-0.2, 0.2)], [size * random.range(0.9, 1.4), size * random.range(0.5, 0.75), size * random.range(0.8, 1.1)]), albedo, KIND.stone);
}

function stones(b: Builder): void {
  const random = makeRandom(5);
  // Along the shore, half in the water, in loose runs with gaps between.
  for (const s of shoreScatter(11, 150, [-0.5, 0.5], [0.35, 0.85])) {
    if (s.seed < 0.25) continue;
    stone(b, s.at[0], s.at[1], s.size, random);
  }
  // Down both sides of the stream, under the bridge.
  for (let r = shoreRadius(INLET.azimuth) - INLET.length + 0.4; r < shoreRadius(INLET.azimuth) - 0.5; r += 0.9) {
    for (const side of [-1, 1]) {
      // Where the stream's bank is at this distance out: step out from its middle until the shore.
      let a = INLET.azimuth;
      while (shoreRadius(a) > r && Math.abs(a - INLET.azimuth) < 0.5) a += side * 0.004;
      stone(b, Math.sin(a) * r, -Math.cos(a) * r, random.range(0.35, 0.7), random);
    }
  }
  // Big set stones in groups along the banks.
  for (const [a, d, size] of [[-0.6, 0.6, 1.5], [-0.55, 1.6, 1.0], [0.42, 0.4, 1.3], [0.48, 1.4, 0.9], [0.95, 0.3, 1.2], [-1.15, 0.4, 1.4], [-1.08, 1.4, 0.8], [1.4, 0.5, 1.3], [-0.05, 0.8, 1.1], [2.6, 0.4, 1.4], [-2.6, 0.5, 1.3]]) {
    const p = onBank(a, d);
    stone(b, p[0], p[1], size, random, 0.3);
  }
}

// --- Trees -----------------------------------------------------------------

/** A cherry in full bloom: a short leaning trunk forking into a wide, low dome of blossom. */
function cherry(b: Builder, tree: Tree): void {
  const random = makeRandom(tree.seed * 31 + 7);
  const fork = tree.height * 0.6;
  const spot = clearOfCamera(tree.at, tree.crown * 1.1 + Math.tan(tree.lean) * fork);
  const foot = new THREE.Vector3(spot[0], groundHeight(spot[0], spot[1]) - 0.1, spot[1]);
  const lean = towardsWater(spot).multiplyScalar(Math.tan(tree.lean) * fork);
  const side = new THREE.Vector3(-lean.z, 0, lean.x).normalize();
  const top = foot.clone().add(lean).setY(foot.y + fork);
  const bark = color(0.2, 0.13, 0.11, random);
  const trunk = new THREE.CatmullRomCurve3([
    foot,
    foot.clone().addScaledVector(lean, 0.25).addScaledVector(side, random.range(-0.25, 0.25)).setY(foot.y + fork * 0.35),
    foot.clone().addScaledVector(lean, 0.65).addScaledVector(side, random.range(-0.3, 0.3)).setY(foot.y + fork * 0.72),
    top,
  ]);
  b.add(taperedTube(trunk, 10, 7, 0.34, 0.18), new THREE.Matrix4(), bark, KIND.bark);
  const sway = (p: THREE.Vector3) => Math.max(0, (p.y - foot.y) / tree.height - 0.4);
  // Boughs spreading low from the fork, each under a cluster of blossom.
  const boughs = 5;
  for (let i = 0; i < boughs; i++) {
    const a = (i / boughs) * Math.PI * 2 + random.range(-0.3, 0.3);
    const reach = tree.crown * random.range(0.4, 0.62);
    const dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a)).addScaledVector(lean.clone().normalize(), 0.4).normalize();
    const end = top.clone().addScaledVector(dir, reach).setY(top.y + random.range(0.5, 1.3));
    const mid = top.clone().addScaledVector(dir, reach * 0.45).setY(top.y + random.range(0.5, 0.9));
    b.add(taperedTube(new THREE.CatmullRomCurve3([top.clone().setY(top.y - 0.3), mid, end]), 6, 5, 0.15, 0.05), new THREE.Matrix4(), bark, KIND.bark, sway);
  }
  // The canopy: many clouds of blossom over a wide, low dome, some hanging lower at its edge.
  const centre = top.clone().addScaledVector(lean.clone().normalize(), tree.crown * 0.12).setY(top.y + 1.2);
  const count = 18;
  for (let i = 0; i < count; i++) {
    const a = random.range(0, Math.PI * 2);
    const r = Math.sqrt(random.next()) * tree.crown * 0.7;
    const p = centre.clone().add(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
    p.y += (1 - (r / (tree.crown * 0.7)) ** 2) * tree.crown * 0.26 - (r > tree.crown * 0.5 ? random.range(0, 0.6) : 0) + random.range(-0.25, 0.25);
    const size = tree.crown * random.range(0.2, 0.3);
    const pink = random.next();
    const albedo = pink < 0.5 ? color(0.9, 0.38, 0.54, random, 0.05) : pink < 0.8 ? color(0.84, 0.28, 0.46, random, 0.05) : color(0.95, 0.56, 0.68, random, 0.04);
    b.add(blob(random), at(p.toArray(), [random.range(0, 6), random.range(0, 6), 0], [size, size * random.range(0.65, 0.85), size]), albedo, KIND.blossom, sway);
  }
}

/** A broad evergreen (a camphor or an oak) in the grove behind the banks: a stout trunk under a big rounded crown. */
function evergreen(b: Builder, x: number, z: number, height: number, random: Random): void {
  const foot = new THREE.Vector3(x, groundHeight(x, z) - 0.2, z);
  const bark = color(0.16, 0.12, 0.09, random);
  b.add(taperedTube(new THREE.LineCurve3(foot, foot.clone().setY(foot.y + height * 0.5)), 2, 6, 0.36, 0.22), new THREE.Matrix4(), bark, KIND.bark);
  const crown = height * 0.45;
  const green = color(random.pick([0.035, 0.045, 0.03]), random.range(0.13, 0.19), 0.03, random, 0.1);
  for (let i = 0; i < 9; i++) {
    const a = random.range(0, Math.PI * 2);
    const r = random.range(0, crown * 0.7);
    const size = crown * random.range(0.42, 0.58);
    const p: THREE.Vector3Tuple = [x + Math.cos(a) * r, foot.y + height * 0.5 + crown * 0.45 + random.range(-0.2, 0.45) * crown * (1 - r / crown), z + Math.sin(a) * r];
    b.add(blob(random, 1, 0.22, 2.2), at(p, [random.range(0, 6), random.range(0, 6), 0], [size, size * 0.75, size]), green, KIND.leaves, 0.04);
  }
}

/** The grove: clumps of evergreens behind the banks, a dark backdrop for the blossom, thinning towards the camera's side. */
function grove(b: Builder): void {
  const random = makeRandom(53);
  for (let i = 0; i < 30; i++) {
    const a = (i / 30) * Math.PI * 2 - Math.PI + random.range(-0.06, 0.06);
    if (Math.abs(a) > 2.4 && random.chance(0.5)) continue;
    const [x, z] = onBank(a, random.range(13, 19) + (Math.abs(a) < 0.6 ? 3 : 0));
    const clump = random.int(2, 3);
    for (let k = 0; k < clump; k++) evergreen(b, x + random.range(-2.5, 2.5), z + random.range(-2.5, 2.5), random.range(5.5, 8), random);
  }
}

/** A cloud-pruned pine: a twisting trunk with flat pads of needles held out in tiers. */
function pine(b: Builder, tree: Tree): void {
  const random = makeRandom(tree.seed * 17 + 3);
  const spot = clearOfCamera(tree.at, tree.crown * 1.2 + Math.tan(tree.lean) * tree.height);
  const foot = new THREE.Vector3(spot[0], groundHeight(spot[0], spot[1]) - 0.1, spot[1]);
  const lean = towardsWater(spot).multiplyScalar(Math.tan(tree.lean) * tree.height);
  const side = new THREE.Vector3(-lean.z, 0, lean.x).normalize();
  const bark = color(0.27, 0.2, 0.17, random);
  const points = [0, 0.3, 0.55, 0.8, 1].map((t, i) => foot.clone()
    .addScaledVector(lean, t * (1 - 0.3 * t))
    .addScaledVector(side, Math.sin(t * 5 + tree.seed) * 0.5 * (i ? 1 : 0))
    .setY(foot.y + tree.height * t));
  const trunk = new THREE.CatmullRomCurve3(points);
  b.add(taperedTube(trunk, 12, 7, 0.26, 0.08), new THREE.Matrix4(), bark, KIND.bark);
  const sway = (p: THREE.Vector3) => Math.max(0, (p.y - foot.y) / tree.height - 0.3) * 0.5;
  const tiers = 5;
  for (let i = 0; i < tiers; i++) {
    const t = 0.42 + (i / (tiers - 1)) * 0.58;
    const from = trunk.getPointAt(Math.min(t, 0.98));
    const a = i * 2.4 + tree.seed + random.range(-0.4, 0.4);
    const reach = i === tiers - 1 ? 0 : tree.crown * (1 - t * 0.55) * random.range(0.7, 1);
    const end = from.clone().add(new THREE.Vector3(Math.cos(a) * reach, random.range(0.1, 0.4), Math.sin(a) * reach));
    if (reach > 0) b.add(taperedTube(new THREE.LineCurve3(from, end), 3, 4, 0.08, 0.04), new THREE.Matrix4(), bark, KIND.bark, sway);
    const size = tree.crown * (i === tiers - 1 ? 0.42 : 0.5 - t * 0.18);
    const green = color(0.05, 0.16, 0.04, random, 0.12);
    b.add(blob(random, 2, 0.3, 3), at(end.clone().setY(end.y + size * 0.15).toArray(), [0, random.range(0, 6), 0], [size, size * 0.38, size * random.range(0.8, 1)]), green, KIND.needles, sway);
  }
}

// --- Shrubs ----------------------------------------------------------------

/** Clipped azalea mounds along the banks, most in flower. */
function shrubs(b: Builder): void {
  const random = makeRandom(23);
  const colours = [color(0.8, 0.08, 0.3), color(0.9, 0.22, 0.48), color(0.92, 0.36, 0.58), color(0.86, 0.82, 0.84), color(0.68, 0.04, 0.2)];
  for (const s of shoreScatter(29, 46, [1.2, 6.5], [0.7, 1.5])) {
    const [x, z] = s.at;
    const y = groundHeight(x, z);
    const flowering = s.seed > 0.3;
    const albedo = flowering ? random.pick(colours).clone().multiplyScalar(random.range(0.92, 1.05)) : color(0.05, 0.2, 0.03, random);
    const scale: THREE.Vector3Tuple = [s.size * random.range(1, 1.5), s.size * random.range(0.55, 0.75), s.size * random.range(0.9, 1.2)];
    b.add(blob(random, 2, 0.12, 2.2), at([x, y + scale[1] * 0.35, z], [0, random.range(0, 6), 0], scale), albedo, flowering ? KIND.flowers : KIND.leaves, 0.06);
    // A smaller mound tucked beside some.
    if (random.chance(0.5)) {
      const k = random.range(0.5, 0.7);
      const a = random.range(0, 6.28);
      const px = x + Math.cos(a) * s.size * 1.1;
      const pz = z + Math.sin(a) * s.size * 1.1;
      b.add(blob(random, 2, 0.12, 2.2), at([px, groundHeight(px, pz) + scale[1] * k * 0.3, pz], [0, random.range(0, 6), 0], [scale[0] * k, scale[1] * k, scale[2] * k]), albedo, flowering ? KIND.flowers : KIND.leaves, 0.06);
    }
  }
}

// --- Lanterns --------------------------------------------------------------

const hexagon = (rTop: number, rBottom: number, height: number) => new THREE.CylinderGeometry(rTop, rBottom, height, 6, 1).toNonIndexed();

/** A Kasuga stone lantern, `height` tall, its light box glowing softly. */
function lantern(b: Builder, x: number, z: number, height: number, turn: number): void {
  const y = groundHeight(x, z) - 0.04;
  const stoneCol = color(0.66, 0.64, 0.58);
  const place = (g: THREE.BufferGeometry, cy: number, albedo: THREE.Color, kind: number) =>
    b.add(g, at([x, y + cy * height, z], [0, turn, 0], height), albedo, kind);
  place(hexagon(0.17, 0.21, 0.08), 0.04, stoneCol, KIND.lantern);
  place(new THREE.CylinderGeometry(0.065, 0.075, 0.42, 10), 0.29, stoneCol, KIND.lantern);
  place(hexagon(0.2, 0.15, 0.07), 0.535, stoneCol, KIND.lantern);
  place(hexagon(0.1, 0.1, 0.17), 0.655, color(1.0, 0.82, 0.55), KIND.glow);
  for (let i = 0; i < 6; i++) {
    const a = turn + (i / 6) * Math.PI * 2 + Math.PI / 6;
    b.add(new THREE.BoxGeometry(0.035, 0.18, 0.035), at([x + Math.cos(a) * 0.125 * height, y + 0.655 * height, z - Math.sin(a) * 0.125 * height], [0, a, 0], height), stoneCol, KIND.lantern);
  }
  place(hexagon(0.05, 0.3, 0.1), 0.79, stoneCol, KIND.lantern);
  place(hexagon(0.3, 0.28, 0.025), 0.745, stoneCol, KIND.lantern);
  place(new THREE.SphereGeometry(0.055, 10, 8), 0.88, stoneCol, KIND.lantern);
}

// --- Bridge ----------------------------------------------------------------

/** The vermilion drum bridge over the stream's mouth: an arched deck, railings with brass finials, and legs into the water. */
function bridge(b: Builder): void {
  const { length: L, rise, width: W, heading } = BRIDGE;
  const [bx, bz] = BRIDGE.at;
  const dirX = Math.cos(heading);
  const dirZ = -Math.sin(heading);
  const foot = (s: number) => groundHeight(bx + dirX * s * L * 0.5, bz + dirZ * s * L * 0.5);
  const base = Math.max(foot(-1), foot(1)) + 0.05;
  const frame = at([bx, base, bz], [0, heading, 0]);
  const arch = (u: number) => rise * (1 - u * u) ** 0.9;
  const lacquer = color(0.86, 0.16, 0.06);
  const deckCol = color(0.42, 0.24, 0.14);
  const brass = color(0.95, 0.72, 0.3);
  const segments = 22;
  const add = (g: THREE.BufferGeometry, local: THREE.Matrix4, albedo: THREE.Color, kind: number) => b.add(g, frame.clone().multiply(local), albedo, kind);
  for (let i = 0; i < segments; i++) {
    const u0 = (i / segments) * 2 - 1;
    const u1 = ((i + 1) / segments) * 2 - 1;
    const x0 = u0 * L * 0.5;
    const x1 = u1 * L * 0.5;
    const y0 = arch(u0);
    const y1 = arch(u1);
    const length = Math.hypot(x1 - x0, y1 - y0) + 0.02;
    const slope = Math.atan2(y1 - y0, x1 - x0);
    const mid: THREE.Vector3Tuple = [(x0 + x1) / 2, (y0 + y1) / 2, 0];
    // The girder, and the planked deck on it.
    add(new THREE.BoxGeometry(length, 0.22, W), at(mid, [0, 0, slope]), lacquer, KIND.lacquer);
    add(new THREE.BoxGeometry(length, 0.04, W - 0.12), at([mid[0], mid[1] + 0.12, 0], [0, 0, slope]), deckCol, KIND.wood);
    // Two rails each side, following the arch.
    for (const side of [-1, 1]) {
      for (const h of [0.5, 0.9]) add(new THREE.BoxGeometry(length, 0.07, 0.07), at([mid[0], mid[1] + h, side * (W * 0.5 - 0.04)], [0, 0, slope]), lacquer, KIND.lacquer);
    }
  }
  // Posts, the end ones taller with brass onion finials.
  for (let i = 0; i <= 8; i++) {
    const u = (i / 8) * 2 - 1;
    const x = u * L * 0.5 * 0.985;
    const y = arch(u);
    const end = i === 0 || i === 8;
    const h = end ? 1.15 : 0.95;
    for (const side of [-1, 1]) {
      const z = side * (W * 0.5 - 0.04);
      add(new THREE.BoxGeometry(0.11, h, 0.11), at([x, y + h * 0.5, z]), lacquer, KIND.lacquer);
      if (end) {
        add(new THREE.SphereGeometry(0.1, 10, 8), at([x, y + h + 0.06, z], [0, 0, 0], [1, 0.9, 1]), brass, KIND.brass);
        add(new THREE.ConeGeometry(0.05, 0.14, 8), at([x, y + h + 0.19, z]), brass, KIND.brass);
      }
    }
  }
  // Legs down into the stream, with a cross beam.
  for (const u of [-0.42, 0.42]) {
    const x = u * L * 0.5;
    const y = arch(u);
    for (const side of [-1, 1]) add(new THREE.BoxGeometry(0.16, y + 2.4, 0.16), at([x, (y - 2.4) * 0.5 - 0.1, side * (W * 0.5 - 0.1)]), lacquer, KIND.lacquer);
    add(new THREE.BoxGeometry(0.12, 0.12, W), at([x, y * 0.45, 0]), lacquer, KIND.lacquer);
  }
}

export function gardenGeometry(): THREE.BufferGeometry {
  const b = new Builder();
  stones(b);
  for (const tree of CHERRIES) cherry(b, tree);
  for (const tree of PINES) pine(b, tree);
  grove(b);
  shrubs(b);
  for (const l of LANTERNS) lantern(b, l.at[0], l.at[1], l.height, l.turn);
  bridge(b);
  return b.build();
}
