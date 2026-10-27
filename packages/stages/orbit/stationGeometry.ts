import * as THREE from 'three';
import { HABITAT, SPINE, WING_NODE_Z, WINGS } from './layout.ts';
import { Parts, place, strut } from './geometry.ts';

// The station's geometry, by material and by what moves. All in world space: the spine runs
// from under the deck back along +z; the wing trusses rise from a node on it in a V to the arms
// that carry the wings; the habitat ring turns about the spine near its end.

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const WHITE = '#f4f8fc';
const PALE = '#dce8f2';
const BAND = '#b9d6ea';

/** The node where the wing trusses meet the spine, and where each truss reaches its arm. */
export const WING_NODE = v3(0, SPINE.y, WING_NODE_Z);
export const armRoot = (side: 1 | -1) => v3(side * (WINGS.x[0] - 1.2), WINGS.y, WING_NODE_Z);
/** Each wing's mast (it turns about this line, along z): x for the inner and outer wing. */
export const WING_MASTS: readonly number[] = [WINGS.x[0] + (WINGS.x[1] - WINGS.x[0]) * 0.22, WINGS.x[0] + (WINGS.x[1] - WINGS.x[0]) * 0.78];
/** A wing's two blankets each side of its mast: their width, and the gap at the mast. */
const BLANKET = { width: 3.1, gap: 0.35 };

/**
 * A square box truss from a to b: four longerons and a zigzag brace on each face, `width` across
 * and about `bay` long per bay.
 */
function truss(parts: Parts, a: THREE.Vector3, b: THREE.Vector3, width: number, bay: number, paint = WHITE) {
  const axis = new THREE.Vector3().subVectors(b, a);
  const len = axis.length();
  axis.normalize();
  const side = new THREE.Vector3().crossVectors(axis, Math.abs(axis.y) > 0.9 ? v3(1, 0, 0) : v3(0, 1, 0)).normalize();
  const up = new THREE.Vector3().crossVectors(side, axis).normalize();
  const h = width / 2;
  const corners = [
    [1, 1],
    [1, -1],
    [-1, -1],
    [-1, 1],
  ].map(([s, u]) => side.clone().multiplyScalar(s * h).addScaledVector(up, u * h));
  for (const c of corners) parts.add(strut(a.clone().add(c), b.clone().add(c), width * 0.07, 6), paint);
  const bays = Math.max(1, Math.round(len / bay));
  for (let i = 0; i < bays; i++) {
    const p0 = a.clone().addScaledVector(axis, (len * i) / bays);
    const p1 = a.clone().addScaledVector(axis, (len * (i + 1)) / bays);
    for (let k = 0; k < 4; k++) {
      const c0 = corners[k];
      const c1 = corners[(k + 1) % 4];
      // Alternate the diagonals' direction from bay to bay.
      const [from, to] = i % 2 ? [c0, c1] : [c1, c0];
      parts.add(strut(p0.clone().add(from), p1.clone().add(to), width * 0.04, 4), paint);
    }
  }
}

/** A capsule module along z, from z0 to z1, with a pale band and end rings. */
function addModule(parts: Parts, z0: number, z1: number, radius: number, y = SPINE.y) {
  const len = z1 - z0 - radius * 2;
  parts.add(place(new THREE.CapsuleGeometry(radius, Math.max(0.01, len), 8, 32), [0, y, (z0 + z1) / 2], [Math.PI / 2, 0, 0]), (p, _n, out) => {
    // A pale band round the middle, where its windows are.
    const t = Math.abs(p.z - (z0 + z1) / 2) / (len / 2 + 0.001);
    out.set(t < 0.28 ? BAND : WHITE);
  });
  for (const z of [z0 + radius * 0.6, z1 - radius * 0.6]) parts.add(place(new THREE.TorusGeometry(radius * 1.02, radius * 0.07, 6, 40), [0, y, z]), PALE);
}

/** The static white structure: spine, modules, node, V trusses, wing arms, hub, docking port. */
export function makeFrameGeometry(): THREE.BufferGeometry {
  const parts = new Parts();
  const end = SPINE.length;
  // The spine leaves the deck's hull and runs back to the docking port.
  truss(parts, v3(0, SPINE.y, 2.2), v3(0, SPINE.y, end), 1.3, 2.6);
  // A neck from the hull into the spine.
  parts.add(strut(v3(0, SPINE.y, -0.5), v3(0, SPINE.y, 3.6), 0.9, 20, 0.75), WHITE);
  addModule(parts, 6.5, 15, 1.45);
  addModule(parts, 26, 33, 1.25);
  // The node where the wing trusses leave: across under the deck's level, then up at the sides
  // (so seen from behind the dancers they stand clear either side of them) to the arms.
  parts.add(place(new THREE.SphereGeometry(1.75, 32, 18), WING_NODE.toArray()), WHITE);
  for (const s of [1, -1] as const) {
    const root = armRoot(s);
    const foot = v3(root.x, SPINE.y, WING_NODE_Z);
    truss(parts, WING_NODE.clone().add(v3(s * 1.4, 0, 0)), foot, 1.1, 2.3);
    parts.add(place(new THREE.SphereGeometry(0.95, 20, 12), foot.toArray()), WHITE);
    truss(parts, foot, root, 1.0, 2.2);
    parts.add(place(new THREE.SphereGeometry(0.85, 20, 12), root.toArray()), WHITE);
    // The arm across the wings' masts, with a joint at each.
    truss(parts, root, v3(s * (WINGS.x[1] + 1.5), WINGS.y, WING_NODE_Z), 0.9, 2.0);
    for (const x of WING_MASTS) parts.add(place(new THREE.CylinderGeometry(0.62, 0.62, 1.6, 20), [s * x, WINGS.y, WING_NODE_Z], [Math.PI / 2, 0, 0]), PALE);
  }
  // The habitat ring's hub (its bearing; the spokes turn round it).
  parts.add(place(new THREE.CylinderGeometry(1.5, 1.5, 3.4, 32), [0, SPINE.y, HABITAT.z], [Math.PI / 2, 0, 0]), PALE);
  for (const dz of [-1.8, 1.8]) parts.add(place(new THREE.TorusGeometry(1.5, 0.16, 8, 32), [0, SPINE.y, HABITAT.z + dz]), WHITE);
  // The docking port: a tapering adapter, a flange and a collar.
  parts.add(place(new THREE.CylinderGeometry(0.95, 1.4, 2.4, 28), [0, SPINE.y, end + 1.2], [Math.PI / 2, 0, 0]), WHITE);
  parts.add(place(new THREE.TorusGeometry(1.05, 0.18, 10, 32), [0, SPINE.y, end + 2.45]), PALE);
  parts.add(place(new THREE.CylinderGeometry(0.75, 0.75, 0.5, 24, 1, true), [0, SPINE.y, end + 2.7], [Math.PI / 2, 0, 0]), BAND);
  return parts.build();
}

/** One wing's mast (white) from z0 to z1, at the origin along z: wings are instanced and turned about it. */
export function makeMastGeometry(z0: number, z1: number = WINGS.z[1]): THREE.BufferGeometry {
  const parts = new Parts();
  parts.add(strut(v3(0, 0, z0 - 0.4), v3(0, 0, z1 + 0.4), 0.13, 8), WHITE);
  for (const z of [z0 - 0.4, z1 + 0.4]) parts.add(place(new THREE.BoxGeometry(BLANKET.width * 2 + BLANKET.gap * 2, 0.12, 0.3), [0, 0, z]), WHITE);
  return parts.build();
}

/**
 * One wing's four solar blankets, either side of its mast and fore and aft of the arm, in the
 * mast's frame (x across, z along). uv runs 0..1 across and along each blanket.
 */
export function makeBlanketGeometry(z0: number, z1: number = WINGS.z[1]): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const quad = (xa: number, xb: number, za: number, zb: number) => {
    const b = pos.length / 3;
    pos.push(xa, 0, za, xb, 0, za, xb, 0, zb, xa, 0, zb);
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
  };
  const { width, gap } = BLANKET;
  for (const [za, zb] of [
    [z0, WING_NODE_Z - 1.1],
    [WING_NODE_Z + 1.1, z1],
  ]) {
    quad(gap, gap + width, za, zb);
    quad(-gap - width, -gap, za, zb);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** The turning part of the habitat ring that is white: spokes and the rims either side of the glass. */
export function makeRingFrameGeometry(): THREE.BufferGeometry {
  const parts = new Parts();
  const { radius, tube } = HABITAT;
  const spokes = 6;
  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * Math.PI * 2;
    const dir = v3(Math.cos(a), Math.sin(a), 0);
    parts.add(strut(dir.clone().multiplyScalar(1.5), dir.clone().multiplyScalar(radius - tube * 0.85), 0.22, 10), WHITE);
    // A little lift car on every other spoke.
    if (i % 2 === 0) parts.add(place(new THREE.CapsuleGeometry(0.34, 0.6, 4, 12), dir.clone().multiplyScalar(radius * 0.55).toArray(), [0, 0, a - Math.PI / 2]), PALE);
  }
  for (const dz of [-tube * 0.92, tube * 0.92]) parts.add(place(new THREE.TorusGeometry(radius, 0.2, 8, 160), [0, 0, dz]), WHITE);
  // The habitat's floor inside the glass, seen through it.
  parts.add(new THREE.CylinderGeometry(radius + tube * 0.55, radius + tube * 0.55, tube * 1.5, 160, 1, true).rotateX(Math.PI / 2), BAND);
  return parts.build();
}

/** The ring's glass tube (turning with the frame). */
export const makeRingGlassGeometry = (): THREE.BufferGeometry => new THREE.TorusGeometry(HABITAT.radius, HABITAT.tube, 24, 160);

/** The navigation lights: [x, y, z], colour (HDR), blink phase. */
export function navLights(): { position: THREE.Vector3; color: THREE.Vector3; phase: number }[] {
  const red = v3(3, 0.25, 0.2);
  const green = v3(0.3, 3, 0.6);
  const white = v3(2.6, 2.8, 3);
  const z1 = WINGS.z[1];
  const { left, right } = WINGS.fore;
  const tip = WINGS.x[1] + BLANKET.width * 0.2;
  return [
    { position: v3(-tip, WINGS.y, left - 0.5), color: red, phase: 0 },
    { position: v3(tip, WINGS.y, right - 0.5), color: green, phase: 0.5 },
    { position: v3(-tip, WINGS.y, z1 + 0.5), color: red, phase: 0.25 },
    { position: v3(tip, WINGS.y, z1 + 0.5), color: green, phase: 0.75 },
    { position: v3(0, SPINE.y + 1.85, WING_NODE_Z), color: white, phase: 0.1 },
    { position: v3(0, SPINE.y, SPINE.length + 3), color: white, phase: 0.6 },
    { position: v3(0, SPINE.y + 1.6, HABITAT.z), color: green, phase: 0.35 },
  ];
}
