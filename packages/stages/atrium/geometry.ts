import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { AXIS } from './layout.ts';

export type RGB = readonly [r: number, g: number, b: number];
/** A profile point: [radius from the axis, height]. */
export type ProfilePoint = readonly [r: number, y: number];

/**
 * Sweeps a cross-section profile round the axis from theta0 to theta1: a curved balcony, a ring
 * beam. uv: x = arc length at the profile's first radius, y = 0..1 along the profile. Repeat a
 * profile point to crease the surface there.
 */
export function sweepArc(profile: readonly ProfilePoint[], theta0: number, theta1: number, segments: number): THREE.BufferGeometry {
  const n = profile.length;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const lengths = [0];
  for (let j = 1; j < n; j++) lengths.push(lengths[j - 1] + Math.hypot(profile[j][0] - profile[j - 1][0], profile[j][1] - profile[j - 1][1]));
  const total = lengths[n - 1] || 1;
  for (let i = 0; i <= segments; i++) {
    const theta = theta0 + ((theta1 - theta0) * i) / segments;
    const s = Math.sin(theta);
    const c = Math.cos(theta);
    for (let j = 0; j < n; j++) {
      const [r, y] = profile[j];
      positions.push(AXIS.x + r * s, y, AXIS.z + r * c);
      uvs.push(theta * profile[0][0], lengths[j] / total);
    }
  }
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < n - 1; j++) {
      const a = i * n + j;
      const b = a + n;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

/** Segments for an arc `span` radians long, `perRadian` to the radian. */
export const arcSegments = (span: number, perRadian: number): number => Math.max(1, Math.ceil(span * perRadian));

/** Fills a per-vertex attribute with one value. */
export function fill(geometry: THREE.BufferGeometry, name: string, value: readonly number[]): THREE.BufferGeometry {
  const count = geometry.attributes.position.count;
  const data = new Float32Array(count * value.length);
  for (let i = 0; i < count; i++) data.set(value, i * value.length);
  geometry.setAttribute(name, new THREE.BufferAttribute(data, value.length));
  return geometry;
}

/**
 * Merges geometries into one, keeping the attributes they all have and reconciling indexed with
 * non-indexed inputs, and disposes of the inputs.
 */
export function mergeAll(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const mixed = list.some((g) => g.index) && list.some((g) => !g.index);
  const prepared = mixed ? list.map((g) => (g.index ? g.toNonIndexed() : g)) : list;
  const names = Object.keys(prepared[0].attributes).filter((n) => prepared.every((g) => g.attributes[n]));
  for (const g of prepared) for (const n of Object.keys(g.attributes)) if (!names.includes(n)) g.deleteAttribute(n);
  const merged = mergeGeometries(prepared);
  new Set([...list, ...prepared]).forEach((g) => g.dispose());
  return merged;
}

/** An instanced copy of `base` with per-instance attributes: name -> [itemSize, data]. */
export function instanced(base: THREE.BufferGeometry, count: number, attributes: Record<string, readonly [number, Float32Array]>): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  g.index = base.index;
  for (const [name, attribute] of Object.entries(base.attributes)) g.setAttribute(name, attribute);
  for (const [name, [size, data]] of Object.entries(attributes)) g.setAttribute(name, new THREE.InstancedBufferAttribute(data, size));
  g.instanceCount = count;
  return g;
}
