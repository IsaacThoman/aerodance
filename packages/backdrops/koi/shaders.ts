import * as THREE from 'three';
import { hash, simplex } from '../../stages/shared/glsl.ts';
import { DROP_AREA, FLOOR_DEPTH, KOI, PADS, SUN_DIRECTION } from './layout.ts';

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
  };
}

const f = (n: number) => n.toFixed(4);

/**
 * The pond's shared GLSL: the surface's swell and ripple rings (as height gradients, so the floor
 * and the koi can wobble with the same refraction the surface shows), caustics, the soft shadows
 * the koi and pads cast, and the jade water column.
 */
export const pondGLSL = /* glsl */ `
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

// Distance between the two nearest of a grid of drifting points, small along cell borders.
float causticCell(vec2 p, float t) {
  vec2 i = floor(p);
  vec2 fr = fract(p);
  float d1 = 8.0;
  float d2 = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 o = hash22(i + g);
      o = 0.5 + 0.42 * sin(t * (0.45 + 0.4 * o.yx) + 6.2831 * o);
      float d = length(g + o - fr);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
    }
  }
  return d2 - d1;
}

// The dancing net of sunlight focused by the swell, about 0..1.5. \`blur\` widens the lines
// where they would get too fine for the buffer.
float caustics(vec2 p, float blur) {
  float t = uTime;
  vec2 warp = vec2(sin(p.y * 0.9 + t * 0.35), cos(p.x * 0.8 - t * 0.3)) * 0.22;
  float a = causticCell(p * 0.95 + warp, t * 0.8);
  float b = causticCell(p * 1.45 + vec2(3.7, 1.3) - warp * 1.3, t * 1.05);
  float sa = 7.0 / (1.0 + blur * 6.0);
  float sb = 9.0 / (1.0 + blur * 9.0);
  float la = exp(-a * sa);
  float lb = exp(-b * sb);
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
    float h1;
    float h2;
    float d1 = segment(q, a.xy, a.zw, h1) - b.w * mix(0.07, 0.1, h1);
    float d2 = segment(q, a.zw, b.xy, h2) - b.w * mix(0.1, 0.03, h2);
    vec2 back = normalize(b.xy - a.zw + 1e-4);
    float fin = length((q - b.xy - back * b.w * 0.16) * vec2(1.0)) - b.w * 0.13;
    float blur = 0.03 + height * 0.09;
    float body = 1.0 - smoothstep(-blur, blur, min(d1, d2));
    float tail = (1.0 - smoothstep(-blur, blur * 1.5, fin)) * 0.45;
    s = max(s, max(body, tail));
  }
  return s;
}

// 0..1: how much the lily pads on the surface shade a point at depth y (< 0).
float padShadow(vec2 p, float y) {
  float height = -y;
  vec2 q = p + uSunW.xz / uSunW.y * height;
  float blur = 0.06 + height * 0.12;
  float s = 0.0;
  for (int i = 0; i < PAD_COUNT; i++) {
    vec4 pad = uPads[i];
    float d = length(q - pad.xy) - pad.z * 0.97;
    s = max(s, 1.0 - smoothstep(-blur, blur, d));
  }
  return s;
}

// Looking through \`path\` units of jade water: red goes first, then blue, and the water's own
// green glow fills in.
vec3 waterColumn(vec3 col, float path) {
  vec3 keep = exp(-path * vec3(0.62, 0.19, 0.25));
  vec3 glow = vec3(0.006, 0.105, 0.095);
  return col * keep + glow * (1.0 - exp(-path * 0.55));
}
`;
