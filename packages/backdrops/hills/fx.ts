// Shared light, sky, wind and haze state for Bliss Hills. Every custom material references these
// uniform objects, so the one update a frame (tickHills) drives the grass, river, turbines and sky.
import * as THREE from 'three';
import { mulberry32 } from '../../stages/shared/random.ts';

// The sun stands over the valley, just left of the turbines. The hills are lit by a key light from
// the same side but a little in front, so the slopes facing us read bright, Bliss-style; the true
// sun direction still drives the sky, the backlit sheen on the crests and the glints.
export const SUN_DIR = new THREE.Vector3(0.1866, 0.2079, -0.9603).normalize();
export const KEY_DIR = new THREE.Vector3(0.62, 0.66, 0.42).normalize();

const noise: THREE.IUniform<THREE.Texture | null> = { value: null };

export const fx = {
  uTime: { value: 0 },
  uNoise: noise,
  uWindDir: { value: new THREE.Vector2(-0.8, -0.6).normalize() },
  uSunDir: { value: SUN_DIR },
  uKeyDir: { value: KEY_DIR },
  uSunColor: { value: new THREE.Color('#fff4dc') },
  uKeyColor: { value: new THREE.Color('#fff4de') },
  uSkyLight: { value: new THREE.Color('#9ccaff').multiplyScalar(0.5) },
  uGroundLight: { value: new THREE.Color('#5a8a30').multiplyScalar(0.3) },
  uZenith: { value: new THREE.Color('#0a2c8f') },
  uUpper: { value: new THREE.Color('#2453b4') },
  uHorizon: { value: new THREE.Color('#8cc0ee') },
  uGlow: { value: new THREE.Color('#e4f4ff') },
  uHazeDensity: { value: 0.0009 },
  // Distant land fades to a deeper atmospheric blue than the sky's horizon before melting into it.
  uLandHaze: { value: new THREE.Color('#4f8cc6') },
};

export function tickHills(time: number): void {
  fx.uTime.value = time;
}

/**
 * 256x256 tileable value noise, 3 octaves per channel (RGBA = 4 independent fields). Far cheaper
 * to sample than simplex across the big hills.
 */
export function makeNoiseTexture(size = 256): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const field = new Float32Array(size * size);
  const smooth = (t: number) => t * t * (3 - 2 * t);
  for (let ch = 0; ch < 4; ch++) {
    const rand = mulberry32(431 + ch * 1013);
    field.fill(0);
    for (const [cells, amp] of [[4, 0.55], [8, 0.3], [16, 0.15]]) {
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
    for (const v of field) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    for (let i = 0; i < size * size; i++) data[i * 4 + ch] = Math.round(((field[i] - lo) / (hi - lo)) * 255);
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

// The sky gradient and the sun, shared by the dome, the haze and every reflection, so distant
// hills melt into exactly the sky behind them and the water mirrors it.
export const skyGLSL = /* glsl */ `
uniform vec3 uSunDir, uSunColor, uZenith, uUpper, uHorizon, uGlow;
uniform float uHazeDensity;
// 0 on the side away from the sun, 1 towards it.
float sunward(vec3 d) {
  return dot(normalize(d.xz + vec2(1e-5)), normalize(uSunDir.xz)) * 0.5 + 0.5;
}
vec3 skyGradient(vec3 d) {
  float h = max(d.y, 0.0);
  float az = sunward(d);
  vec3 col = mix(uHorizon, uUpper, smoothstep(0.0, 0.16, h));
  col = mix(col, uZenith, smoothstep(0.12, 0.6, h));
  // A deeper blue away from the sun, a luminous haze low towards it.
  col *= mix(0.84, 1.04, az);
  col = mix(col, uGlow, pow(az, 10.0) * (1.0 - smoothstep(0.0, 0.2, h)) * 0.22);
  return col;
}
vec3 sunHalo(vec3 d) {
  float s = max(dot(d, uSunDir), 0.0);
  return uSunColor * (pow(s, 3000.0) * 9.0 + pow(s, 400.0) * 0.8) + uGlow * (pow(s, 60.0) * 0.3 + pow(s, 18.0) * 0.045);
}
vec3 hazeColor(vec3 dir) {
  vec3 d = normalize(vec3(dir.x, 0.02 + max(dir.y, 0.0) * 0.4, dir.z));
  return skyGradient(d) + uGlow * pow(max(dot(normalize(dir), uSunDir), 0.0), 8.0) * 0.12;
}
vec3 applyHaze(vec3 col, vec3 wp, float strength) {
  vec3 dv = wp - cameraPosition;
  float dist = length(dv);
  float f = 1.0 - exp(-pow(dist * uHazeDensity * strength, 1.25));
  return mix(col, hazeColor(dv / max(dist, 1e-3)), f);
}
uniform vec3 uLandHaze;
// The land's haze: blue over the middle distance, the sky's own colour at the far edge.
vec3 applyLandHaze(vec3 col, vec3 wp) {
  vec3 dv = wp - cameraPosition;
  float dist = length(dv);
  float f = 1.0 - exp(-pow(dist * uHazeDensity, 1.25));
  vec3 tint = mix(uLandHaze, hazeColor(dv / max(dist, 1e-3)), smoothstep(1200.0, 5000.0, dist));
  return mix(col, tint, f);
}
`;

// Key light, ambient and the wind over the grass.
export const landGLSL = /* glsl */ `
uniform float uTime;
uniform sampler2D uNoise;
uniform vec2 uWindDir;
uniform vec3 uKeyDir, uKeyColor, uSkyLight, uGroundLight;
// Texture noise in roughly [-1, 1]; one unit = 1/8 of the tile.
vec4 tnoise(vec2 q) { return texture2D(uNoise, q * 0.125) * 2.0 - 1.0; }
vec3 ambient(vec3 n) { return mix(uGroundLight, uSkyLight, n.y * 0.5 + 0.5); }
// 0..1: crests of wind rolling downwind across the grass, long across the wind and narrow along it.
float gust(vec2 p) {
  vec2 w = uWindDir;
  vec2 a = vec2(dot(p, w), dot(p, vec2(-w.y, w.x)));
  vec2 q = vec2(a.x * 0.016 - uTime * 0.13, a.y * 0.006);
  float n = tnoise(q).r * 0.75 + tnoise(q * vec2(2.3, 1.6) + vec2(-uTime * 0.09, 3.1)).g * 0.25;
  float crest = exp(-pow((n - 0.18) * 5.0, 2.0));
  return crest * smoothstep(-0.4, 0.1, n);
}
// 1 in sunlight, lower under the shadows of the drifting clouds.
float cloudShadow(vec2 p) {
  vec2 q = p * 0.0045 + uWindDir * uTime * 0.0075;
  float n = tnoise(q).b * 0.75 + tnoise(q * 2.3 + 5.1).a * 0.25;
  return 1.0 - smoothstep(0.12, 0.5, n) * 0.42;
}
`;
