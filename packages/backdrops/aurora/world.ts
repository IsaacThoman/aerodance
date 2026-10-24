// aurora: a luminous polar night over a mirror lake. Shared clock, layout and GLSL for every
// layer, so one update a frame moves the curtains, the stars and the ripples together.
//
// The lake is a plane at y = 0. What it reflects comes two ways: the sky (gradient, stars,
// shooting stars) is a function of direction that the lake's shader evaluates along its
// rippled reflection ray, and everything with geometry (curtains, mountains, pines, the
// cabin, fireflies) is drawn a second time mirrored below the water, with the ripple at the
// point where its reflection meets the lake bending its pattern the same way.
import type { Vec3 } from '../../stages/catalog.ts';

export const world = {
  uTime: { value: 0 },
};

export const CAMERA: { position: Vec3; target: Vec3; fov: number } = {
  position: [0, 4, 22],
  target: [0, 15, -200],
  fov: 50,
};

/** Where the warm windows of the glass cabin glow (world units), for the lake's glint. */
export const CABIN: { position: Vec3; light: Vec3 } = {
  position: [6, 0, -214],
  light: [6, 6.5, -207],
};

// Linear HDR palette (the pipeline tone maps with ACES afterwards; values above the bloom
// threshold glow).
export const palette = /* glsl */ `
const vec3 SKY_ZENITH = vec3(0.004, 0.010, 0.046);
const vec3 SKY_MID = vec3(0.010, 0.036, 0.120);
const vec3 SKY_HORIZON = vec3(0.030, 0.150, 0.200);
const vec3 AIRGLOW = vec3(0.010, 0.150, 0.090);
const vec3 VEIL = vec3(0.022, 0.008, 0.050);
const vec3 HAZE = vec3(0.030, 0.110, 0.160);
const vec3 WATER = vec3(0.002, 0.010, 0.020);
const vec3 EMERALD = vec3(0.10, 1.00, 0.42);
const vec3 TEAL = vec3(0.04, 0.70, 0.75);
const vec3 VIOLET = vec3(0.42, 0.16, 0.95);
const vec3 WARM = vec3(1.00, 0.55, 0.22);
`;

/**
 * The sky as a function of direction: gradient, a green airglow low over the mountains, a
 * violet veil higher up, two layers of soft twinkling stars and the odd shooting star.
 * Needs `noise` (glsl.ts) and `palette` first, and a `uTime` uniform.
 *
 *   vec3 nightSky(vec3 dir, float pixel)   // pixel: radians a pixel spans, for star size
 */
export const nightSky = /* glsl */ `
vec3 skyGradient(vec3 d) {
  float h = d.y;
  float az = atan(d.x, -d.z);
  vec3 col = mix(SKY_HORIZON, SKY_MID, smoothstep(0.0, 0.24, h));
  col = mix(col, SKY_ZENITH, smoothstep(0.2, 0.8, h));
  // Airglow under the curtains: brighter right of centre, where they hang lowest.
  float band = exp(-max(h, 0.0) * 8.0) * (0.55 + 0.45 * sin(az * 2.2 - 0.2 + uTime * 0.015));
  col += AIRGLOW * band * smoothstep(-0.9, 0.3, az);
  col += VEIL * smoothstep(0.12, 0.5, h) * (0.6 + 0.4 * sin(az * 1.7 - 0.5));
  return col;
}

// One layer of stars on an azimuth / elevation grid: a soft dot at most per cell.
vec3 starLayer(vec2 q, float el, float cell, float density, float pixel, float gain, float seed) {
  vec2 g = q / cell;
  vec2 id = floor(g);
  float pick = hash12(id + seed);
  if (pick > density) return vec3(0.0);
  vec2 rnd = hash22(id * 1.7 + seed);
  vec2 diff = (fract(g) - 0.5 - (rnd - 0.5) * 0.5) * cell;
  diff.x *= cos(el);
  // About a pixel across; spread wider by ripples in the lake, they keep their light, not their peak.
  float sigma = max(pixel, 0.0019) * 0.7;
  float dot2 = dot(diff, diff) / (sigma * sigma);
  float spread = 0.0019 / max(pixel, 0.0019);
  float r = pick / density;
  float twinkle = 0.6 + 0.4 * sin(uTime * (1.1 + 2.6 * rnd.x) + r * 40.0);
  vec3 tint = mix(vec3(0.75, 0.88, 1.0), vec3(1.0, 0.9, 0.78), rnd.x);
  return tint * exp(-0.5 * dot2) * gain * (0.2 + pow(r, 4.0) * 1.2) * twinkle * spread * spread;
}

// A meteor every dozen seconds or so somewhere over the right half of the sky, fading in and out.
vec3 shootingStar(vec2 q, float pixel) {
  const float PERIOD = 13.0;
  float k = floor(uTime / PERIOD);
  float life = fract(uTime / PERIOD) / 0.075;
  if (life > 1.0) return vec3(0.0);
  vec2 rnd = hash22(vec2(k, 7.31));
  vec2 start = vec2(mix(0.02, 0.58, rnd.x), mix(0.3, 0.46, rnd.y));
  vec2 dir = normalize(vec2(rnd.y > 0.5 ? 1.0 : -0.55, -0.42));
  vec2 head = start + dir * 0.2 * life;
  vec2 rel = q - head;
  float along = dot(rel, -dir);
  float across = dot(rel, vec2(-dir.y, dir.x));
  float trail = 0.08 * smoothstep(0.0, 0.35, life);
  float w = pixel * 1.1;
  float tail = 1.0 - smoothstep(0.0, trail, along);
  float streak = exp(-across * across / (w * w)) * smoothstep(-w, 0.0, along) * tail * tail;
  return vec3(0.75, 1.0, 0.92) * streak * sin(3.14159 * life) * 3.0;
}

vec3 nightSky(vec3 d, float pixel) {
  vec3 col = skyGradient(d);
  float el = asin(clamp(d.y, -1.0, 1.0));
  vec2 q = vec2(atan(d.x, -d.z), el);
  float above = smoothstep(0.0, 0.14, el);
  vec3 stars = starLayer(q, el, 0.02, 0.16, pixel, 0.5, 3.0) + starLayer(q, el, 0.055, 0.3, pixel * 1.25, 1.5, 11.0);
  col += (stars + shootingStar(q, pixel)) * above;
  return col;
}
`;

/**
 * Gentle ripples: the slope (dh/dx, dh/dz) of a few slow waves on the lake at p. Each wave
 * flattens where it would pack more than a cycle into a few pixels, so the distance stays a
 * calm mirror instead of shimmering. Needs `simplex` and a `uTime` uniform.
 */
export const ripple = /* glsl */ `
vec2 rippleWave(vec2 p, vec2 dir, float len, float speed, float slope) {
  float k = 6.2831853 / len;
  float phase = (dot(p, dir) - uTime * speed) * k;
  float cycles = fwidth(dot(p, dir)) / len;
  return dir * cos(phase) * slope * (1.0 - smoothstep(0.08, 0.3, cycles));
}

vec2 rippleSlope(vec2 p) {
  vec2 warp = vec2(snoise(p * 0.03 + vec2(0.0, uTime * 0.02)), snoise(p * 0.03 + vec2(5.2, -uTime * 0.017)));
  vec2 q = p + warp * 4.0;
  vec2 s = rippleWave(q, vec2(0.28, 0.96), 7.0, 0.7, 0.0055);
  s += rippleWave(q, vec2(-0.6, 0.8), 3.9, 0.55, 0.0045);
  s += rippleWave(q, vec2(0.9, 0.44), 2.3, 0.45, 0.0035);
  s += rippleWave(q, vec2(-0.2, -0.98), 1.3, 0.35, 0.0028);
  return s;
}

// Where the line from the eye to a mirrored point crosses the lake.
vec3 waterHit(vec3 mirrored) {
  float k = cameraPosition.y / max(cameraPosition.y - mirrored.y, 1e-3);
  return cameraPosition + (mirrored - cameraPosition) * k;
}
`;
