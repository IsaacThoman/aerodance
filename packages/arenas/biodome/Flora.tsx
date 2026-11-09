import * as THREE from 'three';
import { useDisposable } from '../../stages/shared/hooks.ts';
import { shaderMaterial } from '../../stages/shared/glsl.ts';
import { makeRandom } from '../../stages/shared/random.ts';
import type { Random } from '../../stages/shared/random.ts';
import { BED, FALL, HUB, PLANTERS, PLANTER_TOP, POOL, SHELF, bedPoint, onDeck } from './layout.ts';
import { LEAF, Leaves, type LeafSpec } from './Leaves.tsx';
import { floorHeight, treeMaterial, woody } from './Forest.tsx';
import { LIGHT, fx, instanced, limb, merge } from './shading.ts';
import { TREES, crownBlobs, fromCentre, inRocks, type Tree } from './trees.ts';

// The plants: palms and tree ferns round the deck and the pool, bananas, elephant ears and
// red-hearted bromeliads on the rocks, monsteras and tree ferns in the deck's planters, leaves
// over the near crowns so they break up into real foliage, vines hanging from the giant trees
// and the cliff, and orchids everywhere.

const PALM_BARK = [0.56, 0.48, 0.36] as const;
const FERN_BARK = [0.24, 0.17, 0.11] as const;
const GREEN_STEM = [0.3, 0.46, 0.16] as const;
const VINE = [0.32, 0.36, 0.18] as const;

export interface FlowerSpec {
  x: number;
  y: number;
  z: number;
  /** Which way the bloom faces. */
  yaw: number;
  pitch: number;
  size: number;
  /** 0 magenta, 1 white and pink, 2 violet, 3 sunny yellow. */
  hue: number;
  seed: number;
}

interface Flora {
  leaves: LeafSpec[];
  /** Shadow-casting leaves near the deck. */
  near: LeafSpec[];
  flowers: FlowerSpec[];
  wood: THREE.BufferGeometry;
}

/** Where the rock shelf's rim is at angle t round the pool. */
const rimPoint = (t: number, k = SHELF.rim + 0.06) =>
  new THREE.Vector3(POOL.x + Math.sin(t) * POOL.rx * SHELF.scale * k, -0.25, POOL.z + Math.cos(t) * POOL.rz * SHELF.scale * k);

function buildFlora(): Flora {
  const rand = makeRandom(4242);
  const leaves: LeafSpec[] = [];
  const near: LeafSpec[] = [];
  const flowers: FlowerSpec[] = [];
  const wood: THREE.BufferGeometry[] = [];
  const seed = () => rand.next();

  const palm = (x: number, y: number, z: number, height: number, lean: number, heading: number, scale = 1, list = leaves) => {
    const segs = 8;
    const dir = new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading));
    let prev = new THREE.Vector3(x, y, z);
    for (let i = 1; i <= segs; i++) {
      const t = i / segs;
      const p = new THREE.Vector3(x, y + t * height, z).addScaledVector(dir, lean * t * t);
      wood.push(woody(limb(prev, p, 0.24 - (t - 1 / segs) * 0.08, 0.24 - t * 0.08, 9), PALM_BARK));
      prev = p;
    }
    const n = 13;
    for (let k = 0; k < n; k++) {
      const young = k < 3;
      list.push({
        x: prev.x, y: prev.y - 0.15, z: prev.z, length: rand.range(3.4, 4.6) * scale * (young ? 0.75 : 1), width: 0.34,
        yaw: (k / n) * Math.PI * 2 + rand.range(-0.25, 0.25), pitch: young ? rand.range(1.0, 1.25) : rand.range(0.15, 0.75),
        type: LEAF.palm, tone: rand.range(0.4, 1), bend: young ? 0.7 : rand.range(1.7, 2.5), seed: seed(), stalk: 0.12, fold: -0.35, sway: 1, curl: 0,
      });
    }
  };

  const treeFern = (x: number, y: number, z: number, height: number, list = leaves) => {
    const top = new THREE.Vector3(x + rand.range(-0.2, 0.2), y + height, z + rand.range(-0.2, 0.2));
    wood.push(woody(limb(new THREE.Vector3(x, y, z), top, 0.17, 0.13, 8), FERN_BARK));
    const n = 12;
    for (let k = 0; k < n; k++) {
      list.push({
        x: top.x, y: top.y, z: top.z, length: rand.range(1.8, 2.5), width: 0.3,
        yaw: (k / n) * Math.PI * 2 + rand.range(-0.2, 0.2), pitch: rand.range(0.45, 0.95),
        type: LEAF.fern, tone: rand.range(0.5, 1), bend: rand.range(1.5, 2.1), seed: seed(), stalk: 0.08, fold: 0.12, sway: 1.1, curl: 0,
      });
    }
  };

  const banana = (x: number, y: number, z: number, list = leaves) => {
    const h = rand.range(1.3, 1.9);
    wood.push(woody(limb(new THREE.Vector3(x, y, z), new THREE.Vector3(x, y + h, z), 0.15, 0.11, 8), GREEN_STEM));
    const n = 7;
    for (let k = 0; k < n; k++) {
      list.push({
        x, y: y + h - 0.1, z, length: rand.range(2.0, 2.7), width: 0.34,
        yaw: (k / n) * Math.PI * 2 + rand.range(-0.3, 0.3), pitch: rand.range(0.85, 1.3),
        type: LEAF.banana, tone: rand.range(0.3, 1), bend: rand.range(1.3, 1.8), seed: seed(), stalk: 0.12, fold: 0.15, sway: 1.2, curl: 0.05,
      });
    }
  };

  const rosette = (x: number, y: number, z: number, type: LeafSpec['type'], n: number, size: number, list = leaves) => {
    const big = type === LEAF.broad;
    const offset = rand.range(0, 6.3);
    for (let k = 0; k < n; k++) {
      list.push({
        x, y, z, length: size * rand.range(0.8, 1.15), width: type === LEAF.monstera ? 0.85 : big ? 0.68 : 0.5,
        yaw: offset + (k / n) * Math.PI * 2 + rand.range(-0.3, 0.3), pitch: rand.range(0.95, 1.3),
        type, tone: rand.range(0.2, 1), bend: rand.range(1.7, 2.3), seed: seed(), stalk: 0.42, fold: 0.08, sway: 0.8, curl: 0.12,
      });
    }
  };

  const bromeliad = (x: number, y: number, z: number, red: boolean, size = 1, list = leaves) => {
    const n = 14;
    for (let k = 0; k < n; k++) {
      const inner = k < 5;
      list.push({
        x, y, z, length: size * (inner ? 0.42 : rand.range(0.55, 0.75)), width: 0.17,
        yaw: (k / n) * Math.PI * 2 * 2.6, pitch: inner ? rand.range(1.15, 1.4) : rand.range(0.6, 1.1),
        type: LEAF.strap, tone: red && inner ? 0.95 : rand.range(0.2, 0.7), bend: inner ? 0.8 : rand.range(1.6, 2.4), seed: seed(), stalk: 0.02, fold: 0.35, sway: 0.4, curl: 0,
      });
    }
  };

  const orchids = (x: number, y: number, z: number, facing: number, hue: number, n = 6, size = 1) => {
    // An arching spray: a stem rising and nodding over, blooms along its outer half.
    const arch: THREE.Vector3[] = [];
    const reach = 0.55 * size;
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      arch.push(new THREE.Vector3(x + Math.sin(facing) * reach * t, y + Math.sin(t * 2.2) * 0.45 * size, z + Math.cos(facing) * reach * t));
    }
    for (let i = 1; i < arch.length; i++) wood.push(woody(limb(arch[i - 1], arch[i], 0.008, 0.007, 4), GREEN_STEM));
    for (let i = 0; i < n; i++) {
      const t = 0.4 + (0.6 * i) / Math.max(1, n - 1);
      const p = new THREE.CatmullRomCurve3(arch).getPoint(t);
      flowers.push({ x: p.x, y: p.y - 0.03, z: p.z, yaw: facing + rand.range(-0.5, 0.5), pitch: rand.range(-0.2, 0.25), size: 0.1 * size * rand.range(0.85, 1.15), hue, seed: seed() });
    }
    // Its broad, waxy leaves at the foot.
    for (let k = 0; k < 4; k++) {
      leaves.push({
        x, y, z, length: 0.32 * size, width: 0.42, yaw: facing + Math.PI + (k - 1.5) * 0.9, pitch: 0.25, type: LEAF.broad, tone: 0.3,
        bend: 0.6, seed: seed(), stalk: 0.02, fold: 0.25, sway: 0.2, curl: 0.1,
      });
    }
  };

  const vine = (x: number, y: number, z: number, length: number) => {
    const pts: THREE.Vector3[] = [];
    const sway = rand.range(0, 6.3);
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      pts.push(new THREE.Vector3(x + Math.sin(sway + t * 2) * 0.15 * t, y - t * length, z + Math.cos(sway + t * 2) * 0.15 * t));
    }
    for (let i = 1; i < pts.length; i++) wood.push(woody(limb(pts[i - 1], pts[i], 0.022, 0.018, 4), VINE));
    const curve = new THREE.CatmullRomCurve3(pts);
    const count = Math.floor(length / 0.2);
    for (let i = 0; i < count; i++) {
      const p = curve.getPoint((i + 0.5) / count);
      const tip = i > count - 4;
      leaves.push({
        x: p.x, y: p.y, z: p.z, length: rand.range(0.2, 0.32) * (tip ? 0.7 : 1), width: 0.6, yaw: rand.range(0, 6.3), pitch: rand.range(-0.3, 0.5),
        type: LEAF.broad, tone: rand.range(0.4, 1), bend: 0.9, seed: seed(), stalk: 0.25, fold: 0.15, sway: 1.4, curl: 0.05,
      });
    }
  };

  // --- The deck's planters: tree ferns at the far end, monsteras by the walkway, orchids in all.
  PLANTERS.forEach(([x, z], i) => {
    const y = PLANTER_TOP;
    if (z < 0) treeFern(x, y, z, 2.0 + i * 0.2, near);
    else rosette(x, y, z, LEAF.monstera, 10, 1.25, near);
    bromeliad(x + (x > 0 ? -0.35 : 0.35), y, z + (z > 0 ? -0.3 : 0.3), true, 0.8, near);
    orchids(x + (x > 0 ? -0.25 : 0.25), y, z + (z > 0 ? -0.45 : 0.45), Math.atan2(-x, -z), i % 4, 7, 1.1);
  });

  // --- The garden bed along the far railing: elephant ears, ferns and red-hearted bromeliads in
  // turn, orchids leaning out over the court, the biggest ears in the middle.
  {
    const y = BED.height - 0.03;
    const at = (share: number, across = 0) => bedPoint(-BED.reach + 2 * BED.reach * share, across);
    const towardsCourt = (p: THREE.Vector3) => Math.atan2(-p.x, -p.z);
    const plants: readonly [share: number, across: number, kind: string][] = [
      [0.03, 0, 'brom'], [0.13, 0.2, 'orchid'], [0.21, -0.06, 'ears'], [0.32, 0.16, 'red'], [0.41, -0.04, 'fern'],
      [0.5, -0.08, 'big'], [0.5, 0.22, 'orchid'], [0.59, -0.04, 'fern'], [0.68, 0.16, 'red'], [0.79, -0.06, 'ears'],
      [0.87, 0.2, 'orchid'], [0.97, 0, 'red'],
    ];
    plants.forEach(([share, across, kind], i) => {
      const p = at(share, across);
      if (kind === 'ears' || kind === 'big') rosette(p.x, y, p.z, LEAF.broad, kind === 'big' ? 6 : 5, kind === 'big' ? 1.25 : 1.0, near);
      else if (kind === 'fern') rosette(p.x, y, p.z, LEAF.fern, 8, 1.05, near);
      else if (kind === 'orchid') orchids(p.x, y, p.z, towardsCourt(p), i % 4, 6, 1.0);
      else bromeliad(p.x, y, p.z, kind === 'red', kind === 'red' ? 0.85 : 0.75, near);
    });
  }

  // --- Round the pool: palms leaning out over it, bananas and elephant ears on the rim, tree
  // ferns and bromeliads between.
  palm(-7.2, -0.3, 5.0, 8.5, 1.6, -2.4, 1, near);
  palm(-13.6, -0.3, -8.4, 10.5, 2.2, 0.6);
  palm(-15.6, -0.3, 4.4, 7.5, 1.8, 1.2);
  const rimPlants: readonly [number, string][] = [
    [-2.4, 'ear'], [-2.0, 'brom'], [-1.7, 'banana'], [-1.25, 'fern'], [-0.85, 'ear'], [-0.55, 'brom'],
    [-0.15, 'ear'], [0.25, 'fern'], [0.55, 'brom'], [0.85, 'banana'], [1.2, 'ear'],
    [2.55, 'ear'], [2.95, 'brom'], [3.25, 'fern'], [-2.75, 'brom'],
  ];
  for (const [t, kind] of rimPlants) {
    const p = rimPoint(Math.PI + t, SHELF.rim + rand.range(0.05, 0.12));
    if (onDeck(p.x, p.z, -0.6)) continue;
    if (kind === 'ear') rosette(p.x, p.y, p.z, LEAF.broad, 6, rand.range(1.4, 1.9));
    else if (kind === 'brom') bromeliad(p.x, p.y, p.z, rand.chance(0.6), 1.1);
    else if (kind === 'banana') banana(p.x, p.y, p.z);
    else treeFern(p.x, p.y, p.z, rand.range(1.6, 2.6));
  }
  orchids(-8.6, -0.25, 3.9, 0.6, 0, 6, 1.2);
  orchids(-12.2, -0.25, -7.6, 2.2, 2, 6, 1.2);
  orchids(-6.4, -0.25, -6.0, 1.8, 1, 6, 1.1);

  // --- The cliff: palms and ferns along its top, plants on its ledges, vines down its face.
  palm(-21.8, 15.8, -8.5, 7, 1.4, 1.4);
  palm(-23.4, 16.6, 1.5, 8.5, 1.8, 1.9);
  palm(-19.8, 11, 8.6, 6.5, 1.2, 1.0);
  for (const [x, y, z] of [[-20.5, 15.5, -1.0], [-20.8, 15.2, -5.8], [-19.2, 12.8, 3.5], [-18.6, 10.5, -9.8], [-22.5, 16.5, -4.5], [-21, 14.4, 5.6]] as const) {
    rosette(x, y, z, rand.chance(0.5) ? LEAF.fern : LEAF.broad, 7, rand.range(1.2, 1.8));
    bromeliad(x + 0.6, y - 0.1, z + 0.5, rand.chance(0.5));
  }
  for (let i = 0; i < 9; i++) {
    const z = FALL.z + (i < 4 ? -2.2 - i * 1.3 : 2.2 + (i - 4) * 1.2);
    vine(-17.6 - Math.abs(z - FALL.z) * 0.15, 13.5 + rand.range(-1, 1), z, rand.range(4, 8));
  }
  orchids(-17.4, 8.2, -6.6, 1.6, 0, 5);
  orchids(-17.6, 6.0, 0.6, 1.4, 3, 5);

  // --- Palms rising out of the canopy round the deck, and round the hub.
  palm(7.8, -9.5, 1.8, 16.2, 2.4, 0.5);
  palm(6.6, -10, -9.6, 16.8, 2.0, 2.4);
  palm(-3.8, -9.5, 11.4, 15.2, 2.6, -0.4);
  palm(9.2, -10, 10.4, 14.4, 2.2, 0.9);
  palm(19.4, -10, 28, 16, 2.4, 0.2);
  palm(27.6, -10, 18.6, 15.2, 2.0, 2.2);
  palm(-1.5, -11, -12.5, 14.6, 2.0, 3.0);
  palm(13.6, -9, 14.5, 13.5, 1.8, -2.4);

  // --- Vines hanging from the giant trees' crowns, epiphytes and orchids on their trunks.
  const giants = TREES.slice(0, 3);
  for (const t of giants) {
    for (let i = 0; i < 14; i++) {
      const a = rand.range(0, Math.PI * 2);
      const r = t.r * rand.range(0.45, 0.85);
      const x = t.x + Math.sin(a) * r;
      const z = t.z + Math.cos(a) * r;
      if (onDeck(x, z, -0.8)) continue;
      vine(x, t.y - t.r * 0.25, z, rand.range(5, 11));
    }
    for (let i = 0; i < 4; i++) {
      const a = rand.range(0, Math.PI * 2);
      const y = t.y - t.r * 0.45 - 2 - i * 3.2;
      if (y < -12) continue;
      const x = t.x + Math.sin(a) * (t.trunk * 0.75 + 0.1);
      const z = t.z + Math.cos(a) * (t.trunk * 0.75 + 0.1);
      bromeliad(x, y, z, i % 2 === 0, 1.4);
      orchids(x, y + 0.1, z, a, (i + 1) % 4, 6, 1.1);
    }
  }

  // --- Leaves over the near crowns, so their silhouettes break up into foliage.
  for (const t of TREES) {
    if (t.under || fromCentre(t) > 30) continue;
    crownLeaves(t, rand, leaves);
  }

  // --- The understory under the deck, seen looking down over the railing.
  for (let i = 0; i < 140; i++) {
    const a = rand.range(0, Math.PI * 2);
    const r = rand.range(3, 26);
    const x = Math.sin(a) * r;
    const z = Math.cos(a) * r;
    if (inRocks(x, z)) continue;
    const y = floorHeight(x, z);
    const kind = rand.next();
    if (kind < 0.4) rosette(x, y, z, LEAF.broad, 6, rand.range(1.2, 2.2));
    else if (kind < 0.65) treeFern(x, y, z, rand.range(2, 4.5));
    else if (kind < 0.85) banana(x, y, z);
    else rosette(x, y, z, LEAF.fern, 8, rand.range(1.4, 2));
  }

  // --- Tree ferns and a palm by the walkway, rising from the canopy below.
  for (const [x, z, h] of [[3.4, 11.2, 10.5], [-2.2, 15.5, 11], [10.4, 23.6, 11.5], [16.8, 19.0, 10.2], [30.8, 22.5, 11.4], [34.2, 9.5, 10.8]] as const) {
    treeFern(x, -h + 0.6, z, h - 0.6 + rand.range(-0.4, 0.6));
  }
  // The hub's giant tree: epiphytes round its trunk above the deck.
  for (let i = 0; i < 5; i++) {
    const a = i * 1.3 + 0.4;
    const y = 2.6 + i * 1.7;
    const x = HUB.x + Math.sin(a) * (HUB.trunk + 0.3);
    const z = HUB.z + Math.cos(a) * (HUB.trunk + 0.3);
    bromeliad(x, y, z, i % 2 === 1, 1.3);
    orchids(x, y + 0.05, z, a, i % 4, 6, 1.1);
  }
  for (let i = 0; i < 18; i++) {
    const a = rand.range(0, Math.PI * 2);
    const r = rand.range(4.5, 8.5);
    vine(HUB.x + Math.sin(a) * r, 11 + rand.range(-1, 2), HUB.z + Math.cos(a) * r, rand.range(5, 10.5));
  }

  return { leaves, near, flowers, wood: merge(wood) };
}

/** Leaves shingled over a crown's clusters, so up close its silhouette breaks into foliage. */
function crownLeaves(t: Tree, rand: Random, out: LeafSpec[]) {
  const close = fromCentre(t) < 18;
  for (const b of crownBlobs(t)) {
    if (b.inner) continue;
    const n = Math.round(b.r * b.r * (close ? 3.2 : 1.4));
    for (let i = 0; i < n; i++) {
      // A point on the cluster's upper side, leaning away from the crown's middle.
      const a = rand.range(0, Math.PI * 2);
      const up = rand.range(-0.15, 0.95);
      const ring = Math.sqrt(Math.max(0, 1 - up * up));
      const dx = Math.cos(a) * ring;
      const dz = Math.sin(a) * ring;
      const x = b.c.x + dx * b.r;
      const y = b.c.y + up * b.r * 0.8;
      const z = b.c.z + dz * b.r;
      if (onDeck(x, z, -1.2) && y > -1.2) continue;
      const elevation = Math.asin(up);
      out.push({
        x, y, z, length: rand.range(0.75, 1.2), width: 0.5, yaw: Math.atan2(dx, dz) + rand.range(-0.4, 0.4),
        pitch: (elevation - Math.PI / 2) * 0.65 + 0.35 + rand.range(-0.2, 0.2), type: LEAF.broad,
        tone: Math.min(1, t.tone * 0.5 + rand.range(0, 0.5)), bend: rand.range(0.6, 1.1), seed: rand.next(), stalk: 0.15, fold: 0.2, sway: 0.6, curl: 0.12,
      });
    }
  }
}

// ------------------------------------------------------------------ orchids

const flowerVertex = /* glsl */ `
attribute vec4 aPos;
attribute vec4 aDir;
uniform float uTime;
varying vec2 vUv;
varying float vHue;
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  float yaw = aDir.x + sin(uTime * 1.3 + aDir.w * 20.0) * 0.08;
  float pitch = aDir.y + sin(uTime * 1.7 + aDir.w * 13.0) * 0.06;
  vec3 f = vec3(sin(yaw) * cos(pitch), sin(pitch), cos(yaw) * cos(pitch));
  vec3 r = normalize(cross(vec3(0.0, 1.0, 0.0), f));
  vec3 u = cross(f, r);
  vec3 w = aPos.xyz + (r * position.x + u * position.y) * aPos.w;
  vUv = uv;
  vHue = aDir.z;
  vWorld = w;
  vNormal = f;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}
`;

const flowerFragment = /* glsl */ `
${LIGHT}
varying vec2 vUv;
varying float vHue;
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  float r = length(p);
  float a = atan(p.y, p.x + 1e-5);
  // Five rounded petals, the two side ones broadest, and a lip in the middle.
  float petal = 0.55 + 0.45 * pow(abs(cos(a * 2.5 + 1.5708)), 0.6);
  petal *= 1.0 - 0.18 * smoothstep(0.2, -0.9, sin(a));
  if (r > petal) discard;
  vec3 c1, c2;
  if (vHue < 0.5) { c1 = vec3(0.95, 0.12, 0.55); c2 = vec3(1.0, 0.75, 0.9); }
  else if (vHue < 1.5) { c1 = vec3(1.0, 0.94, 0.97); c2 = vec3(0.98, 0.5, 0.75); }
  else if (vHue < 2.5) { c1 = vec3(0.55, 0.2, 0.85); c2 = vec3(0.92, 0.75, 1.0); }
  else { c1 = vec3(1.0, 0.8, 0.12); c2 = vec3(1.0, 0.45, 0.1); }
  vec3 albedo = mix(c2, c1, smoothstep(0.1, 0.75, r / petal));
  albedo = mix(albedo, vec3(1.0, 0.85, 0.2), smoothstep(0.24, 0.1, r));
  vec3 n = normalize(vNormal);
  vec3 v = normalize(cameraPosition - vWorld);
  if (dot(n, v) < 0.0) n = -n;
  float reach = sunReach(vWorld);
  vec3 col = albedo * (ambient(n) * 1.1 + SUN * (max(dot(n, uSunDir), 0.0) * 0.7 + 0.25) * reach);
  gl_FragColor = vec4(haze(col, vWorld), 1.0);
}
`;

export function Flowers({ specs }: { specs: readonly FlowerSpec[] }) {
  const geometry = useDisposable(() => {
    const pos = new Float32Array(specs.length * 4);
    const dir = new Float32Array(specs.length * 4);
    specs.forEach((f, i) => {
      pos.set([f.x, f.y, f.z, f.size], i * 4);
      dir.set([f.yaw, f.pitch, f.hue, f.seed], i * 4);
    });
    const g = instanced(new THREE.PlaneGeometry(1, 1), specs.length, { aPos: [4, pos], aDir: [4, dir] });
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    return g;
  }, [specs]);
  const material = useDisposable(() => shaderMaterial({ uniforms: { ...fx }, vertexShader: flowerVertex, fragmentShader: flowerFragment, side: THREE.DoubleSide }));
  return <mesh geometry={geometry} material={material} frustumCulled={false} />;
}

export function Plants() {
  const flora = useDisposable(buildFlora);
  const material = useDisposable(treeMaterial);
  return (
    <>
      <mesh geometry={flora.wood} material={material} />
      <Leaves specs={flora.leaves} />
      <Leaves specs={flora.near} shadows />
      <Flowers specs={flora.flowers} />
    </>
  );
}

