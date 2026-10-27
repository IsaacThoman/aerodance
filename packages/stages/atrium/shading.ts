import { createContext, useContext } from 'react';
import * as THREE from 'three';
import { hash, simplex } from '../shared/glsl.ts';
import { LAYOUT_GLSL, TREES, polar } from './layout.ts';
import type { AtriumLook, RGB } from './looks.ts';

export interface AtriumUniforms {
  [name: string]: THREE.IUniform;
  uTime: THREE.IUniform<number>;
  /** 1 on the beat, decaying. */
  uBeat: THREE.IUniform<number>;
  uSunDir: THREE.IUniform<THREE.Vector3>;
  uSun: THREE.IUniform<THREE.Vector3>;
  uAmbUp: THREE.IUniform<THREE.Vector3>;
  uAmbDown: THREE.IUniform<THREE.Vector3>;
  uSkyLow: THREE.IUniform<THREE.Vector3>;
  uSkyHigh: THREE.IUniform<THREE.Vector3>;
  uHaze: THREE.IUniform<THREE.Vector3>;
  uHazeAmount: THREE.IUniform<number>;
  uLamps: THREE.IUniform<number>;
  uLamp: THREE.IUniform<THREE.Vector3>;
  uStars: THREE.IUniform<number>;
}

const vec = (c: RGB) => new THREE.Vector3(...c);

/**
 * The light every material shares, for one look. Each mounted stage makes its own, so two
 * variants can be up at once (one showing, the next being prepared) without sharing a clock.
 */
export function makeAtriumUniforms(look: AtriumLook): AtriumUniforms {
  return {
    uTime: { value: 0 },
    uBeat: { value: 0 },
    uSunDir: { value: look.sunDir.clone().normalize() },
    uSun: { value: vec(look.sun) },
    uAmbUp: { value: vec(look.ambientUp) },
    uAmbDown: { value: vec(look.ambientDown) },
    uSkyLow: { value: vec(look.skyLow) },
    uSkyHigh: { value: vec(look.skyHigh) },
    uHaze: { value: vec(look.haze) },
    uHazeAmount: { value: look.hazeAmount },
    uLamps: { value: look.lamps },
    uLamp: { value: vec(look.lamp) },
    uStars: { value: look.stars },
  };
}

export interface Atrium {
  look: AtriumLook;
  uniforms: AtriumUniforms;
}

export const AtriumContext = createContext<Atrium | null>(null);

/** The mounted atrium's look and shared uniforms. */
export function useAtrium(): Atrium {
  const atrium = useContext(AtriumContext);
  if (!atrium) throw new Error('useAtrium outside an atrium stage');
  return atrium;
}

// The trees' crowns as soft occluders of the sun: centre (x, y, z) and radius.
const CROWNS = TREES.filter((t) => t.height > 4).map((t) => {
  const c = polar(t.r, t.theta, t.kind === 'palm' ? t.height : t.height * 0.68);
  const r = t.kind === 'palm' ? 3.4 : t.height * 0.36;
  return `vec4(${c.x.toFixed(2)}, ${c.y.toFixed(2)}, ${c.z.toFixed(2)}, ${r.toFixed(2)})`;
});
const CROWNS_GLSL = /* glsl */ `
const int CROWN_COUNT = ${CROWNS.length};
const vec4 CROWNS[${CROWNS.length}] = vec4[](${CROWNS.join(', ')});
`;

/** The shared uniforms' declarations, for shaders that don't take the whole of COMMON. */
export const LOOK_UNIFORMS = /* glsl */ `
uniform float uTime;
uniform float uBeat;
uniform vec3 uSunDir;
uniform vec3 uSun;
uniform vec3 uAmbUp;
uniform vec3 uAmbDown;
uniform vec3 uSkyLow;
uniform vec3 uSkyHigh;
uniform vec3 uHaze;
uniform float uHazeAmount;
uniform float uLamps;
uniform vec3 uLamp;
uniform float uStars;
`;

/**
 * The atrium's light, shared by its shaders: sun through the dome's panes or the glass wall (with
 * the shadows of the ribs, the mullions, the aquarium column and the trees), sky light from
 * above, a soft bounce from the floor, a cheap reflection of the room, and the haze that softens
 * everything far away.
 */
export const COMMON = /* glsl */ `
${LOOK_UNIFORMS}
${LAYOUT_GLSL}
${CROWNS_GLSL}
${hash}
${simplex}

#define SUN uSun
#define HAZE uHaze

// Distance (m) from a plan position to the nearest rib of the dome.
float domeRibDist(vec2 xz) {
  vec2 d = xz - AXIS.xz;
  float r = length(d);
  float a = atan(d.x, d.y);
  float spokes = abs(fract(a / 6.2831853 * 24.0 + 0.5) - 0.5) * 6.2831853 / 24.0 * r;
  float rings = abs(fract(r / 3.4 + 0.5) - 0.5) * 3.4;
  return min(spokes, rings);
}

// 1 in the glass wall's sector (by angle about the axis), 0 elsewhere.
float glassSector(float a) {
  return smoothstep(GLASS_THETA.x, GLASS_THETA.x + 0.08, a) * smoothstep(GLASS_THETA.y + 0.05, GLASS_THETA.y - 0.08, a);
}

// 1 where balconies ring the void (by angle about the axis): not the glass, nor the gap over the camera.
float balconySector(float a) {
  return (1.0 - glassSector(a)) * smoothstep(OPEN_THETA - 0.1, OPEN_THETA + 0.1, abs(a));
}

// The balconies shade the floor underneath them: 0 there, 1 out in the void.
float foreLight(vec3 p) {
  vec2 d = p.xz - AXIS.xz;
  float under = smoothstep(VOID_R - 1.0, VOID_R + 1.5, length(d)) * smoothstep(LEVELS.x - 0.2, LEVELS.x - 1.2, p.y);
  return 1.0 - under * balconySector(atan(d.x, d.y));
}

// Sunlight reaching p: through the dome between its ribs, or through the glass wall between its
// mullions; the column casts a long shadow and the trees' crowns a dappled one.
float sunLight(vec3 p) {
  vec3 s = normalize(uSunDir);
  // Through the dome.
  float t = max(ROOF_Y + 3.0 - p.y, 0.0) / max(s.y, 0.02);
  vec2 q = p.xz + s.xz * t;
  float soft = 0.12 + 0.02 * t;
  float lit = smoothstep(0.16, 0.16 + soft, domeRibDist(q));
  lit *= smoothstep(DOME_R + 0.5, DOME_R - 1.0, length(q - AXIS.xz));
  // Through the glass wall: where the ray leaves the wall's cylinder, below the roof.
  vec2 o = p.xz - AXIS.xz;
  vec2 d = s.xz;
  float a = max(dot(d, d), 1e-5);
  float b = 2.0 * dot(o, d);
  float c = dot(o, o) - GLASS_R * GLASS_R;
  float tw = (-b + sqrt(max(b * b - 4.0 * a * c, 0.0))) / (2.0 * a);
  vec2 hit = o + d * tw;
  float hy = p.y + s.y * tw;
  float ha = atan(hit.x, hit.y);
  float u = ha * GLASS_R;
  float mull = min(abs(fract(u / 4.4 + 0.5) - 0.5) * 4.4, abs(fract(hy / LEVELS.x + 0.5) - 0.5) * LEVELS.x);
  float wall = glassSector(ha) * smoothstep(ROOF_Y - 0.4, ROOF_Y - 1.2, hy) * smoothstep(0.1, 0.1 + 0.12 + 0.015 * tw, mull);
  lit = max(lit, wall) * foreLight(p);
  // The column: does the ray to the sun pass within its radius below its top?
  vec2 sd = normalize(s.xz);
  vec2 rel = AXIS.xz - p.xz;
  float along = dot(rel, sd);
  float miss = length(rel - sd * along);
  float hitY = p.y + along / max(length(s.xz), 1e-3) * s.y;
  lit *= 1.0 - smoothstep(TANK_R + 0.25, TANK_R - 0.15, miss) * step(0.0, along) * step(hitY, TANK_TOP);
  // The trees' crowns: soft, dappled shade.
  for (int i = 0; i < CROWN_COUNT; i++) {
    vec4 cr = CROWNS[i];
    if (p.y > cr.y) continue;
    vec2 at = p.xz + s.xz * (cr.y - p.y) / max(s.y, 0.02);
    float dd = length(at - cr.xz) / cr.w;
    if (dd > 1.1) continue;
    float flecks = smoothstep(0.3, 0.8, sin(at.x * 2.3 + float(i) * 7.0) * sin(at.y * 1.9 - at.x * 0.7) * 0.5 + 0.5);
    lit *= mix(mix(0.25, 0.8, flecks), 1.0, smoothstep(0.55, 1.1, dd));
  }
  return lit;
}

// Sky light from above, bounce from the floor and walls, and the lamps' warm fill.
vec3 ambient(vec3 n) {
  float up = n.y * 0.5 + 0.5;
  return mix(uAmbDown, uAmbUp, up) * 0.9 + uLamp * uLamps * 0.16;
}

// A cheap stand-in for the room in reflections: dome sky above, white tiers and green around, pale floor.
vec3 roomReflect(vec3 r) {
  float a = atan(r.x, r.z);
  float glass = smoothstep(GLASS_THETA.x - 0.1, GLASS_THETA.x + 0.2, a) * smoothstep(GLASS_THETA.y + 0.2, GLASS_THETA.y - 0.2, a);
  vec3 sky = mix(uSkyLow, uSkyHigh, smoothstep(0.1, 0.9, r.y));
  float tierY = fract(r.y * 4.0 + 0.2);
  vec3 white = mix(uAmbUp * 1.6, uLamp * 0.9, uLamps * 0.6);
  vec3 tiers = mix(vec3(0.62, 0.74, 0.52) * (uAmbUp + uSun * 0.25), white, smoothstep(0.35, 0.65, tierY));
  vec3 wall = mix(tiers, sky, glass);
  vec3 col = mix(wall, sky * 1.2, smoothstep(0.35, 0.6, r.y));
  return mix(col, uAmbDown * 1.7, smoothstep(0.0, -0.25, r.y));
}

// Aerial perspective: the air between here and the camera.
vec3 haze(vec3 col, vec3 wp) {
  float d = length(wp - cameraPosition);
  float k = (1.0 - exp(-d * 0.012)) * uHazeAmount;
  k += smoothstep(8.0, 24.0, wp.y) * 0.04;
  return mix(col, HAZE, clamp(k, 0.0, 0.5));
}

// Warm downlights: pools of light on the floor under the balconies and a glow along their fronts.
vec3 lampPools(vec3 w, vec3 n) {
  vec2 d = w.xz - AXIS.xz;
  float r = length(d);
  float a = atan(d.x, d.y);
  float bay = abs(fract(a * DOME_R / 3.2) - 0.5) * 2.0;
  float under = smoothstep(VOID_R - 2.5, VOID_R + 0.5, r) * smoothstep(DOME_R + 1.0, DOME_R - 2.0, r) * balconySector(a);
  float pool = exp(-bay * bay * 3.0) * under * smoothstep(1.0, -0.2, w.y) * max(n.y, 0.0);
  return uLamp * uLamps * (pool * 0.9 + under * 0.12);
}
`;

/** Standard world-space vertex shader: vWorld, vNormal, vUv. */
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

/** Anti-aliased line coverage: 1 within `w` of a line at 0 in x, softened by its pixel width. */
export const AA = /* glsl */ `
float aaLine(float dist, float w) {
  float px = max(fwidth(dist), 1e-4);
  return 1.0 - smoothstep(w - px, w + px, abs(dist));
}
`;

/** Point sizes in buffer pixels: the 480-line buffer's height over the view's height at 1 m. */
export const pointScale = (fov: number): number => 480 / (2 * Math.tan(THREE.MathUtils.degToRad(fov / 2)));
