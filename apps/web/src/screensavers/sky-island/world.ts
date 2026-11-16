import * as THREE from 'three';
import { mulberry32 } from '../../../../../packages/stages/shared/random.ts';

/*
 * The light, the weather and the wind every material on the sky island reads: one set of shared
 * uniforms (W), set once a frame by the island's driver (Saver.tsx) from atmosphere.ts, and the
 * GLSL that uses them, so the sky, the haze and every reflection agree. Shaders output linear HDR
 * for the stages' bloom and ACES.
 */

/** Shadow casters (trees, the greenhouse, the tower, the turbines) the ground is shaded by. */
export const MAX_CASTERS = 20;

const num = (value = 0) => ({ value });
const color = () => ({ value: new THREE.Color() });
const vec3 = (x = 0, y = 1, z = 0) => ({ value: new THREE.Vector3(x, y, z) });
const vec2 = () => ({ value: new THREE.Vector2() });

export const W = {
  uTime: num(),
  uNoise: { value: null as THREE.Texture | null },
  // The sun, the light (the sun's or the moon's), the moon and its lighting, the stars' turn.
  uSunDir: vec3(), uKeyDir: vec3(), uMoonDir: vec3(), uMoonR: vec3(1, 0, 0), uMoonU: vec3(0, 1, 0), uMoonSun: vec3(0, 0, 1),
  uStarAxis: vec3(), uStarAngle: num(),
  uKeyColor: color(), uSunColor: color(),
  uZenith: color(), uHorizon: color(), uBelow: color(), uGlow: color(), uGlowAmount: num(),
  uAmbSky: color(), uAmbGround: color(), uCloudLit: color(), uCloudShade: color(),
  uFogColor: color(), uFogDensity: num(0.001), uFog: num(),
  uSunDisc: num(), uStars: num(), uMoonVis: num(), uDaylight: num(1), uNight: num(), uLamps: num(), uFireflies: num(),
  // Weather, eased: cloud cover, how overcast, rain, falling snow, snow lying, wetness, storm, the lightning's flash.
  uCloud: num(), uOvercast: num(), uRain: num(), uSnowFall: num(), uSnowCover: num(), uWet: num(), uStorm: num(), uFlash: num(),
  // The wind: how strong, its direction over the ground, the sway's phase, and how far it's carried the clouds.
  // Each drift wraps where every texture sampling it lines up again (Saver.tsx), so none ever jumps:
  // the sway (a phase, for sines), the grass's gusts and the pond's ripples (texture tiles), the
  // stream's and the falls' flow, the high clouds, the sea of clouds.
  uWind: num(), uWindDir: { value: new THREE.Vector2(0.8, -0.6).normalize() }, uSway: num(), uGust: num(), uFlow: vec2(), uDrift: vec2(), uSeaDrift: vec2(),
  uCasters: { value: Array.from({ length: MAX_CASTERS }, () => new THREE.Vector4(0, -1000, 0, 0)) },
  uCasterTops: { value: Array.from({ length: MAX_CASTERS }, () => new THREE.Vector2(-1000, 0)) },
};

/**
 * 256x256 tileable value noise, three octaves in each of RGBA (four independent fields), 0..1.
 * Far cheaper to sample than simplex across the sky and the clouds.
 */
export function makeNoiseTexture(size = 256): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const field = new Float32Array(size * size);
  const s = (t: number) => t * t * (3 - 2 * t);
  for (let ch = 0; ch < 4; ch++) {
    const rand = mulberry32(911 + ch * 977);
    field.fill(0);
    for (const [cells, amp] of [[4, 0.5], [8, 0.3], [16, 0.13], [32, 0.07]]) {
      const grid = Float32Array.from({ length: cells * cells }, () => rand());
      for (let y = 0; y < size; y++) {
        const gy = (y / size) * cells, y0 = Math.floor(gy), fy = s(gy - y0), y1 = (y0 + 1) % cells;
        for (let x = 0; x < size; x++) {
          const gx = (x / size) * cells, x0 = Math.floor(gx), fx = s(gx - x0), x1 = (x0 + 1) % cells;
          const a = grid[y0 * cells + x0] + (grid[y0 * cells + x1] - grid[y0 * cells + x0]) * fx;
          const b = grid[y1 * cells + x0] + (grid[y1 * cells + x1] - grid[y1 * cells + x0]) * fx;
          field[y * size + x] += (a + (b - a) * fy) * amp;
        }
      }
    }
    let lo = Infinity, hi = -Infinity;
    for (const v of field) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    for (let i = 0; i < size * size; i++) data[i * 4 + ch] = Math.round(((field[i] - lo) / (hi - lo)) * 255);
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** The sky, the haze and the light, for every material. */
export const commonGLSL = /* glsl */ `
uniform float uTime, uGlowAmount, uFog, uFogDensity, uDaylight, uNight, uLamps;
uniform float uCloud, uOvercast, uRain, uSnowCover, uWet, uStorm, uFlash, uWind, uSway, uGust;
uniform vec3 uSunDir, uKeyDir, uKeyColor, uSunColor, uZenith, uHorizon, uBelow, uGlow;
uniform vec3 uAmbSky, uAmbGround, uCloudLit, uCloudShade, uFogColor;
uniform vec2 uWindDir;
uniform sampler2D uNoise;

// Texture noise: four independent fields, -1..1.
vec4 tnoise(vec2 q) { return texture2D(uNoise, q) * 2.0 - 1.0; }

// 1 looking along the sun's bearing, 0 away from it.
float sunward(vec3 d) {
  float la = length(d.xz), ls = length(uSunDir.xz);
  if (la < 1e-4 || ls < 1e-4) return 0.5;
  // (Clamped: a dot of unit vectors can stray past 1, and pow() of anything below 0 is NaN.)
  return clamp(dot(d.xz / la, uSunDir.xz / ls) * 0.5 + 0.5, 0.0, 1.0);
}

// The sky's colour looking along d (no sun, moon or clouds): what reflections and the haze use.
vec3 skyGradient(vec3 d) {
  float h = d.y;
  float sw = sunward(d);
  float band = 1.0 - smoothstep(0.0, mix(0.18, 0.45, sw * sw), abs(h));
  vec3 hor = mix(uHorizon, uGlow, pow(sw, 2.5) * uGlowAmount * band);
  float up = clamp(h, 0.0, 1.0);
  vec3 col = mix(hor, uZenith, pow(up, 0.42));
  return mix(col, uBelow, smoothstep(0.0, 0.2, -h));
}

// What the distance fades into, looking along dir.
vec3 hazeColor(vec3 dir) {
  vec3 h = skyGradient(normalize(vec3(dir.x, 0.0, dir.z) + vec3(1e-5, 0.0, 0.0)));
  return mix(h, uFogColor, clamp(uFog * 1.3, 0.0, 1.0));
}

float fogAmount(float dist) { return 1.0 - exp(-pow(max(dist * uFogDensity, 0.0), 1.35)); }

// Distance haze, and mist gathering low towards the sea of clouds.
vec3 applyFog(vec3 col, vec3 wp) {
  vec3 dv = wp - cameraPosition;
  float dist = length(dv);
  float f = fogAmount(dist);
  f = max(f, smoothstep(-40.0, -72.0, wp.y) * 0.85);
  return mix(col, hazeColor(dv / max(dist, 1e-3)), clamp(f, 0.0, 1.0));
}

vec3 ambient(vec3 n) { return mix(uAmbGround, uAmbSky, n.y * 0.5 + 0.5); }
// Lightning lights everything for a moment, a cold white mostly from above.
vec3 flashLight(vec3 n) { return vec3(0.75, 0.82, 1.0) * uFlash * (0.35 + 0.65 * max(n.y, 0.0)) * 1.6; }

// What a glossy surface mirrors: the sky above, the bright sea of clouds below.
vec3 envColor(vec3 r) {
  if (r.y >= 0.0) return skyGradient(r);
  return mix(uBelow, mix(uCloudLit, uCloudShade, 0.35) * 0.9, smoothstep(0.0, -0.25, r.y));
}

// A highlight of the light (sun or moon) on a glossy surface.
float keyGlint(vec3 n, vec3 v, float power) { return pow(max(dot(n, normalize(uKeyDir + v + vec3(0.0, 1e-4, 0.0))), 0.0), power); }
`;

/** The ground's shadows from the casters (uCasters), along the light: commonGLSL first. */
export const shadowGLSL = /* glsl */ `
uniform vec4 uCasters[${MAX_CASTERS}];
uniform vec2 uCasterTops[${MAX_CASTERS}];
// 1 in the light, less under a caster's shadow. Each caster is an upright capsule:
// (x, foot y, z, radius) to its top y, of strength 0..1 (glass less).
float casterShadow(vec3 p) {
  vec3 s = uKeyDir;
  if (s.y < 0.015) return 1.0;
  float lit = 1.0;
  for (int i = 0; i < ${MAX_CASTERS}; i++) {
    vec4 c = uCasters[i];
    if (c.w <= 0.0) continue;
    vec3 a = c.xyz;
    float hgt = uCasterTops[i].x - c.y;
    vec3 w = p - a;
    float b = s.y * hgt;
    float den = hgt * hgt - b * b;
    float u = den > 1e-4 ? clamp((w.y * hgt - b * dot(s, w)) / den, 0.0, 1.0) : 0.0;
    vec3 q = a + vec3(0.0, hgt * u, 0.0);
    float t = dot(q - p, s);
    if (t <= 0.0) continue;
    float dist = length(p + s * t - q);
    float sh = smoothstep(c.w * 0.5, c.w * 1.2, dist);
    lit *= mix(1.0, sh, uCasterTops[i].y * (1.0 - smoothstep(20.0, 48.0, t)));
  }
  return lit;
}
`;
