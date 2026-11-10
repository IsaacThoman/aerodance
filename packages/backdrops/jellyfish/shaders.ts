import * as THREE from 'three';
import { RENDER_HEIGHT, RENDER_WIDTH } from '../../stages/shared/post.tsx';

/**
 * One uniform object per frame-updated value, referenced by every material so a single write
 * per frame updates them all.
 */
export function makeShared() {
  return {
    uTime: { value: 0 },
    // Half the render buffer, in pixels: ribbons are widened in screen space.
    uHalfRes: { value: new THREE.Vector2(RENDER_WIDTH / 2, RENDER_HEIGHT / 2) },
    // Towards the sun, far above the surface.
    uSun: { value: new THREE.Vector3(0.32, 1, -0.42).normalize() },
  };
}

export type SharedUniforms = ReturnType<typeof makeShared>;

/** Hues a jelly can glow in, round a loop: cyan, pink, violet. */
export const paletteGLSL = /* glsl */ `
vec3 jellyPal(float h) {
  h = fract(h);
  vec3 cyan = vec3(0.12, 0.85, 1.0);
  vec3 pink = vec3(1.0, 0.22, 0.66);
  vec3 violet = vec3(0.52, 0.26, 1.0);
  return h < 0.333 ? mix(cyan, pink, smoothstep(0.0, 0.333, h))
    : h < 0.667 ? mix(pink, violet, smoothstep(0.333, 0.667, h))
    : mix(violet, cyan, smoothstep(0.667, 1.0, h));
}
`;

/**
 * Where a jelly is and how its bell is squeezing at a given time, from its instance data:
 *   aJ0: anchor x, y, z; seed (0..1)
 *   aJ1: bell radius; hue; rise speed (units/s, 0: bobs in place); pulse period (s)
 *   aJ2: wrap bottom; wrap span (0: never wraps); lean (rad, + leans the top right); roam (units)
 *   aJ3: bell height (1: a full dome); tip towards the camera (rad); gonad glow; spare
 * Tentacles sample it at earlier times, so they trail the bell and the squeeze runs down them.
 */
export const jellyMotionGLSL = /* glsl */ `
uniform float uTime;
attribute vec4 aJ0;
attribute vec4 aJ1;
attribute vec4 aJ2;
attribute vec4 aJ3;

float jellyPhase(float t) { return fract(t / aJ1.w + aJ0.w * 7.0); }
// The bell squeezes quickly, then relaxes slowly.
float jellySqueeze(float ph) { return smoothstep(0.0, 0.24, ph) * (1.0 - smoothstep(0.24, 0.95, ph)); }
// Each squeeze lifts it, and it sinks slowly until the next: periodic, so one that doesn't
// drift bobs in place.
float jellyLift(float ph) { return smoothstep(0.02, 0.42, ph) - ph; }

mat3 jellyBasis(float t) {
  float s = aJ0.w * 6.2831853;
  float lean = aJ2.z + 0.09 * sin(t * 0.13 + s);
  // The apex tipped towards the camera below, showing the dome in profile (or a flat bell's top).
  float tip = aJ3.y + 0.08 * sin(t * 0.1 + s * 3.0);
  float cz = cos(lean), sz = sin(lean), cx = cos(tip), sx = sin(tip);
  mat3 rz = mat3(cz, -sz, 0.0, sz, cz, 0.0, 0.0, 0.0, 1.0);
  mat3 rx = mat3(1.0, 0.0, 0.0, 0.0, cx, sx, 0.0, -sx, cx);
  return rz * rx;
}

// The bell's centre before wrapping.
vec3 jellyCenter(float t) {
  float s = aJ0.w * 6.2831853;
  vec3 c = aJ0.xyz;
  c += vec3(
    sin(t * 0.043 + s) + 0.35 * sin(t * 0.11 + s * 2.0),
    0.6 * sin(t * 0.057 + s * 1.7),
    0.5 * cos(t * 0.037 + s)
  ) * aJ2.w;
  c.y += t * aJ1.z;
  c += jellyBasis(t)[1] * jellyLift(jellyPhase(t)) * aJ1.x * 0.3;
  return c;
}

// How far a drifting jelly is moved down to stay in its span: changes only while it (and its
// tentacles) are out of sight, and is the same for every point of it.
float jellyWrap(float t) {
  if (aJ2.y <= 0.0) return 0.0;
  return -aJ2.y * floor((aJ0.y + t * aJ1.z - aJ2.x) / aJ2.y);
}

// Fades a jelly into the water with distance (premultiplied: it just dims), and out at the ends
// of its span, which are out of sight anyway.
float jellyFade(vec3 c) {
  float d = length(cameraPosition - c);
  float f = exp(-max(d - 14.0, 0.0) * 0.055);
  if (aJ2.y > 0.0) f *= smoothstep(aJ2.x, aJ2.x + 1.0, c.y) * smoothstep(aJ2.x + aJ2.y, aJ2.x + aJ2.y - 1.0, c.y);
  return f;
}

// A point of the bell, radius 1: s = 0 at the apex to 1 at the scalloped margin; a round the axis.
vec3 bellPoint(float s, float a, float squeeze) {
  float rim = smoothstep(0.7, 1.0, s);
  float phi = s * 1.5707963;
  // Full shoulders, smooth at the apex.
  float r = sin(phi) * (1.0 + 0.12 * sin(phi * 2.0)) + 0.04 * rim;
  float y = 0.86 * aJ3.x * cos(phi) - 0.08 * rim;
  float lap = 0.5 + 0.5 * cos(a * 16.0);
  r *= 1.0 + 0.04 * (lap - 0.5) * rim;
  y -= 0.05 * lap * rim;
  // The squeeze draws the margin in and pushes the dome up.
  r *= 1.0 - 0.22 * squeeze * smoothstep(0.15, 1.0, s);
  y += 0.14 * squeeze * (1.0 - s * s);
  return vec3(cos(a) * r, y, sin(a) * r);
}
`;
