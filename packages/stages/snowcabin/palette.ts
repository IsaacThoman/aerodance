import * as THREE from 'three';
import type { Vec3 } from '../catalog.ts';
import { polar } from '../polar/world.ts';
import { CABIN, CABIN_INVERSE, DECK_LANTERNS, LANTERN_POSTS, cabinPoint } from './layout.ts';
import { landHeight } from './terrain.ts';

// The warm side of the picture: the glass gable's glow, the light it throws through its panes
// onto the snow, and the lanterns. They're worked out in the shaders (warmth below) rather than
// as three.js lights, so every surface gets them for the price of a few lines, and the moon and
// the aurora stay the only "real" lights.

/** A lantern's height above the foot of its post. */
export const LANTERN_HEIGHT = 2.25;

/** Every lantern's flame. */
export const LANTERNS: readonly Vec3[] = [
  ...LANTERN_POSTS.map(([x, z]): Vec3 => [x, landHeight(x, z) + LANTERN_HEIGHT, z]),
  ...DECK_LANTERNS.map(([x, z]) => cabinPoint(x, CABIN.floor + 1.32, z)),
];

// Uniforms shared by the stage's shaders, updated once a frame by the stage clock.
export const snowcabin = {
  uTime: polar.uTime,
  uNoise: polar.uNoise,
  uBeat: { value: 0 },
  /** World to cabin space. */
  uCabin: { value: CABIN_INVERSE.clone() },
  /** xyz: a lantern's flame; w: its flickering brightness. */
  uLanterns: { value: LANTERNS.map(([x, y, z]) => new THREE.Vector4(x, y, z, 1)) },
  /** The fire inside, flickering. */
  uFire: { value: 1 },
};

/**
 * The gable's glazing in cabin space (x across, y up): 1 in a pane, 0 on its frame and glazing
 * bars or outside it, softened over `aa`. Shared by the glass and by the light it casts.
 */
export const panes = /* glsl */ `
const float CABIN_FLOOR = ${CABIN.floor.toFixed(2)};
const float CABIN_HALF = ${CABIN.halfWidth.toFixed(2)};
const float CABIN_HEIGHT = ${CABIN.height.toFixed(2)};
float bar(float d, float width, float aa) { return smoothstep(width - aa, width + aa, abs(d)); }
float paneMask(vec2 g, float aa) {
  float y = g.y - CABIN_FLOOR;
  // Distance inside the triangle, along its sloping sides and above the floor.
  float side = (CABIN_HALF * (1.0 - y / CABIN_HEIGHT) - abs(g.x)) * 0.86;
  float inside = min(side, y);
  float m = smoothstep(0.2 - aa, 0.2 + aa, inside);
  // Mullions, the door head and the loft beam.
  m *= bar(fract(g.x / 1.4 + 0.5) - 0.5, 0.05, aa / 1.4);
  m *= bar(y - 2.55, 0.09, aa) * bar(y - 5.1, 0.11, aa);
  return m;
}
`;

/**
 * Warm light at a point p with normal n (both world space): the lanterns, the glow spilling from
 * the glass, and the panes cast across the snow by the lamp inside. Needs \`panes\`.
 */
export const warmth = /* glsl */ `
uniform mat4 uCabin;
uniform vec4 uLanterns[${LANTERNS.length}];
uniform float uFire;
const vec3 LANTERN = vec3(1.0, 0.56, 0.22);
const vec3 HEARTH = vec3(1.0, 0.6, 0.28);

vec3 lanternLight(vec3 p, vec3 n) {
  float sum = 0.0;
  for (int i = 0; i < ${LANTERNS.length}; i++) {
    vec3 d = uLanterns[i].xyz - p;
    float d2 = dot(d, d);
    float facing = max(dot(n, d) * inversesqrt(d2 + 1e-4), 0.0) * 0.75 + 0.25;
    // A bright pool that fades out within a few units, so the snow between stays moonlit.
    sum += uLanterns[i].w * facing * 7.0 / (1.0 + d2 * 1.1) * (1.0 - smoothstep(9.0, 36.0, d2));
  }
  return LANTERN * sum;
}

vec3 windowLight(vec3 p, vec3 n) {
  vec3 q = (uCabin * vec4(p, 1.0)).xyz;
  vec3 m = mat3(uCabin) * n;
  if (q.z < 0.05) return vec3(0.0);
  // A broad glow from the whole glass, strongest straight out in front of it.
  vec3 toGlass = vec3(0.0, CABIN_FLOOR + 3.0, -1.5) - q;
  float d2 = dot(toGlass, toGlass);
  float spill = (max(dot(m, toGlass) * inversesqrt(d2), 0.0) * 0.7 + 0.3) * 45.0 / (5.0 + d2) * smoothstep(0.0, 1.5, q.z);
  // The panes thrown onto whatever faces the lamp inside, stretching away from the cabin.
  vec3 lamp = vec3(0.0, CABIN_FLOOR + 4.4, -4.5);
  vec3 ray = q - lamp;
  vec2 g = lamp.xy + ray.xy * (-lamp.z / ray.z);
  float r2 = dot(ray, ray);
  float through = paneMask(g, 0.02 * sqrt(r2)) * max(dot(m, -ray) * inversesqrt(r2), 0.0) * 320.0 / (14.0 + r2 * 1.2);
  return HEARTH * (spill + through) * uFire;
}

vec3 warmth(vec3 p, vec3 n) {
  return lanternLight(p, n) + windowLight(p, n);
}
`;

/**
 * Sparkles in snow: in a few of the cells of a fine world-space grid a crystal catches the light
 * and flashes as the view moves past its angle, or now and then on its own. They fade out with
 * distance before they'd shimmer. Needs `hash`.
 */
export const sparkle = /* glsl */ `
float glint(vec3 p, vec3 n, vec3 view, float density) {
  vec3 a = abs(n);
  vec2 uv = (a.y > max(a.x, a.z) ? p.xz : a.x > a.z ? p.zy : p.xy) * 9.0;
  vec2 id = floor(uv);
  float h = hash12(id);
  if (h > density) return 0.0;
  vec2 rnd = hash22(id + 17.0);
  vec2 d = fract(uv) - 0.2 - rnd * 0.6;
  float px = length(fwidth(uv));
  float r = max(0.09, px * 0.6);
  float spot = exp(-dot(d, d) / (r * r)) * (0.09 * 0.09) / (r * r);
  float phase = dot(view, vec3(rnd.x - 0.5, 0.3, rnd.y - 0.5)) * 70.0 + uTime * (0.4 + rnd.x * 1.2) + h * 60.0;
  float flash = pow(max(sin(phase), 0.0), 10.0);
  return spot * flash * (1.0 - smoothstep(0.35, 0.9, px));
}
`;

/** Distance haze into the kit's horizon colour, clear near the dancers. Needs `palette`. */
export const haze = /* glsl */ `
vec3 fieldHaze(vec3 col, vec3 p) {
  float d = length(p - cameraPosition);
  float k = 1.0 - exp(-max(d - 18.0, 0.0) * 0.0045);
  return mix(col, HAZE * 1.3, clamp(k, 0.0, 0.85));
}
`;
