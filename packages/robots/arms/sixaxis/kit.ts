import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { lathe, loft, place, roundedBox } from '../../shared/geometry.ts';
import type { Placement, Section } from '../../shared/geometry.ts';
import type { Vec3 } from '../../../stages/catalog.ts';
import { SWATCHES, swatchUV } from './palette.ts';
import type { SwatchName } from './palette.ts';

// The six-axis arm's own geometry kit, on top of shared/geometry.ts: a collector that bakes a
// link's parts into as few meshes as it can (every finish is a swatch in one atlas, palette.ts),
// lofts and lathes along any axis, and the machinery the arm is made of: servo motors, bolt
// rings, eye bolts, grease nipples, connectors.

/** What a part is made of: a swatch, a printed label (its UVs into the atlas), or hazard stripes. */
export type Mat = SwatchName | 'decal' | 'stripes';

/** A link's baked meshes: painted (with orange peel), bare (metal, rubber, labels), striped. */
export interface Baked {
  painted?: THREE.BufferGeometry;
  palette?: THREE.BufferGeometry;
  stripes?: THREE.BufferGeometry;
}

/** Merges geometries keeping position, normal, uv and uv1, all indexed. */
export function mergeKeep(parts: readonly THREE.BufferGeometry[]): THREE.BufferGeometry {
  const ready = parts.map((part) => {
    const g = part.clone();
    for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'uv1'].includes(name)) g.deleteAttribute(name);
    const count = g.getAttribute('position').count;
    if (!g.index) g.setIndex(Array.from({ length: count }, (_, i) => i));
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2));
    if (!g.getAttribute('uv1')) g.setAttribute('uv1', new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2));
    g.clearGroups();
    return g;
  });
  const merged = mergeGeometries(ready, false);
  ready.forEach((g) => g.dispose());
  if (!merged) throw Error('mergeKeep: the parts would not merge');
  merged.computeBoundingSphere();
  return merged;
}

/** Points a geometry's second UV set at its finish: a swatch's centre, or its own UVs (labels). */
export function finish(geometry: THREE.BufferGeometry, mat: Mat): THREE.BufferGeometry {
  const count = geometry.getAttribute('position').count;
  if (mat === 'decal' || mat === 'stripes') {
    const uv = geometry.getAttribute('uv');
    geometry.setAttribute('uv1', uv ? uv.clone() : new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2));
  } else {
    const [u, v] = swatchUV(mat);
    const data = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      data[i * 2] = u;
      data[i * 2 + 1] = v;
    }
    geometry.setAttribute('uv1', new THREE.Float32BufferAttribute(data, 2));
  }
  return geometry;
}

/** Collects a link's parts by finish, then bakes them (see Baked). */
export class Parts {
  private readonly lists = new Map<Mat, THREE.BufferGeometry[]>();

  add(mat: Mat, geometry: THREE.BufferGeometry, at?: Placement | THREE.Matrix4): this {
    if (at instanceof THREE.Matrix4) geometry.applyMatrix4(at);
    else if (at) place(geometry, at);
    let list = this.lists.get(mat);
    if (!list) this.lists.set(mat, (list = []));
    list.push(geometry);
    return this;
  }

  /** Adds every part of `other`, moved by `at`. */
  include(other: Parts, at?: Placement | THREE.Matrix4): this {
    for (const [mat, list] of other.lists) for (const g of list) this.add(mat, g.clone(), at);
    return this;
  }

  build(): Baked {
    const buckets: Record<keyof Baked, THREE.BufferGeometry[]> = { painted: [], palette: [], stripes: [] };
    for (const [mat, list] of this.lists) {
      const bucket: keyof Baked = mat === 'stripes' ? 'stripes' : mat !== 'decal' && SWATCHES[mat].painted ? 'painted' : 'palette';
      for (const g of list) buckets[bucket].push(finish(g, mat));
    }
    const out: Baked = {};
    for (const key of Object.keys(buckets) as (keyof Baked)[]) {
      if (buckets[key].length) out[key] = mergeKeep(buckets[key]);
    }
    for (const list of this.lists.values()) list.forEach((g) => g.dispose());
    this.lists.clear();
    return out;
  }
}

export const toX: Vec3 = [0, 0, -Math.PI / 2];
export const toNegX: Vec3 = [0, 0, Math.PI / 2];
export const toZ: Vec3 = [Math.PI / 2, 0, 0];
export const toNegZ: Vec3 = [-Math.PI / 2, 0, 0];
export const toNegY: Vec3 = [Math.PI, 0, 0];

export type Axis = 'x' | 'y' | 'z' | '-x' | '-y' | '-z';
export function axisRotation(axis: Axis): Vec3 {
  return ({ x: toX, '-x': toNegX, y: [0, 0, 0], '-y': toNegY, z: toZ, '-z': toNegZ } as const)[axis];
}

/** A section of a loft along X: `h` tall (y) and `d` deep (z), centred at (y, z). */
export interface SectionX { x: number; h: number; d: number; r: number; y?: number; z?: number }
/** A section of a loft along Z: `w` wide (x) and `h` tall (y), centred at (x, y). */
export interface SectionZ { z: number; w: number; h: number; r: number; x?: number; y?: number }

/** A housing lofted along +X (rounded-rectangle sections). */
export function loftX(sections: readonly SectionX[], corner = 6): THREE.BufferGeometry {
  // Built along Y, then turned Y → X: a section's own x becomes -y.
  const s: Section[] = sections.map((c) => ({ y: c.x, w: c.h, d: c.d, r: c.r, x: -(c.y ?? 0), z: c.z ?? 0 }));
  return place(loft(s, corner), { rotation: toX });
}

/** A housing lofted along +Z. */
export function loftZ(sections: readonly SectionZ[], corner = 6): THREE.BufferGeometry {
  // Built along Y, then turned Y → Z: a section's own z becomes -y.
  const s: Section[] = sections.map((c) => ({ y: c.z, w: c.w, d: c.h, r: c.r, x: c.x ?? 0, z: -(c.y ?? 0) }));
  return place(loft(s, corner), { rotation: toZ });
}

/** A turned part along +X: `profile` is [radius, x]. */
export function latheX(profile: readonly (readonly [number, number])[], segments = 40): THREE.BufferGeometry {
  return place(lathe(profile, segments), { rotation: toX });
}

/** A turned part along +Z: `profile` is [radius, z]. */
export function latheZ(profile: readonly (readonly [number, number])[], segments = 40): THREE.BufferGeometry {
  return place(lathe(profile, segments), { rotation: toZ });
}

/** A closed cylinder along +Y, chamfered, centred: a cheaper chamferCylinder for small parts. */
export function puck(radius: number, height: number, chamfer = 0.001, segments = 10): THREE.BufferGeometry {
  const c = Math.min(chamfer, radius / 2, height / 2);
  const h = height / 2;
  return lathe([[0, -h], [radius, -h], [radius, h - c], [radius - c, h], [0, h]], segments);
}

/** A socket-head cap screw's head standing on a face along +Y. */
function screwHead(size: number): THREE.BufferGeometry {
  const r = size / 2;
  const h = size * 0.62;
  return lathe([[0, 0], [r, 0], [r, h * 0.82], [r * 0.82, h], [r * 0.45, h], [r * 0.45, h * 0.8], [0, h * 0.8]], 10);
}

/** A ring of socket-head screws on a face, pointing along `axis`. */
export function bolts(count: number, radius: number, size: number, at: Placement & { axis?: Axis } = {}, start = 0): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < count; i++) {
    const a = start + (i / count) * Math.PI * 2;
    parts.push(screwHead(size).translate(Math.cos(a) * radius, 0, Math.sin(a) * radius));
  }
  const g = mergeKeep(parts);
  parts.forEach((p) => p.dispose());
  place(g, { rotation: axisRotation(at.axis ?? 'y') });
  return place(g, at);
}

/** One socket-head screw on a face along `axis`, at `position`. */
export function screw(size: number, axis: Axis, position: Vec3): THREE.BufferGeometry {
  return place(place(screwHead(size), { rotation: axisRotation(axis) }), { position });
}

/** A plain disc or short cylinder along an axis, centred at `position`. */
export function disc(radius: number, thickness: number, axis: Axis, position: Vec3, chamfer = 0.002, segments = 32): THREE.BufferGeometry {
  return place(puck(radius, thickness, chamfer, segments), { rotation: axisRotation(axis), position });
}

/** A rounded box. */
export function box(w: number, h: number, d: number, r: number, position: Vec3, rotation: Vec3 = [0, 0, 0], segments = 1): THREE.BufferGeometry {
  return roundedBox(w, h, d, r, segments, { position, rotation });
}

/** A sharp-edged box (12 triangles). */
export function block(w: number, h: number, d: number, position: Vec3, rotation: Vec3 = [0, 0, 0]): THREE.BufferGeometry {
  return place(new THREE.BoxGeometry(w, h, d), { position, rotation });
}

export interface MotorOptions {
  /** Across the square body. */
  size: number;
  length: number;
  /** Where the connector box sits round the body (radians about the motor's axis, 0 = +X side). */
  box?: number;
  ribs?: number;
}

/**
 * A servo motor along +Y from its mounting face (y = 0) to its encoder cap: a square mounting
 * flange with four screws, a rounded-square body with cooling ribs, the encoder cap with a trim
 * ring, and a connector box with its power and signal plugs.
 */
export function motor({ size, length, box: boxAngle = 0, ribs = 4 }: MotorOptions): Parts {
  const p = new Parts();
  const s = size;
  const flange = 0.14 * length;
  p.add('black', loft([
    { y: 0, w: s * 1.08, d: s * 1.08, r: s * 0.14 },
    { y: flange, w: s * 1.08, d: s * 1.08, r: s * 0.14 },
  ], 2));
  for (const [x, z] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) p.add('oxide', screw(s * 0.11, 'y', [x * s * 0.4, flange, z * s * 0.4]));
  const bodyEnd = length * 0.84;
  const sections: Section[] = [{ y: flange, w: s * 0.96, d: s * 0.96, r: s * 0.3 }];
  for (let i = 0; i < ribs; i++) {
    const y = flange + ((i + 1) / (ribs + 1)) * (bodyEnd - flange);
    sections.push(
      { y: y - s * 0.03, w: s * 0.95, d: s * 0.95, r: s * 0.3 },
      { y: y - s * 0.016, w: s * 1.02, d: s * 1.02, r: s * 0.32 },
      { y: y + s * 0.016, w: s * 1.02, d: s * 1.02, r: s * 0.32 },
      { y: y + s * 0.03, w: s * 0.95, d: s * 0.95, r: s * 0.3 },
    );
  }
  sections.push({ y: bodyEnd, w: s * 0.93, d: s * 0.93, r: s * 0.3 });
  p.add('black', loft(sections, 3));
  p.add('graphite', lathe([[0, bodyEnd], [s * 0.42, bodyEnd], [s * 0.42, length - s * 0.08], [s * 0.36, length - s * 0.02], [s * 0.2, length], [0, length]], 24));
  p.add('alu', lathe([[s * 0.435, bodyEnd + s * 0.01], [s * 0.435, bodyEnd + s * 0.04], [s * 0.42, bodyEnd + s * 0.05]], 24));
  // The connector box on the side, two angled plugs on it.
  const bx = new Parts();
  const bl = length * 0.36;
  bx.add('black', roundedBox(s * 0.34, bl, s * 0.5, s * 0.05, 1, { position: [s * 0.62, flange + length * 0.42, 0] }));
  bx.add('alu', lathe([[0, 0], [s * 0.11, 0], [s * 0.11, s * 0.16], [s * 0.095, s * 0.2], [0, s * 0.2]], 12), { position: [s * 0.78, flange + length * 0.36, -s * 0.11], rotation: [0, 0, -Math.PI / 3] });
  bx.add('alu', lathe([[0, 0], [s * 0.08, 0], [s * 0.08, s * 0.14], [s * 0.07, s * 0.17], [0, s * 0.17]], 12), { position: [s * 0.78, flange + length * 0.5, s * 0.12], rotation: [0, 0, -Math.PI / 3] });
  bx.add('black', lathe([[0, 0], [s * 0.1, 0], [s * 0.1, s * 0.22], [s * 0.06, s * 0.3], [0, s * 0.3]], 10), { position: [s * 0.86, flange + length * 0.31, -s * 0.11], rotation: [0, 0, -Math.PI / 3] });
  p.include(bx, { rotation: [0, boxAngle, 0] });
  return p;
}

/** An eye bolt standing on a face along +Y: collar, ring. */
export function eyeBolt(size: number): THREE.BufferGeometry {
  const collar = puck(size * 0.55, size * 0.25, size * 0.05, 14).translate(0, size * 0.125, 0);
  const neck = puck(size * 0.22, size * 0.25, 0.001, 8).translate(0, size * 0.36, 0);
  const ring = new THREE.TorusGeometry(size * 0.5, size * 0.16, 8, 20).translate(0, size * 0.95, 0);
  const g = mergeKeep([collar, neck, ring]);
  [collar, neck, ring].forEach((x) => x.dispose());
  return g;
}

/** A grease nipple along +Y: hex body, neck, ball head. */
export function greaseNipple(size = 0.012): THREE.BufferGeometry {
  const hex = new THREE.CylinderGeometry(size * 0.5, size * 0.5, size * 0.45, 6).translate(0, size * 0.225, 0);
  const neck = lathe([[size * 0.18, size * 0.45], [size * 0.18, size * 0.75], [size * 0.32, size * 0.82], [size * 0.32, size * 0.98], [size * 0.2, size * 1.1], [0, size * 1.12]], 8);
  const g = mergeKeep([hex, neck]);
  hex.dispose();
  neck.dispose();
  return g;
}

/** A hex bolt head with a washer, along +Y. */
export function hexBolt(size: number): THREE.BufferGeometry {
  const washer = puck(size * 0.95, size * 0.12, size * 0.03, 12).translate(0, size * 0.06, 0);
  const head = new THREE.CylinderGeometry(size * 0.58, size * 0.58, size * 0.5, 6).translate(0, size * 0.37, 0);
  const g = mergeKeep([washer, head]);
  washer.dispose();
  head.dispose();
  return g;
}

/**
 * A heavy-duty rectangular connector on a face along +Y: the base housing, the hood, a locking
 * lever each side and the cable gland on top.
 */
export function heavyConnector(w: number): Parts {
  const p = new Parts();
  p.add('graphite', roundedBox(w, w * 0.25, w * 0.55, w * 0.04, 1, { position: [0, w * 0.125, 0] }));
  p.add('black', loft([
    { y: w * 0.25, w: w * 0.92, d: w * 0.5, r: w * 0.08 },
    { y: w * 0.7, w: w * 0.86, d: w * 0.46, r: w * 0.1 },
    { y: w * 0.82, w: w * 0.5, d: w * 0.36, r: w * 0.12 },
  ], 3));
  p.add('black', lathe([[w * 0.16, w * 0.82], [w * 0.15, w * 1.1], [w * 0.12, w * 1.16], [0, w * 1.16]], 12));
  for (const s of [1, -1]) p.add('alu', roundedBox(w * 0.06, w * 0.42, w * 0.3, w * 0.02, 1, { position: [s * w * 0.49, w * 0.42, 0], rotation: [0, 0, s * 0.12] }));
  return p;
}
