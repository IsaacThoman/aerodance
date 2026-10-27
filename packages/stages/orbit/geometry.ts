import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Vec3 } from '../catalog.ts';

// A small toolkit for the deck, station and dome: parts are placed, painted with a vertex colour
// and merged into one buffer per material, so the whole structure draws in a few calls.

/** Paint for a part: a colour, or one worked out per vertex from its position and normal. */
export type Paint = THREE.ColorRepresentation | ((p: THREE.Vector3, n: THREE.Vector3, out: THREE.Color) => void);

const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _c = new THREE.Color();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _t = new THREE.Vector3();

/** Moves, turns (Euler XYZ) and scales a geometry in place. */
export function place<G extends THREE.BufferGeometry>(geo: G, position: Vec3 = [0, 0, 0], rotation: Vec3 = [0, 0, 0], scale: number | Vec3 = 1): G {
  _m.compose(_t.set(...position), _q.setFromEuler(_e.set(...rotation)), typeof scale === 'number' ? _s.setScalar(scale) : _s.set(...scale));
  return geo.applyMatrix4(_m);
}

/** A cylinder from a to b (for struts, spokes and truss members). */
export function strut(a: THREE.Vector3, b: THREE.Vector3, radius: number, sides = 6, radiusB = radius): THREE.BufferGeometry {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(radiusB, radius, len, sides, 1, true);
  _q.setFromUnitVectors(_n.set(0, 1, 0), _p.subVectors(b, a).normalize());
  _m.compose(_t.addVectors(a, b).multiplyScalar(0.5), _q, _s.setScalar(1));
  return g.applyMatrix4(_m);
}

/** A lathe from [radius, height] pairs, turned about y. */
export function lathe(points: ReadonlyArray<readonly [radius: number, height: number]>, segments = 48): THREE.BufferGeometry {
  return new THREE.LatheGeometry(points.map(([r, y]) => new THREE.Vector2(r, y)), segments);
}

/**
 * Collects parts for one material: each is made non-indexed with only position, normal and
 * colour (linear), then all are merged into one geometry by build().
 */
export class Parts {
  private list: THREE.BufferGeometry[] = [];

  add(geo: THREE.BufferGeometry, paint: Paint = '#ffffff'): this {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    if (!g.attributes.normal) g.computeVertexNormals();
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    const pos = g.attributes.position;
    const nrm = g.attributes.normal;
    const colors = new Float32Array(pos.count * 3);
    if (typeof paint !== 'function') _c.set(paint);
    for (let i = 0; i < pos.count; i++) {
      if (typeof paint === 'function') paint(_p.fromBufferAttribute(pos, i), _n.fromBufferAttribute(nrm, i), _c);
      colors[i * 3] = _c.r;
      colors[i * 3 + 1] = _c.g;
      colors[i * 3 + 2] = _c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g.groups = [];
    this.list.push(g);
    return this;
  }

  build(): THREE.BufferGeometry {
    const merged = mergeGeometries(this.list, false);
    this.list.forEach((g) => g.dispose());
    this.list = [];
    if (!merged) throw new Error('orbit: parts would not merge');
    merged.computeBoundingSphere();
    return merged;
  }
}
