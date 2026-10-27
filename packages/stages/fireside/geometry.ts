import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Vec3 } from '../catalog.ts';

// A small kit for the cabin's furnishings: pieces are painted with vertex colours and merged,
// so a whole room of props draws in a handful of calls.

const _c = new THREE.Color();
const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _t = new THREE.Vector3();

/** Per-vertex paint: writes the colour for position p and normal n into out. */
export type Paint = THREE.ColorRepresentation | ((p: THREE.Vector3, n: THREE.Vector3, out: THREE.Color) => void);

/** Non-indexed, with position, normal and (linear) colour only (and uv, given `uv`), ready to merge. */
export function paint(geo: THREE.BufferGeometry, color: Paint, { smooth = false, uv = false } = {}): THREE.BufferGeometry {
  let g = geo;
  if (smooth) {
    g.deleteAttribute('normal');
    g.deleteAttribute('uv');
    g = mergeVertices(g);
    g.computeVertexNormals();
  }
  if (g.index) g = g.toNonIndexed();
  if (!g.attributes.normal) g.computeVertexNormals();
  for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && !(uv && name === 'uv')) g.deleteAttribute(name);
  const pos = g.attributes.position;
  const nrm = g.attributes.normal;
  const colors = new Float32Array(pos.count * 3);
  if (typeof color !== 'function') _c.set(color);
  for (let i = 0; i < pos.count; i++) {
    if (typeof color === 'function') color(_p.fromBufferAttribute(pos, i), _n.fromBufferAttribute(nrm, i), _c);
    colors.set([_c.r, _c.g, _c.b], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.groups = [];
  if (g !== geo) geo.dispose();
  return g;
}

export interface Placement {
  position?: Vec3;
  rotation?: Vec3;
  scale?: number | Vec3;
}

/** Moves, turns and scales a geometry in place. */
export function place<G extends THREE.BufferGeometry>(geo: G, { position = [0, 0, 0], rotation = [0, 0, 0], scale = 1 }: Placement): G {
  _m.compose(_t.set(...position), _q.setFromEuler(_e.set(...rotation)), typeof scale === 'number' ? _s.set(scale, scale, scale) : _s.set(...scale));
  return geo.applyMatrix4(_m);
}

/** Merges painted pieces into one geometry and disposes of them. */
export function merge(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(list, false);
  list.forEach((piece) => piece.dispose());
  g.computeBoundingSphere();
  return g;
}

/** A box with softly rounded edges (a squashed, subdivided cube pushed out to a superellipsoid). */
export function softBox(w: number, h: number, d: number, round = 0.15, segments = 6): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, 1, 1, segments, segments, segments);
  const pos = g.attributes.position;
  const r = Math.min(round, w / 2, h / 2, d / 2);
  const inner = new THREE.Vector3(w / 2 - r, h / 2 - r, d / 2 - r);
  for (let i = 0; i < pos.count; i++) {
    _p.fromBufferAttribute(pos, i).multiply(_s.set(w, h, d));
    // Round each corner about the inner box's nearest point.
    _t.set(THREE.MathUtils.clamp(_p.x, -inner.x, inner.x), THREE.MathUtils.clamp(_p.y, -inner.y, inner.y), THREE.MathUtils.clamp(_p.z, -inner.z, inner.z));
    _n.subVectors(_p, _t);
    if (_n.lengthSq() > 1e-8) _p.copy(_t).addScaledVector(_n.normalize(), r);
    pos.setXYZ(i, _p.x, _p.y, _p.z);
  }
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  const merged = mergeVertices(g);
  g.dispose();
  merged.computeVertexNormals();
  return merged;
}

/** A beam of square section from a to b. */
export function beam(a: Vec3, b: Vec3, width: number, depth = width, up: Vec3 = [0, 1, 0]): THREE.BufferGeometry {
  const from = new THREE.Vector3(...a);
  const to = new THREE.Vector3(...b);
  const length = from.distanceTo(to);
  const g = new THREE.BoxGeometry(width, depth, length);
  // lookAt only sets the rotation: clear what place() left in the shared matrix first.
  _m.identity().lookAt(to, from, _t.set(...up));
  g.applyMatrix4(_m);
  return g.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
}

/** A round rod of `radius` from a to b. */
export function rod(a: Vec3, b: Vec3, radius: number, radial = 8, tip = radius): THREE.BufferGeometry {
  const from = new THREE.Vector3(...a);
  const dir = new THREE.Vector3(...b).sub(from);
  const g = new THREE.CylinderGeometry(tip, radius, dir.length(), radial, 1).translate(0, dir.length() / 2, 0);
  g.applyQuaternion(_q.setFromUnitVectors(_n.set(0, 1, 0), dir.normalize()));
  return g.translate(...a);
}

/** A lathe from [radius, height] pairs. */
export function lathe(points: ReadonlyArray<readonly [radius: number, height: number]>, segments = 24): THREE.BufferGeometry {
  return new THREE.LatheGeometry(points.map(([x, y]) => new THREE.Vector2(x, y)), segments);
}
