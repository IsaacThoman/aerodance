import * as THREE from 'three';
import type { Vec3 } from '../catalog.ts';
import { makeRandom } from '../shared/random.ts';
import { makeNoise2 } from '../polar/noise.ts';
import { CABIN, STOVEPIPE } from './layout.ts';
import { box, finalize, lathe, place, rod, sheet } from './geometry.ts';
import type { PaintFn } from './geometry.ts';

// The A-frame's geometry, in cabin space (x across the gable, y up from the snow, z out of the
// glass). Timber, its load of snow and its icicles are separate pieces for separate materials.

const { halfWidth: HW, height: H, floor: F, depth: D, roof: T, overhang: OV, deck: DECK } = CABIN;
/** The roof slabs' back ends, past the back wall. */
const BACK = -D - 0.6;
const SLOPE = Math.atan2(H, HW);
const SLOPE_LENGTH = Math.hypot(HW, H);
/** Up the left slope, and out of it. */
const ALONG = new THREE.Vector2(HW, H).normalize();
const OUT = new THREE.Vector2(-ALONG.y, ALONG.x);
/** The outer (snow-side) surface's eave and apex on the left. */
const EAVE_OUT = new THREE.Vector2(-HW, F).addScaledVector(OUT, T);
const APEX_OUT = new THREE.Vector2(0, F + (T + -OUT.x * HW) / OUT.y);

/** The length of each slope. */
export const RAKE = SLOPE_LENGTH;

/** A point `a` up the front edge of a slope's underside (side -1 left, 1 right), where the fairy lights hang. */
export function rakePoint(side: -1 | 1, a: number): Vec3 {
  return [side * (HW - ALONG.x * a), F + ALONG.y * a, OV];
}

/** Height of the roof's outer surface above cabin-space x (0 beyond the eaves). */
export function roofTop(x: number): number {
  const ax = Math.abs(x);
  if (ax > -EAVE_OUT.x) return 0;
  return APEX_OUT.y - (ax / -EAVE_OUT.x) * (APEX_OUT.y - EAVE_OUT.y);
}

const PINE = '#7a4a2a';
const HONEY = '#c98a4e';
const DARK = '#4a2e1e';
const STONE = '#5a6070';
const IRON = '#23262e';

/** Timber with a faint grain. */
const wood = (base: THREE.ColorRepresentation, grain = 0.08): PaintFn => {
  const c = new THREE.Color(base);
  return (p, _n, out) => {
    const v = Math.sin(p.x * 3.1 + p.y * 1.7 + p.z * 2.3) * 0.5 + Math.sin(p.x * 11 - p.z * 7) * 0.5;
    out.copy(c).multiplyScalar(1 + v * grain);
  };
};

/** One roof slab, left (side -1) or right (1), with a honey-coloured fascia on its front edge. */
function roofSlab(side: -1 | 1): THREE.BufferGeometry {
  const length = SLOPE_LENGTH + 0.25;
  const fascia = new THREE.Color(HONEY);
  const soffit = new THREE.Color(PINE);
  const top = new THREE.Color(DARK);
  const g = finalize(new THREE.BoxGeometry(length, T, OV - BACK), (p, n, out) => {
    if (n.z > 0.9) out.copy(fascia);
    else if (n.y < -0.5) out.copy(soffit).multiplyScalar(1 + 0.12 * Math.sin(p.z * 9));
    else out.copy(top);
  });
  g.translate(length / 2 - 0.02, T / 2, (OV + BACK) / 2);
  g.rotateZ(SLOPE);
  g.translate(-HW, F, 0);
  if (side === 1) {
    g.scale(-1, 1, 1);
    // Mirroring turns the triangles inside out.
    const pos = g.attributes.position;
    const nrm = g.attributes.normal;
    const col = g.attributes.color;
    for (let i = 0; i < pos.count; i += 3) {
      for (const attr of [pos, nrm, col]) {
        const a = [attr.getX(i + 1), attr.getY(i + 1), attr.getZ(i + 1)];
        attr.setXYZ(i + 1, attr.getX(i + 2), attr.getY(i + 2), attr.getZ(i + 2));
        attr.setXYZ(i + 2, a[0], a[1], a[2]);
      }
    }
  }
  return g;
}

/** A gable-shaped slab (the back wall), from z0 to z1. */
function gableWall(z0: number, z1: number, paint: THREE.ColorRepresentation | PaintFn): THREE.BufferGeometry {
  const shape = new THREE.Shape([new THREE.Vector2(-HW, F), new THREE.Vector2(HW, F), new THREE.Vector2(0, F + H)]);
  const g = new THREE.ExtrudeGeometry(shape, { depth: z1 - z0, bevelEnabled: false });
  g.translate(0, 0, z0);
  return finalize(g, paint);
}

/** The deck's railing: posts and rails along its front (either side of the steps) and sides. */
function railing(): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  const x1 = HW + 0.3;
  const zf = DECK - 0.15;
  const top = F + 1.05;
  const posts: [number, number][] = [
    [-1.45, zf], [1.45, zf], [-3.4, zf], [3.4, zf], [-x1, zf], [x1, zf],
    [-x1, 1.7], [x1, 1.7], [-x1, 0.2], [x1, 0.2],
  ];
  for (const [x, z] of posts) parts.push(finalize(box([x - 0.08, F, z - 0.08], [x + 0.08, top, z + 0.08]), PINE));
  const rail = (a: Vec3, b: Vec3) => finalize(rod(a, b, 0.05, 0.05, 6), HONEY);
  for (const s of [-1, 1]) {
    for (const y of [top - 0.06, F + 0.5]) {
      parts.push(rail([s * 1.45, y, zf], [s * x1, y, zf]));
      parts.push(rail([s * x1, y, zf], [s * x1, y, 0.2]));
    }
  }
  return parts;
}

/** The timber (and stone and iron): roof, back wall, footing, deck, steps, railing and stovepipe. The glazing bars are the glass's. */
export function cabinTimber(): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [roofSlab(-1), roofSlab(1)];
  parts.push(gableWall(-D - 0.3, -D, wood(PINE)));
  // Footing under the cabin, and the front sill below the glass.
  parts.push(finalize(box([-HW, 0, -D - 0.3], [HW, F, 0]), STONE));
  parts.push(finalize(box([-HW, F - 0.12, -0.15], [HW, F + 0.12, 0.08]), HONEY));
  // Deck on a beam, planks running across.
  parts.push(
    finalize(box([-HW - 0.45, F - 0.28, 0], [HW + 0.45, F, DECK]), (p, n, out) => {
      out.set(HONEY).multiplyScalar(n.y > 0.5 ? 0.88 + 0.12 * Math.sin(Math.floor(p.z / 0.32) * 12.9) : 0.6);
    }),
  );
  parts.push(finalize(box([-HW - 0.3, 0, DECK - 0.4], [HW + 0.3, F - 0.28, DECK - 0.1]), DARK));
  for (let i = 0; i < 3; i++) {
    const y = F - ((i + 1) * F) / 3.4;
    parts.push(finalize(box([-1.15, 0, DECK + i * 0.42], [1.15, y + 0.06, DECK + (i + 1) * 0.42]), HONEY));
  }
  parts.push(...railing());
  // The stovepipe up through the left slope, with a cap.
  const { x, z } = STOVEPIPE;
  const foot = roofTop(x) - 0.3;
  parts.push(finalize(rod([x, foot, z], [x, foot + 3.1, z], 0.22, 0.22, 12), IRON));
  parts.push(finalize(place(lathe([[0.02, 0], [0.42, 0.02], [0.05, 0.36]], 12), { position: [x, foot + 3.32, z] }), IRON));
  for (const [dx, dz] of [[0.18, 0.18], [-0.18, 0.18], [0.18, -0.18], [-0.18, -0.18]]) {
    parts.push(finalize(rod([x + dx, foot + 3.08, z + dz], [x + dx, foot + 3.34, z + dz], 0.02, 0.02, 4), IRON));
  }
  return parts;
}

/** Where the stovepipe's smoke leaves it (cabin space). */
export const FLUE: Vec3 = [STOVEPIPE.x, roofTop(STOVEPIPE.x) - 0.3 + 3.3, STOVEPIPE.z];

/** A quarter-round edge: 0 at d = 0, 1 from d = r on. */
const rounded = (d: number, r: number) => {
  const k = Math.min(Math.max(d / r, 0), 1);
  return Math.sqrt(k * (2 - k));
};

const lumps = makeNoise2(83);

/** The thick, rounded blanket of snow over both slopes, curling over the ridge and the front. */
function roofSnow(): THREE.BufferGeometry {
  const half = APEX_OUT.distanceTo(EAVE_OUT);
  const front = OV + 0.22;
  const back = BACK - 0.1;
  const p2 = new THREE.Vector2();
  const n2 = new THREE.Vector2();
  return sheet(64, 34, (u, v, out) => {
    // s runs up the left slope from its eave to the ridge and down the right.
    const s = u * 2 * half;
    const left = s < half;
    const along = left ? s : 2 * half - s;
    p2.copy(EAVE_OUT).addScaledVector(ALONG, along);
    if (!left) p2.x = -p2.x;
    // Outward, rounding off over the ridge.
    const k = THREE.MathUtils.smoothstep(s, half - 0.9, half + 0.9);
    n2.set(OUT.x * (1 - 2 * k), OUT.y).normalize();
    const z = THREE.MathUtils.lerp(back, front, v);
    const edge = Math.min(s, 2 * half - s, front - z, z - back);
    const depth = 0.72 * (1 + 0.22 * lumps(s * 0.6, z * 0.35)) * rounded(edge + 0.04, 0.55) + 0.05 * Math.exp(-((s - half) ** 2) / 0.6);
    // The lip droops a little past the front edge and the eaves.
    const droop = Math.max(0, z - OV) * 0.9 + Math.max(0, 0.25 - Math.min(s, 2 * half - s)) * 0.6;
    out.set(p2.x + n2.x * depth, p2.y + n2.y * depth - droop, z);
  });
}

/** Snow on the deck either side of a swept path, on the rails and post tops, and drifted against the cabin. */
function groundSnow(): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  const pillow = (cx: number, cz: number, w: number, d: number, h: number, y: number, seed: number) =>
    sheet(16, 12, (u, v, out) => {
      const x = (u - 0.5) * w;
      const z = (v - 0.5) * d;
      const edge = Math.min(u, 1 - u) * w;
      const edgeZ = Math.min(v, 1 - v) * d;
      const t = h * rounded(Math.min(edge, edgeZ) + 0.02, 0.35) * (1 + 0.2 * lumps(x * 0.8 + seed, z * 0.8));
      out.set(cx + x, y + t, cz + z);
    });
  parts.push(pillow(-3.55, DECK / 2, 4.3, DECK - 0.1, 0.28, F, 1));
  parts.push(pillow(3.55, DECK / 2, 4.3, DECK - 0.1, 0.24, F, 7));
  // Rails and posts.
  const x1 = HW + 0.3;
  const zf = DECK - 0.15;
  for (const s of [-1, 1]) {
    parts.push(place(new THREE.CapsuleGeometry(0.09, Math.abs(x1 - 1.45), 3, 6), { position: [s * (1.45 + x1) / 2, F + 1.06, zf], rotation: [0, 0, Math.PI / 2] }));
    parts.push(place(new THREE.CapsuleGeometry(0.09, zf - 0.2, 3, 6), { position: [s * x1, F + 1.06, (zf + 0.2) / 2], rotation: [Math.PI / 2, 0, 0] }));
  }
  // Drifts banked against the footing and round the deck.
  const rand = makeRandom(29);
  for (let i = 0; i < 14; i++) {
    const side = i % 2 ? 1 : -1;
    const z = -D + (i / 14) * (D + DECK);
    parts.push(place(new THREE.SphereGeometry(1, 14, 8), { position: [side * (HW + 0.5), 0.05, z], scale: [1.1 + rand.next() * 0.5, F * (0.7 + rand.next() * 0.35), 1.2 + rand.next() * 0.6] }));
  }
  for (const x of [-4.6, -2.6, 2.7, 4.4]) parts.push(place(new THREE.SphereGeometry(1, 14, 8), { position: [x, 0.05, DECK + 0.5], scale: [1.2, F * 0.55, 0.9] }));
  return parts.map((g) => finalize(g, '#eef4ff', true));
}

/** The snow on and around the cabin. */
export function cabinSnow(): THREE.BufferGeometry[] {
  return [finalize(roofSnow(), '#f4f8ff'), ...groundSnow()];
}

/** Icicles along the lower front edges of the roof and down both eaves. */
export function cabinIcicles(): THREE.BufferGeometry[] {
  const rand = makeRandom(61);
  const parts: THREE.BufferGeometry[] = [];
  const icicle = (x: number, y: number, z: number, length: number) =>
    parts.push(finalize(place(lathe([[0.0, -length], [0.035, -length * 0.55], [0.07, -0.08], [0.09, 0], [0, 0.02]], 7), { position: [x, y, z] }), '#cfeeff'));
  for (const side of [-1, 1]) {
    // Front edges: thickest at the bottom of the slope.
    for (let a = 0.3; a < SLOPE_LENGTH * 0.45; a += 0.32 + rand.next() * 0.12) {
      const x = side * (HW - ALONG.x * a);
      const y = F + ALONG.y * a - 0.02;
      icicle(x, y, OV - 0.08, (0.35 + rand.next() * 0.75) * (1 - a / (SLOPE_LENGTH * 0.55)));
    }
    // Eaves.
    for (let z = OV - 0.3; z > BACK + 0.2; z -= 0.3 + rand.next() * 0.18) {
      icicle(side * (-EAVE_OUT.x + 0.05), EAVE_OUT.y - 0.05, z, 0.25 + rand.next() ** 2 * 0.85);
    }
  }
  return parts;
}

/** The glass gable's triangle, in the plane z = 0. */
export function glassGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-HW, F, 0, HW, F, 0, 0, F + H, 0]), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
  return g;
}
