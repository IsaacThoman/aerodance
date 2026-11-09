import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { hash, simplex } from '../../stages/shared/glsl.ts';
import { mulberry32 } from '../../stages/shared/random.ts';
import { SUN_DIR } from './layout.ts';

/**
 * The uniforms every custom material shares (spread into each material's own), so one write a
 * frame moves the leaves, water, mist and light together.
 */
export const fx = {
  uTime: { value: 0 },
  uSunDir: { value: SUN_DIR.clone() },
  uNoise: { value: null } as THREE.IUniform<THREE.Texture | null>,
};

// The light, matched by the deck's real lights (BiodomeArena.tsx) so custom and standard
// materials sit together: a warm low sun through the glass, sky light from the dome, green
// bounce from the forest, and humid, sunlit air that softens everything far away.
export const SUN_COLOR = new THREE.Color(1.0, 0.86, 0.66);
export const SUN_INTENSITY = 2.5;
export const HAZE_COLOR = new THREE.Color('#bfe6dc');
/** FogExp2 density for the standard materials: the same curve as haze() below. */
export const HAZE_DENSITY = 0.0085;

const v3 = (c: THREE.Color, k = 1) => `vec3(${(c.r * k).toFixed(3)}, ${(c.g * k).toFixed(3)}, ${(c.b * k).toFixed(3)})`;

export const LIGHT = /* glsl */ `
uniform float uTime;
uniform vec3 uSunDir;
uniform sampler2D uNoise;
${hash}
${simplex}
const vec3 SUN = ${v3(SUN_COLOR, SUN_INTENSITY * 0.62)};
const vec3 SKY_LIGHT = vec3(0.46, 0.66, 0.78);
const vec3 GROUND_LIGHT = vec3(0.16, 0.26, 0.15);
const vec3 HAZE = ${v3(HAZE_COLOR)};
const vec3 HAZE_SUN = vec3(1.0, 0.9, 0.68);

// Texture noise in about [-1, 1]; one unit = an eighth of the tile.
vec4 tnoise(vec2 q) { return texture2D(uNoise, q * 0.125) * 2.0 - 1.0; }

vec3 ambient(vec3 n) { return mix(GROUND_LIGHT, SKY_LIGHT, n.y * 0.5 + 0.5); }

// How much sun reaches p: open above the canopy, dappled and dimming down through it.
float sunReach(vec3 p) {
  float open = smoothstep(-12.0, -1.0, p.y);
  float fleck = tnoise(p.xz * 0.21 + p.y * 0.05).r * 0.6 + tnoise(p.xz * 0.53 - p.y * 0.07).g * 0.4;
  float dapple = smoothstep(-0.15, 0.35, fleck);
  return mix(0.12 + 0.5 * dapple, 1.0, open);
}

float hazeAmount(vec3 w) {
  float d = length(w - cameraPosition);
  float k = d * ${HAZE_DENSITY.toFixed(5)};
  k = 1.0 - exp(-k * k);
  // Humid air pooled low in the forest, thicker the further down.
  k += (1.0 - k) * smoothstep(-6.0, -21.0, w.y) * smoothstep(8.0, 34.0, d) * 0.32;
  return clamp(k, 0.0, 0.92);
}

vec3 hazeColor(vec3 w) {
  vec3 dir = (w - cameraPosition) / max(length(w - cameraPosition), 1e-3);
  float s = pow(max(dot(dir, uSunDir), 0.0), 5.0);
  // Down in the forest the air is shaded green.
  vec3 low = mix(HAZE, vec3(0.36, 0.56, 0.5), smoothstep(-4.0, -18.0, w.y));
  return mix(low, HAZE_SUN * 1.25, s * 0.6);
}

vec3 haze(vec3 col, vec3 w) { return mix(col, hazeColor(w), hazeAmount(w)); }
`;

/** World-space vertex shader: vWorld, vNormal, vUv. */
export const WORLD_VERTEX = /* glsl */ `
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

/**
 * 256x256 tileable value noise, three octaves a channel (RGBA = four independent fields),
 * far cheaper to sample than simplex.
 */
export function makeNoiseTexture(size = 256): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const field = new Float32Array(size * size);
  const smooth = (t: number) => t * t * (3 - 2 * t);
  for (let ch = 0; ch < 4; ch++) {
    const rand = mulberry32(431 + ch * 977);
    field.fill(0);
    for (const [cells, amp] of [[8, 0.6], [16, 0.28], [32, 0.12]]) {
      const grid = new Float32Array(cells * cells).map(() => rand());
      for (let y = 0; y < size; y++) {
        const gy = (y / size) * cells;
        const y0 = Math.floor(gy);
        const fy = smooth(gy - y0);
        const y1 = (y0 + 1) % cells;
        for (let x = 0; x < size; x++) {
          const gx = (x / size) * cells;
          const x0 = Math.floor(gx);
          const fx_ = smooth(gx - x0);
          const x1 = (x0 + 1) % cells;
          const a = grid[y0 * cells + x0] + (grid[y0 * cells + x1] - grid[y0 * cells + x0]) * fx_;
          const b = grid[y1 * cells + x0] + (grid[y1 * cells + x1] - grid[y1 * cells + x0]) * fx_;
          field[y * size + x] += (a + (b - a) * fy) * amp;
        }
      }
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of field) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    for (let i = 0; i < size * size; i++) data[i * 4 + ch] = Math.round(((field[i] - lo) / (hi - lo)) * 255);
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

// ------------------------------------------------------------------ geometry helpers

/** Fills a per-vertex attribute with one value. */
export function fill(geometry: THREE.BufferGeometry, name: string, value: readonly number[]): THREE.BufferGeometry {
  const count = geometry.attributes.position.count;
  const data = new Float32Array(count * value.length);
  for (let i = 0; i < count; i++) data.set(value, i * value.length);
  geometry.setAttribute(name, new THREE.BufferAttribute(data, value.length));
  return geometry;
}

/**
 * Merges geometries into one, keeping only the attributes they all have, reconciling indexed and
 * non-indexed ones, and disposes of the inputs.
 */
export function merge(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const mixed = list.some((g) => g.index) && list.some((g) => !g.index);
  const prepared = mixed ? list.map((g) => (g.index ? g.toNonIndexed() : g)) : list;
  const names = Object.keys(prepared[0].attributes).filter((n) => prepared.every((g) => g.attributes[n]));
  for (const g of prepared) for (const n of Object.keys(g.attributes)) if (!names.includes(n)) g.deleteAttribute(n);
  const merged = mergeGeometries(prepared);
  new Set([...list, ...prepared]).forEach((g) => g.dispose());
  merged.computeBoundingSphere();
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

const UP = new THREE.Vector3(0, 1, 0);

/** A tapered cylinder from p0 (radius r0) to p1 (radius r1). */
export function limb(p0: THREE.Vector3, p1: THREE.Vector3, r0: number, r1: number, segments = 8, open = true): THREE.BufferGeometry {
  const dir = p1.clone().sub(p0);
  const g = new THREE.CylinderGeometry(r1, r0, dir.length(), segments, 1, open);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, dir.normalize()));
  return g.translate((p0.x + p1.x) / 2, (p0.y + p1.y) / 2, (p0.z + p1.z) / 2);
}

// A small 3D value noise for shaping rocks and crowns on the CPU.
function hash3(x: number, y: number, z: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function valueNoise3(x: number, y: number, z: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx_ = x - xi, fy = y - yi, fz = z - zi;
  const u = fx_ * fx_ * (3 - 2 * fx_), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (dx: number, dy: number, dz: number) => hash3(xi + dx, yi + dy, zi + dz);
  return l(
    l(l(c(0, 0, 0), c(1, 0, 0), u), l(c(0, 1, 0), c(1, 1, 0), u), v),
    l(l(c(0, 0, 1), c(1, 0, 1), u), l(c(0, 1, 1), c(1, 1, 1), u), v),
    w,
  ) * 2 - 1;
}

export function fbm3(x: number, y: number, z: number, octaves = 4): number {
  let sum = 0, amp = 0.5, f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise3(x * f + i * 17.3, y * f - i * 9.1, z * f + i * 4.7) * amp;
    f *= 2.07;
    amp *= 0.5;
  }
  return sum;
}
