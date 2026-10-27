import * as THREE from 'three';
import { hash, simplex } from '../shared/glsl.ts';
import { LAYOUT_GLSL, SUN_DIR, TREES, polar } from './layout.ts';

/**
 * The uniforms every material of one atrium shares, so one write a frame moves them all. Each
 * scene that shows the atrium (the menu's backdrop, the dance stage) makes its own and drives
 * uTime from its own clock: the two can be mounted at once.
 */
export interface AtriumUniforms {
  uTime: THREE.IUniform<number>;
  uSunDir: THREE.IUniform<THREE.Vector3>;
  /** 1 shades the floor nearest the menu's camera, which frames the menu better; 0 leaves it in the sun. */
  uForeShade: THREE.IUniform<number>;
  /** Point sprites' scale: the 640x480 buffer's height over the view's height 1 m away. */
  uPointScale: THREE.IUniform<number>;
  /** The music (shared/hooks.ts's beat; still in the menu): 1 on the beat, decaying quickly. */
  uBeat: THREE.IUniform<number>;
  /** 0..1 through the beat. */
  uBeatPhase: THREE.IUniform<number>;
}

export interface AtriumOptions {
  /** The camera's vertical field of view at 16:9, in degrees. */
  fov: number;
  foreShade: number;
}

export function makeAtriumUniforms({ fov, foreShade }: AtriumOptions): AtriumUniforms {
  return {
    uTime: { value: 0 },
    uSunDir: { value: SUN_DIR.clone() },
    uForeShade: { value: foreShade },
    uPointScale: { value: 480 / (2 * Math.tan(THREE.MathUtils.degToRad(fov / 2))) },
    uBeat: { value: 0 },
    uBeatPhase: { value: 0 },
  };
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

/**
 * The atrium's light, shared by its shaders: sun through the dome's panes (with the shadows of
 * its ribs and of the aquarium column), sky light from above, a soft bounce from the floor, a
 * cheap reflection of the room, and the sunlit haze that softens everything far away.
 */
export const COMMON = /* glsl */ `
uniform float uTime;
uniform vec3 uSunDir;
uniform float uForeShade;
${LAYOUT_GLSL}
${CROWNS_GLSL}
${hash}
${simplex}

const vec3 SUN = vec3(1.0, 0.95, 0.86) * 2.0;
const vec3 HAZE = vec3(0.84, 0.93, 1.0);

// Distance (m) from a plan position to the nearest rib of the dome.
float domeRibDist(vec2 xz) {
  vec2 d = xz - AXIS.xz;
  float r = length(d);
  float a = atan(d.x, d.y);
  float spokes = abs(fract(a / 6.2831853 * 24.0 + 0.5) - 0.5) * 6.2831853 / 24.0 * r;
  float rings = abs(fract(r / 3.4 + 0.5) - 0.5) * 3.4;
  return min(spokes, rings);
}

// With uForeShade, the balcony behind the menu's camera shades the near floor: 0 there, 1 elsewhere.
float foreLight(vec3 p) {
  return 1.0 - uForeShade * smoothstep(2.5, 7.5, p.z - AXIS.z) * smoothstep(4.5, 2.5, p.y);
}

// Sunlight reaching p: the dome's ribs cast soft bars, and the column a long shadow.
float sunLight(vec3 p) {
  vec3 s = normalize(uSunDir);
  float t = max(ROOF_Y + 3.0 - p.y, 0.0) / s.y;
  vec2 q = p.xz + s.xz * t;
  float soft = 0.12 + 0.02 * t;
  float lit = smoothstep(0.16, 0.16 + soft, domeRibDist(q)) * foreLight(p);
  // Under the ring beam and past it the roof is solid.
  lit *= smoothstep(DOME_R + 0.5, DOME_R - 1.0, length(q - AXIS.xz));
  // The column: does the ray to the sun pass within its radius below its top?
  vec2 sd = normalize(s.xz);
  vec2 rel = AXIS.xz - p.xz;
  float along = dot(rel, sd);
  float miss = length(rel - sd * along);
  float hitY = p.y + along / length(s.xz) * s.y;
  lit *= 1.0 - smoothstep(TANK_R + 0.25, TANK_R - 0.15, miss) * step(0.0, along) * step(hitY, TANK_TOP);
  // The trees' crowns: soft, dappled shade.
  for (int i = 0; i < CROWN_COUNT; i++) {
    vec4 c = CROWNS[i];
    if (p.y > c.y) continue;
    vec2 at = p.xz + s.xz * (c.y - p.y) / s.y;
    float d = length(at - c.xz) / c.w;
    if (d > 1.1) continue;
    float flecks = smoothstep(0.3, 0.8, sin(at.x * 2.3 + float(i) * 7.0) * sin(at.y * 1.9 - at.x * 0.7) * 0.5 + 0.5);
    lit *= mix(mix(0.25, 0.8, flecks), 1.0, smoothstep(0.55, 1.1, d));
  }
  return lit;
}

// Sky light from above, white bounce from the floor and walls.
vec3 ambient(vec3 n) {
  float up = n.y * 0.5 + 0.5;
  return mix(vec3(0.5, 0.54, 0.5), vec3(0.6, 0.74, 0.92), up) * 0.9;
}

// A cheap stand-in for the room in reflections: dome sky above, white tiers and green around, pale floor.
vec3 roomReflect(vec3 r) {
  float a = atan(r.x, r.z);
  float glass = smoothstep(GLASS_THETA.x - 0.1, GLASS_THETA.x + 0.2, a) * smoothstep(GLASS_THETA.y + 0.2, GLASS_THETA.y - 0.2, a);
  vec3 sky = mix(vec3(0.9, 1.0, 1.1), vec3(0.35, 0.68, 1.05), smoothstep(0.1, 0.9, r.y));
  vec3 tiers = mix(vec3(0.62, 0.74, 0.52), vec3(1.0, 1.02, 1.04), smoothstep(0.35, 0.65, fract(r.y * 4.0 + 0.2)));
  vec3 wall = mix(tiers, sky, glass);
  vec3 col = mix(wall, sky * 1.2, smoothstep(0.35, 0.6, r.y));
  return mix(col, vec3(0.8, 0.8, 0.76), smoothstep(0.0, -0.25, r.y));
}

// Aerial perspective: the sunlit air between here and the camera.
vec3 haze(vec3 col, vec3 wp) {
  float d = length(wp - cameraPosition);
  float k = (1.0 - exp(-d * 0.012)) * 0.28;
  k += smoothstep(8.0, 24.0, wp.y) * 0.04;
  return mix(col, HAZE, clamp(k, 0.0, 0.5));
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
