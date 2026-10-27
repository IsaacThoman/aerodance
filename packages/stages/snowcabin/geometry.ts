import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Vec3 } from '../catalog.ts';

// Small procedural toolkit: builders return non-indexed geometry with position, normal and a
// linear `color`, so each material's pieces merge into one draw call.

const _c = new THREE.Color();
const _p = new THREE.Vector3();
const _n = new THREE.Vector3();

/** Per-vertex paint: writes the colour for position p / normal n into out. */
export type PaintFn = (p: THREE.Vector3, n: THREE.Vector3, out: THREE.Color) => void;

/** Normalises a geometry for merging (non-indexed, position/normal/color) and paints it. */
export function finalize(geo: THREE.BufferGeometry, paint: THREE.ColorRepresentation | PaintFn = '#ffffff', smooth = false): THREE.BufferGeometry {
  let g = geo;
  if (smooth) {
    g.deleteAttribute('normal');
    g.deleteAttribute('uv');
    g = mergeVertices(g);
  }
  if (!g.attributes.normal || smooth) g.computeVertexNormals();
  if (g.index) g = g.toNonIndexed();
  for (const name of Object.keys(g.attributes)) {
    if (!['position', 'normal', 'color'].includes(name)) g.deleteAttribute(name);
  }
  const pos = g.attributes.position;
  const nrm = g.attributes.normal;
  const colors = new Float32Array(pos.count * 3);
  if (typeof paint !== 'function') _c.set(paint);
  for (let i = 0; i < pos.count; i++) {
    if (typeof paint === 'function') paint(_p.fromBufferAttribute(pos, i), _n.fromBufferAttribute(nrm, i), _c);
    colors.set([_c.r, _c.g, _c.b], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.groups = [];
  return g;
}

export function merge(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(list, false);
  list.forEach((x) => x.dispose());
  g.computeBoundingSphere();
  return g;
}

export interface PlaceOptions {
  position?: Vec3;
  rotation?: Vec3;
  scale?: number | Vec3;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _t = new THREE.Vector3();

/** Applies a transform built from position / euler / scale. */
export function place<G extends THREE.BufferGeometry>(geo: G, { position = [0, 0, 0], rotation = [0, 0, 0], scale = 1 }: PlaceOptions = {}): G {
  _m.compose(_t.set(...position), _q.setFromEuler(_e.set(...rotation)), typeof scale === 'number' ? _s.set(scale, scale, scale) : _s.set(...scale));
  geo.applyMatrix4(_m);
  return geo;
}

/** A box from its min to max corner. */
export function box(min: Vec3, max: Vec3): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  return g.translate((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
}

/** A cylinder (or cone) between two points. */
export function rod(a: Vec3, b: Vec3, radius: number, radiusB = radius, segments = 8): THREE.BufferGeometry {
  const from = new THREE.Vector3(...a);
  const to = new THREE.Vector3(...b);
  const length = from.distanceTo(to);
  const g = new THREE.CylinderGeometry(radiusB, radius, length, segments, 1);
  g.translate(0, length / 2, 0);
  g.applyQuaternion(_q.setFromUnitVectors(_n.set(0, 1, 0), to.clone().sub(from).normalize()));
  return g.translate(...a);
}

/** Lathe from [radius, height] pairs. */
export function lathe(points: ReadonlyArray<readonly [radius: number, height: number]>, segments = 16): THREE.BufferGeometry {
  return new THREE.LatheGeometry(points.map(([x, y]) => new THREE.Vector2(x, y)), segments);
}

/** A smooth sphere squashed by `squash`, its surface pushed in and out by `lumps(direction)`. */
export function blob(radius: number, squash: Vec3 = [1, 1, 1], lumps: (d: THREE.Vector3) => number = () => 0, detail = 3): THREE.BufferGeometry {
  let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, detail);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g = mergeVertices(g);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    _p.fromBufferAttribute(pos, i).normalize();
    const r = radius * (1 + lumps(_p));
    pos.setXYZ(i, _p.x * r * squash[0], _p.y * r * squash[1], _p.z * r * squash[2]);
  }
  g.computeVertexNormals();
  return g;
}

/** An indexed grid of (cols + 1) x (rows + 1) vertices from `at(u, v)`, u and v in 0..1. */
export function sheet(cols: number, rows: number, at: (u: number, v: number, out: THREE.Vector3) => void): THREE.BufferGeometry {
  const positions = new Float32Array((cols + 1) * (rows + 1) * 3);
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      at(c / cols, r / rows, _p);
      _p.toArray(positions, (r * (cols + 1) + c) * 3);
    }
  }
  const index: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = r * (cols + 1) + c;
      const b = a + cols + 1;
      index.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}
