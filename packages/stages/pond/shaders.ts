import * as THREE from 'three';
import { hash, simplex } from '../shared/glsl.ts';
import { DROP_AREA, KOI, STAGE_PAD, SUN_DIRECTION } from './layout.ts';

// Adapted from the koi pond menu backdrop: the same water, caustics, koi shadows and pads, seen
// from the side here instead of from above, so the surface also mirrors the garden around it.

/**
 * The floor's baked map and the fields (bake.ts) cover this rectangle of the pond (x, z): all
 * of the pond bed, the stream's mouth included.
 */
export const MAP_RECT = { min: [-24, -36] as const, size: [48, 53] as const };

/** The reflection cube is captured from here, and looked up as if the garden were a sphere this big around it. */
export const REFLECT_ORIGIN = [0, 0.8, 0] as const;
export const REFLECT_RADIUS = 26;

/** Uniforms every pond material shares (the same objects, so one write updates them all). */
export interface PondUniforms {
  [name: string]: THREE.IUniform;
  uTime: THREE.IUniform<number>;
  /** Towards the sun, above the water. */
  uSun: THREE.IUniform<THREE.Vector3>;
  /** Towards the sun, below the water (refracted, so steeper). */
  uSunW: THREE.IUniform<THREE.Vector3>;
  /** Per koi: head (x, z), middle (x, z). */
  uKoiA: THREE.IUniform<THREE.Vector4[]>;
  /** Per koi: tail root (x, z), height (y), size. */
  uKoiB: THREE.IUniform<THREE.Vector4[]>;
  /** Ages in seconds of the last four rings the beat sent out from the dancers' pad (negative: none). */
  uRings: THREE.IUniform<THREE.Vector4>;
  /** The floor, baked once (bake.ts): rgb sqrt(albedo), a its pebbles' sunlit share. */
  uFloorMap: THREE.IUniform<THREE.Texture | null>;
  /** Tiling detail (bake.ts): r caustic lines, g and b the surface's chop, a cloud noise. */
  uDetailMap: THREE.IUniform<THREE.Texture | null>;
  /** r: signed distance to the nearest lily pad's rim; g: distance from the shore (bake.ts). */
  uFields: THREE.IUniform<THREE.Texture | null>;
  /** The garden around the pond, captured once (Reflection.tsx). */
  uReflect: THREE.IUniform<THREE.Texture | null>;
  /** 1 once uReflect holds the capture; until then the water mirrors a plain sky. */
  uReflectReady: THREE.IUniform<number>;
}

export function makePondUniforms(): PondUniforms {
  const sun = new THREE.Vector3(...SUN_DIRECTION).normalize();
  // Snell's law: the sun's rays bend towards the vertical entering the water.
  const sinAir = Math.hypot(sun.x, sun.z);
  const sinWater = sinAir / 1.33;
  const flat = new THREE.Vector2(sun.x, sun.z).normalize().multiplyScalar(sinWater);
  const sunW = new THREE.Vector3(flat.x, Math.sqrt(1 - sinWater * sinWater), flat.y);
  return {
    uTime: { value: 0 },
    uSun: { value: sun },
    uSunW: { value: sunW },
    uKoiA: { value: KOI.map(() => new THREE.Vector4(0, 100, 0, 100)) },
    uKoiB: { value: KOI.map(() => new THREE.Vector4(0, 100, -0.5, 1)) },
    uRings: { value: new THREE.Vector4(-1, -1, -1, -1) },
    uFloorMap: { value: null },
    uDetailMap: { value: null },
    uFields: { value: null },
    uReflect: { value: null },
    uReflectReady: { value: 0 },
  };
}

/** The fields store pad distances from PAD_RANGE[0] to [1], and shore distances from SHORE_RANGE[0] to [1], as 0..1. */
export const PAD_RANGE = [-0.5, 1.5] as const;
export const SHORE_RANGE = [-10, 2] as const;

const f = (n: number) => n.toFixed(4);

/**
 * GLSL shared by the pond's materials and its bakes: the surface's swell and ripple rings (as
 * height gradients, so the floor and the koi can wobble with the same refraction the surface
 * shows).
 */
export const pondCommonGLSL = /* glsl */ `
#define KOI_COUNT ${KOI.length}
uniform float uTime;
uniform vec3 uSun;
uniform vec3 uSunW;
uniform vec4 uKoiA[KOI_COUNT];
uniform vec4 uKoiB[KOI_COUNT];
uniform vec4 uRings;
${hash}
${simplex}

const vec3 SUN_COLOR = vec3(1.0, 0.95, 0.84);
const float PAD_RADIUS = ${f(STAGE_PAD.radius)};

// One travelling sine: (dh/dx, dh/dz, h).
vec3 wave(vec2 p, vec2 d, float k, float a, float s) {
  float ph = dot(d, p) * k + uTime * s;
  return vec3(d * (a * k * cos(ph)), a * sin(ph));
}

// The gentle swell that keeps the whole surface alive.
vec3 swell(vec2 p) {
  vec3 w = wave(p, vec2(0.96, 0.28), 1.7, 0.02, 0.8);
  w += wave(p, vec2(-0.45, 0.89), 2.6, 0.012, 1.05);
  w += wave(p, vec2(0.62, -0.78), 3.9, 0.008, 1.4);
  w += wave(p, vec2(-0.93, -0.37), 5.6, 0.0045, 1.9);
  return w;
}

// A ring of height a spreading out past r = front: (dh/dx, dh/dz, h), with d = p - its centre.
vec3 ringWave(vec2 d, float front, float width, float a) {
  float r = length(d) + 1e-4;
  float x = r - front;
  if (abs(x) > width * 3.0) return vec3(0.0);
  const float K = 12.0;
  float env = a * exp(-x * x / (width * width));
  float dh = env * (-K * sin(x * K) - 2.0 * x / (width * width) * cos(x * K));
  return vec3(dh * d / r, env * cos(x * K));
}

// Rings spreading from the occasional drop, at hashed spots on the open water, and from the
// dancers' pad on the beat. Each drop's ring fades out long before its slot comes round again,
// so nothing visibly resets.
#define DROP_PERIOD 2.3
#define DROP_LIFE 9.0
#define RING_LIFE 7.0
vec3 ripples(vec2 p) {
  vec3 w = vec3(0.0);
  float slot = floor(uTime / DROP_PERIOD);
  for (int k = 0; k < 4; k++) {
    float id = slot - float(k);
    float age = uTime - (id + hash11(id * 3.17 + 0.5) * 0.6) * DROP_PERIOD;
    if (age < 0.0 || age > DROP_LIFE) continue;
    vec2 c = mix(vec2(${f(DROP_AREA.min[0])}, ${f(DROP_AREA.min[1])}), vec2(${f(DROP_AREA.max[0])}, ${f(DROP_AREA.max[1])}), hash22(vec2(id, 7.31)));
    // Never under the dancers' pad.
    c *= max(1.0, (PAD_RADIUS + 1.0) / max(length(c), 1e-3));
    float front = 0.1 + age * 0.62;
    float life = age / DROP_LIFE;
    w += ringWave(p - c, front, 0.22 + age * 0.07, 0.016 * smoothstep(0.0, 0.35, age) * (1.0 - life) * (1.0 - life) / sqrt(1.0 + front * 1.5));
  }
  for (int k = 0; k < 4; k++) {
    float age = uRings[k];
    if (age < 0.0 || age > RING_LIFE) continue;
    float life = age / RING_LIFE;
    w += ringWave(p, PAD_RADIUS + 0.15 + age * 1.15, 0.2 + age * 0.05, 0.011 * smoothstep(0.0, 0.25, age) * (1.0 - life) * (1.0 - life));
  }
  return w;
}
`;

const rect = `vec4(${f(MAP_RECT.min[0])}, ${f(MAP_RECT.min[1])}, ${f(1 / MAP_RECT.size[0])}, ${f(1 / MAP_RECT.size[1])})`;

/**
 * The runtime GLSL on top of that: caustics, the soft shadows the koi and pads cast, the jade
 * water column, and the surface itself (its reflection of the garden, the sun's glitter, ripple
 * crests and the pads' meniscus), which everything under the water lays over itself rather than
 * a separate transparent layer drawing over it.
 */
export const pondGLSL = /* glsl */ `
${pondCommonGLSL}
uniform sampler2D uFloorMap;
uniform sampler2D uDetailMap;
uniform sampler2D uFields;
uniform samplerCube uReflect;
uniform float uReflectReady;
const vec4 MAP_RECT = ${rect};
const vec3 REFLECT_ORIGIN = vec3(${REFLECT_ORIGIN.map(f).join(', ')});
const float REFLECT_RADIUS = ${f(REFLECT_RADIUS)};

vec2 mapUv(vec2 p) { return (p - MAP_RECT.xy) * MAP_RECT.zw; }

// The dancing net of sunlight focused by the swell, about 0..1.5: two layers of the baked lines,
// warped and drifting past each other. \`blur\` widens the lines where they would get too fine
// for the buffer.
float caustics(vec2 p, float blur) {
  float t = uTime;
  vec2 warp = vec2(sin(p.y * 0.9 + t * 0.35), cos(p.x * 0.8 - t * 0.3)) * 0.22;
  float a = texture2D(uDetailMap, (p * 0.95 + warp) * 0.0625 + vec2(t * 0.012, t * 0.005)).r;
  float b = texture2D(uDetailMap, (mat2(0.8, -0.6, 0.6, 0.8) * p * 1.45 - warp * 1.3) * 0.0625 + vec2(0.37 - t * 0.007, 0.21 + t * 0.013)).r;
  float la = pow(a, 1.15 / (1.0 + blur * 6.0));
  float lb = pow(b, 1.45 / (1.0 + blur * 9.0));
  return la * 0.55 + lb * 0.35 + la * lb * 1.1;
}

float segment(vec2 p, vec2 a, vec2 b, out float h) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-5), 0.0, 1.0);
  return length(pa - ba * h);
}

// 0..1: how much the koi above shade a point at height y (soft, softer the further they are).
float koiShadow(vec2 p, float y) {
  vec2 toSun = uSunW.xz / uSunW.y;
  float s = 0.0;
  for (int i = 0; i < KOI_COUNT; i++) {
    vec4 a = uKoiA[i];
    vec4 b = uKoiB[i];
    float height = b.z - y;
    if (height < 0.05) continue;
    vec2 q = p + toSun * height;
    float blur = 0.03 + height * 0.09;
    // Most of the floor is nowhere near this fish's shadow.
    if (length(q - a.zw) > b.w * 0.75 + blur) continue;
    float h1;
    float h2;
    float d1 = segment(q, a.xy, a.zw, h1) - b.w * mix(0.07, 0.1, h1);
    float d2 = segment(q, a.zw, b.xy, h2) - b.w * mix(0.1, 0.03, h2);
    vec2 back = normalize(b.xy - a.zw + 1e-4);
    float fin = length(q - b.xy - back * b.w * 0.16) - b.w * 0.13;
    float body = 1.0 - smoothstep(-blur, blur, min(d1, d2));
    float tail = (1.0 - smoothstep(-blur, blur * 1.5, fin)) * 0.45;
    s = max(s, max(body, tail));
  }
  return s;
}

// Signed distance to the nearest lily pad's rim, from the baked field.
float padDistance(vec2 p) {
  return mix(${f(PAD_RANGE[0])}, ${f(PAD_RANGE[1])}, texture2D(uFields, mapUv(p)).r);
}

// 0..1: how much the lily pads on the surface shade a point at depth y (< 0).
float padShadow(vec2 p, float y) {
  float height = -y;
  float blur = 0.06 + height * 0.12;
  return 1.0 - smoothstep(-blur, blur, padDistance(p + uSunW.xz / uSunW.y * height) + 0.03);
}

// Looking through \`path\` units of jade water: red goes first, then blue, and the water's own
// green glow fills in.
vec3 waterColumn(vec3 col, float path) {
  vec3 keep = exp(-path * vec3(0.62, 0.19, 0.25));
  vec3 glow = vec3(0.006, 0.105, 0.095);
  return col * keep + glow * (1.0 - exp(-path * 0.55));
}

// Where the line of sight to a point under the water crosses the surface.
vec3 surfacePoint(vec3 wp) {
  return wp + (cameraPosition - wp) * (-wp.y / max(cameraPosition.y - wp.y, 1e-3));
}

// Until the garden is captured: a plain sky over a dark band of banks.
vec3 skyColor(vec3 r) {
  float h = clamp(r.y, 0.0, 1.0);
  vec3 c = mix(vec3(0.72, 0.9, 1.0), vec3(0.16, 0.45, 0.95), pow(h, 0.7));
  c = mix(vec3(0.1, 0.2, 0.08), c, smoothstep(0.03, 0.16, h));
  return c + SUN_COLOR * pow(max(dot(r, uSun), 0.0), 40.0) * 0.4;
}

// What the surface at s mirrors along r: the captured garden, as if it stood on a sphere around
// the capture point, so nearby banks line up with their reflections.
vec3 mirrored(vec3 s, vec3 r) {
  if (uReflectReady < 0.5) return skyColor(r);
  vec3 o = s - REFLECT_ORIGIN;
  float b = dot(o, r);
  float c = dot(o, o) - REFLECT_RADIUS * REFLECT_RADIUS;
  float t = -b + sqrt(max(b * b - c, 0.0));
  return texture(uReflect, o + r * t).rgb;
}

// Lays the surface over what is seen through it at surface point s, given the waves there
// (w, of which ring came from the ripples).
vec3 overSurface(vec3 col, vec3 s, vec3 w, float ring) {
  // A finer, slowly boiling chop on top for the glitter: two fields drifting different ways.
  vec2 chop = vec2(
    texture2D(uDetailMap, s.xz * 0.3 + vec2(uTime * 0.038, uTime * 0.022)).g,
    texture2D(uDetailMap, mat2(0.8, -0.6, 0.6, 0.8) * s.xz * 0.37 + vec2(0.5 - uTime * 0.028, 0.25 + uTime * 0.036)).b) - 0.5;
  chop *= 0.075;
  vec3 n = normalize(vec3(-(w.x + chop.x), 1.0, -(w.y + chop.y)));
  vec3 v = normalize(cameraPosition - s);
  float fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
  vec3 r = reflect(-v, n);
  r.y = abs(r.y);
  float rs = max(dot(r, uSun), 0.0);
  vec3 glint = SUN_COLOR * (pow(rs, 2600.0) * 3.0 + pow(rs, 500.0) * 0.06);
  // The ripple rings' crests catch the sky; their troughs shade a little.
  vec3 crest = vec3(0.55, 0.8, 0.85) * clamp(ring * 30.0, 0.0, 1.0) * 0.3;
  float trough = clamp(-ring * 30.0, 0.0, 1.0) * 0.1;
  // Around the pads: a thin bright meniscus where the water climbs their rims, then a soft
  // shade on the water beside them.
  float d = max(padDistance(s.xz), 0.0);
  float a = clamp(fres * 1.15 + 0.02 + exp(-d * 40.0) * 0.12, 0.0, 1.0);
  float cover = clamp(a + exp(-d * 6.0) * 0.22 + trough, 0.0, 1.0);
  return col * (1.0 - cover) + mirrored(s, r) * a + glint + crest;
}

// A point under the water as the camera sees it, lit colour col: through the water column and
// under the surface.
vec3 underWater(vec3 col, vec3 wp, float column) {
  vec3 v = normalize(cameraPosition - wp);
  col = waterColumn(col, column * max(-wp.y, 0.0) / max(v.y, 0.3));
  vec3 s = surfacePoint(wp);
  vec3 ring = ripples(s.xz);
  return overSurface(col, s, swell(s.xz) + ring, ring.z);
}
`;

/** Light for the garden around the pond: the sun, a sky-blue fill from above and a moss-green bounce from below, and a soft haze far off. */
export const gardenGLSL = /* glsl */ `
// The sky dome's horizon (#bfe6ff), so far things melt into the sky behind them.
const vec3 HAZE = vec3(0.52, 0.79, 1.0);

vec3 gardenLight(vec3 albedo, vec3 n, vec3 wp, float wrap, float gloss) {
  float ndl = dot(n, uSun);
  vec3 sky = mix(vec3(0.16, 0.24, 0.12), vec3(0.44, 0.54, 0.68), n.y * 0.5 + 0.5);
  vec3 col = albedo * (sky * 0.6 + SUN_COLOR * max((ndl + wrap) / (1.0 + wrap), 0.0) * 1.45);
  vec3 v = normalize(cameraPosition - wp);
  vec3 h = normalize(uSun + v);
  col += SUN_COLOR * pow(max(dot(n, h), 0.0), 48.0) * gloss;
  return col;
}

vec3 gardenHaze(vec3 col, vec3 wp) {
  float d = distance(wp, cameraPosition);
  return mix(col, HAZE, (1.0 - exp(-d * 0.004)) * 0.85);
}
`;
