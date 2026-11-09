import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Vec3 } from '../../stages/catalog.ts';

// Geometry helpers for machinery: rounded and chamfered solids, turned parts, lofted housings,
// bolt circles and tubes, and `merge` to bake many parts that share a material into one mesh
// (one draw call). Everything is in metres; build a link's parts in the link's own frame.

export interface Placement {
  position?: Vec3;
  /** Euler XYZ, radians. */
  rotation?: Vec3;
  scale?: Vec3 | number;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

/** Moves a geometry (in place, and returns it). */
export function place<T extends THREE.BufferGeometry>(geometry: T, { position = [0, 0, 0], rotation = [0, 0, 0], scale = 1 }: Placement): T {
  _q.setFromEuler(_e.set(rotation[0], rotation[1], rotation[2]));
  _s.set(...(typeof scale === 'number' ? [scale, scale, scale] as const : scale));
  geometry.applyMatrix4(_m.compose(_p.set(...position), _q, _s));
  return geometry;
}

/**
 * One geometry from many, for a single draw call: keeps position, normal and uv (making zero
 * UVs where a part has none) and drops the rest, so any three geometries merge.
 */
export function merge(parts: readonly THREE.BufferGeometry[]): THREE.BufferGeometry {
  const ready = parts.map((part) => {
    const g = part.index ? part.toNonIndexed() : part.clone();
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
    g.clearGroups();
    return g;
  });
  const merged = mergeGeometries(ready, false);
  ready.forEach((g) => g.dispose());
  if (!merged) throw Error('merge: the parts would not merge');
  merged.computeBoundingSphere();
  return merged;
}

/** A box with rounded edges and corners (`radius`), centred on the origin. */
export function roundedBox(w: number, h: number, d: number, radius: number, segments = 3, at?: Placement): THREE.BufferGeometry {
  const g = new RoundedBoxGeometry(w, h, d, segments, Math.min(radius, w / 2, h / 2, d / 2) - 1e-5);
  return at ? place(g, at) : g;
}

/**
 * A turned part: `profile` is [radius, y] from bottom to top, revolved about +Y. Put a point
 * at radius 0 at either end to close it. `segments` round the axis.
 */
export function lathe(profile: readonly (readonly [number, number])[], segments = 48, at?: Placement): THREE.BufferGeometry {
  const g = new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(Math.max(r, 0), y)), segments);
  return at ? place(g, at) : g;
}

/** A closed cylinder along +Y with its edges chamfered by `chamfer`, centred on the origin. */
export function chamferCylinder(radius: number, height: number, chamfer = 0.004, segments = 40, at?: Placement): THREE.BufferGeometry {
  const c = Math.min(chamfer, radius / 2, height / 2);
  const h = height / 2;
  return lathe([[0, -h], [radius - c, -h], [radius, -h + c], [radius, h - c], [radius - c, h], [0, h]], segments, at);
}

/** A section of a lofted housing: a rounded rectangle `w` wide (x) and `d` deep (z) at height `y`. */
export interface Section {
  y: number;
  w: number;
  d: number;
  /** Corner radius (clamped to the section). */
  r: number;
  /** Offsets of the section's centre. */
  x?: number;
  z?: number;
}

/**
 * A housing lofted through rounded-rectangle sections along Y, capped at both ends: a
 * tapering arm link, a handle, a column. Smooth sides, `corner` segments to each corner.
 *
 *   loft([{ y: 0, w: 0.3, d: 0.25, r: 0.08 }, { y: 0.9, w: 0.2, d: 0.18, r: 0.06 }])
 */
export function loft(given: readonly Section[], corner = 6, at?: Placement): THREE.BufferGeometry {
  // Bottom to top, whichever way they came.
  const sections = given[0].y <= given[given.length - 1].y ? given : [...given].reverse();
  const ring = (s: Section): [number, number][] => {
    const r = Math.min(s.r, s.w / 2 - 1e-5, s.d / 2 - 1e-5);
    const hx = s.w / 2 - r;
    const hz = s.d / 2 - r;
    const out: [number, number][] = [];
    const centres: [number, number, number][] = [[hx, hz, 0], [-hx, hz, Math.PI / 2], [-hx, -hz, Math.PI], [hx, -hz, (3 * Math.PI) / 2]];
    for (const [cx, cz, start] of centres) {
      for (let i = 0; i <= corner; i++) {
        const a = start + (i / corner) * (Math.PI / 2);
        out.push([(s.x ?? 0) + cx + Math.cos(a) * r, (s.z ?? 0) + cz + Math.sin(a) * r]);
      }
    }
    return out;
  };
  const rings = sections.map(ring);
  const n = rings[0].length;
  const positions: number[] = [];
  const uvs: number[] = [];
  const index: number[] = [];
  // The sides: rings of vertices, U round, V up.
  rings.forEach((points, j) => {
    points.forEach(([x, z], i) => {
      positions.push(x, sections[j].y, z);
      uvs.push(i / (n - 1), j / (rings.length - 1));
    });
  });
  for (let j = 0; j < rings.length - 1; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * n + i;
      const b = j * n + ((i + 1) % n);
      const c = (j + 1) * n + i;
      const d = (j + 1) * n + ((i + 1) % n);
      index.push(a, c, b, b, c, d);
    }
  }
  const sides = new THREE.BufferGeometry();
  sides.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  sides.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  sides.setIndex(index);
  sides.computeVertexNormals();
  // Flat caps, from the end rings. ShapeGeometry lies in XY facing +Z: turned down onto XZ it
  // faces up with its y as -z, or turned up it faces down with its y as z.
  const cap = (j: number, up: boolean) => {
    const shape = new THREE.Shape(rings[j].map(([x, z]) => new THREE.Vector2(x, up ? -z : z)));
    const g = new THREE.ShapeGeometry(shape, 1);
    g.rotateX(up ? -Math.PI / 2 : Math.PI / 2);
    g.translate(0, sections[j].y, 0);
    return g;
  };
  const merged = merge([sides, cap(0, false), cap(rings.length - 1, true)]);
  sides.dispose();
  return at ? place(merged, at) : merged;
}

/** A shape (in XY) extruded `depth` along +Z, centred on z = 0, with rounded edges `bevel`. */
export function extrude(shape: THREE.Shape, depth: number, bevel = 0.004, curveSegments = 24, at?: Placement): THREE.BufferGeometry {
  const b = Math.min(bevel, depth / 2 - 1e-5);
  const g = new THREE.ExtrudeGeometry(shape, { depth: depth - 2 * b, bevelEnabled: b > 0, bevelThickness: b, bevelSize: b, bevelSegments: 3, curveSegments });
  g.translate(0, 0, -(depth - 2 * b) / 2);
  return at ? place(g, at) : g;
}

/** A rounded-rectangle Shape, `w` by `h`, centred, with corner radius `r` (for extrude). */
export function roundedRectShape(w: number, h: number, r: number): THREE.Shape {
  const x = -w / 2;
  const y = -h / 2;
  const rr = Math.min(r, w / 2, h / 2);
  const s = new THREE.Shape();
  s.moveTo(x + rr, y);
  s.lineTo(x + w - rr, y);
  s.quadraticCurveTo(x + w, y, x + w, y + rr);
  s.lineTo(x + w, y + h - rr);
  s.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  s.lineTo(x + rr, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - rr);
  s.lineTo(x, y + rr);
  s.quadraticCurveTo(x, y, x + rr, y);
  return s;
}

/**
 * A ring of bolt heads standing on the XZ plane, pointing +Y: `count` of them at `radius`
 * round the origin. Socket caps (round) or hex heads, `size` across.
 */
export function boltCircle(count: number, radius: number, { size = 0.012, height = size * 0.7, hex = false, start = 0 }: { size?: number; height?: number; hex?: boolean; start?: number } = {}): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < count; i++) {
    const a = start + (i / count) * Math.PI * 2;
    const head = hex ? new THREE.CylinderGeometry(size / 2, size / 2, height, 6) : chamferCylinder(size / 2, height, height * 0.18, 14);
    head.translate(Math.cos(a) * radius, height / 2, Math.sin(a) * radius);
    parts.push(head);
  }
  const g = merge(parts);
  parts.forEach((p) => p.dispose());
  return g;
}

/** A tube through `points` (a smooth curve), `radius` thick. */
export function tube(points: readonly Vec3[], radius: number, segments = 48, radial = 12, closed = false): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)), closed, 'centripetal');
  return new THREE.TubeGeometry(curve, segments, radius, radial, closed);
}
