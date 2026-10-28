import * as THREE from 'three';
import { hash, simplex } from '../../stages/shared/glsl.ts';
import { DROP_AREA, FLOOR_DEPTH, KOI, PADS, SUN_DIRECTION } from './layout.ts';

/**
 * The floor's baked map and the pads' distance field cover this rectangle of the pond (x, z):
 * all of the floor any frame can show, at 16:9 or 4:3, with the camera's drift.
 */
export const MAP_RECT = { min: [-15.5, -15] as const, size: [31, 22] as const };

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
  /** Per lily pad: centre (x, z), radius, turn. */
  uPads: THREE.IUniform<THREE.Vector4[]>;
  /** The floor, baked once (bake.ts): rgb sqrt(albedo), a its sunlit share after the pads' shade. */
  uFloorMap: THREE.IUniform<THREE.Texture | null>;
  /** Tiling detail (bake.ts): r caustic lines, g and b the surface's chop, a cloud noise. */
  uDetailMap: THREE.IUniform<THREE.Texture | null>;
  /** Signed distance to the nearest lily pad's rim (bake.ts). */
  uPadField: THREE.IUniform<THREE.Texture | null>;
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
    uPads: { value: PADS.map((p) => new THREE.Vector4(p.at[0], p.at[1], p.radius, p.turn)) },
    uFloorMap: { value: null },
    uDetailMap: { value: null },
    uPadField: { value: null },
  };
}

/** The pad field stores signed distances from PAD_FIELD_RANGE[0] to [1] as 0..1. */
export const PAD_FIELD_RANGE = [-0.5, 1.5] as const;

const f = (n: number) => n.toFixed(4);

/**
 * GLSL shared by the pond's materials and its bakes: the surface's swell and ripple rings (as
 * height gradients, so the floor and the koi can wobble with the same refraction the surface
 * shows) and the floor's depth.
 */
export const pondCommonGLSL = /* glsl */ `
#define KOI_COUNT ${KOI.length}
#define PAD_COUNT ${PADS.length}
uniform float uTime;
uniform vec3 uSun;
uniform vec3 uSunW;
uniform vec4 uKoiA[KOI_COUNT];
uniform vec4 uKoiB[KOI_COUNT];
uniform vec4 uPads[PAD_COUNT];
${hash}
${simplex}

const vec3 SUN_COLOR = vec3(1.0, 0.94, 0.82);

// Floor depth below the surface: shelving deep towards the left, where the menu sits.
float floorDepth(vec2 p) {
  float shelf = 1.0 - smoothstep(-6.5, 1.5, p.x + 0.3 * p.y);
  return ${f(FLOOR_DEPTH.base)} + ${f(FLOOR_DEPTH.deep)} * shelf + 0.25 * snoise(p * 0.12 + 3.1);
}

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

// Rings spreading from the occasional drop, at hashed spots on the open water. Each drop's ring
// fades out long before its slot comes round again, so nothing visibly resets.
#define DROP_PERIOD 2.9
#define DROP_LIFE 9.0
vec3 ripples(vec2 p) {
  vec3 w = vec3(0.0);
  float slot = floor(uTime / DROP_PERIOD);
  for (int k = 0; k < 4; k++) {
    float id = slot - float(k);
    float age = uTime - (id + hash11(id * 3.17 + 0.5) * 0.6) * DROP_PERIOD;
    if (age < 0.0 || age > DROP_LIFE) continue;
    vec2 c = mix(vec2(${f(DROP_AREA.min[0])}, ${f(DROP_AREA.min[1])}), vec2(${f(DROP_AREA.max[0])}, ${f(DROP_AREA.max[1])}), hash22(vec2(id, 7.31)));
    vec2 d = p - c;
    float r = length(d) + 1e-4;
    float front = 0.1 + age * 0.62;
    float x = r - front;
    float width = 0.22 + age * 0.07;
    // Nearly all of the pond is well clear of the ring.
    if (abs(x) > width * 3.0) continue;
    float life = age / DROP_LIFE;
    float env = exp(-x * x / (width * width)) * smoothstep(0.0, 0.35, age) * (1.0 - life) * (1.0 - life) / sqrt(1.0 + front * 1.5);
    const float K = 12.0;
    float a = 0.016;
    w.z += a * env * cos(x * K);
    float dh = a * env * (-K * sin(x * K) - 2.0 * x / (width * width) * cos(x * K));
    w.xy += dh * d / r;
  }
  return w;
}

vec3 surfaceWaves(vec2 p) { return swell(p) + ripples(p); }
`;

const rect = `vec4(${f(MAP_RECT.min[0])}, ${f(MAP_RECT.min[1])}, ${f(1 / MAP_RECT.size[0])}, ${f(1 / MAP_RECT.size[1])})`;

/**
 * The runtime GLSL on top of that: caustics, the soft shadows the koi and pads cast, the jade
 * water column, and the surface itself (its sky reflection, the sun's glitter, ripple crests and
 * the pads' meniscus), which the floor and the koi each lay over themselves rather than a
 * separate full-screen transparent layer drawing over them.
 */
export const pondGLSL = /* glsl */ `
${pondCommonGLSL}
uniform sampler2D uFloorMap;
uniform sampler2D uDetailMap;
uniform sampler2D uPadField;
const vec4 MAP_RECT = ${rect};

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
  return mix(${f(PAD_FIELD_RANGE[0])}, ${f(PAD_FIELD_RANGE[1])}, texture2D(uPadField, mapUv(p)).r);
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

// The sky the surface mirrors: deep blue overhead, paling to white, with soft drifting clouds
// and the sun's glow.
vec3 skyColor(vec3 r) {
  float h = clamp(r.y, 0.0, 1.0);
  vec3 c = mix(vec3(0.72, 0.9, 1.0), vec3(0.16, 0.45, 0.95), pow(h, 0.7));
  vec2 cp = r.xz / (r.y + 0.3) * 1.4 + vec2(uTime * 0.012, uTime * 0.005);
  float cl = (texture2D(uDetailMap, cp * 0.0625).a - 0.5) * 2.2;
  c = mix(c, vec3(1.05), smoothstep(0.05, 0.7, cl) * 0.75);
  c += SUN_COLOR * pow(max(dot(r, uSun), 0.0), 40.0) * 0.4;
  return c;
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
  vec3 crest = vec3(0.55, 0.8, 0.85) * clamp(ring * 30.0, 0.0, 1.0) * 0.35;
  float trough = clamp(-ring * 30.0, 0.0, 1.0) * 0.1;
  // Around the pads: a thin bright meniscus where the water climbs their rims, then a soft
  // shade on the water beside them.
  float d = max(padDistance(s.xz), 0.0);
  float a = clamp(fres * 1.8 + 0.02 + exp(-d * 40.0) * 0.12, 0.0, 1.0);
  float cover = clamp(a + exp(-d * 6.0) * 0.22 + trough, 0.0, 1.0);
  return col * (1.0 - cover) + skyColor(r) * a + glint + crest;
}
`;
