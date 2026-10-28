import { useLayoutEffect } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { shaderMaterial } from '../shared/glsl.ts';
import { PADS, shoreDistance, stagePadDistance } from './layout.ts';
import { MAP_RECT, PAD_RANGE, SHORE_RANGE, pondCommonGLSL } from './shaders.ts';
import type { PondUniforms } from './shaders.ts';

// ---------------------------------------------------------------------------
// Everything about the pond that never moves is worked out once, when it loads, so the frames
// only pay for what does: the pebble bed baked into a mipmapped texture, a tiling texture of
// caustic cells and noise, and the distance fields of the pads and the shore.
// ---------------------------------------------------------------------------

/** Floor texels: about 3 cm of pond each, as fine as the near bed gets on screen. */
const FLOOR_SIZE = [1536, 1696] as const;
const DETAIL_SIZE = 512;
/** Cells (and noise lattice) across the detail texture, which tiles. */
const DETAIL_CELLS = 16;
const FIELD_SIZE = [384, 424] as const;

const bakeVertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const floorBakeFragment = /* glsl */ `
${pondCommonGLSL}
uniform vec4 uRect;
uniform float uTexel;
uniform sampler2D uFields;
varying vec2 vUv;

// Smooth river pebbles: one rounded, randomly turned stone per cell of a jittered grid, the
// tallest winning where they overlap, on coarse sand. Returns the albedo; n is the stone's dome
// normal, ao the shading where it meets the sand.
vec3 pebbles(vec2 p, float px, float density, out vec3 n, out float ao) {
  vec2 sp = p * 2.1;
  // A gentle warp so the stones don't line up.
  sp += 0.2 * vec2(sin(sp.y * 0.83 + sin(sp.x * 0.47)), sin(sp.x * 0.77 + 1.3 + sin(sp.y * 0.53)));
  vec2 i = floor(sp);
  vec2 fr = fract(sp);
  float best = -1.0;
  float bestE = 2.0;
  vec2 bestDir = vec2(0.0);
  vec2 cell = vec2(0.0);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 hc = hash22(i + g);
      vec2 hs = hash22(i + g + 31.7);
      if (hash12(i + g + 5.3) > density) continue;
      vec2 r = fr - (g + 0.15 + 0.7 * hc);
      float a = hs.x * 3.1416;
      vec2 q = mat2(cos(a), -sin(a), sin(a), cos(a)) * r;
      vec2 rad = vec2(0.42 + 0.2 * hs.y, 0.32 + 0.14 * hc.x);
      float e = length(q / rad);
      // Dome height, offset per stone so overlaps stack.
      float h = sqrt(max(1.0 - e * e, 0.0)) * (0.7 + 0.3 * hs.y);
      if (e < 1.0 && h > best) { best = h; bestE = e; bestDir = r / max(length(r), 1e-4); cell = i + g; }
    }
  }
  float aa = px * 2.1 * 1.5;
  float inside = 1.0 - smoothstep(1.0 - 0.08 - aa, 1.0, bestE);
  float slope = bestE / (sqrt(max(1.0 - bestE * bestE, 0.0)) + 0.45) * 0.6;
  n = normalize(vec3(bestDir.x * slope * inside, 1.0, bestDir.y * slope * inside));
  ao = mix(0.65, 1.0, smoothstep(0.0, 0.5, best));
  float h = hash12(cell);
  float h2 = hash12(cell + 17.3);
  vec3 stone;
  if (h < 0.26) stone = vec3(0.6, 0.47, 0.32);
  else if (h < 0.48) stone = vec3(0.46, 0.46, 0.43);
  else if (h < 0.6) stone = vec3(0.2, 0.23, 0.25);
  else if (h < 0.82) stone = vec3(0.72, 0.65, 0.53);
  else if (h < 0.92) stone = vec3(0.36, 0.44, 0.34);
  else stone = vec3(0.62, 0.36, 0.26);
  stone *= 0.8 + 0.35 * h2;
  // Each stone a little lighter on one side.
  stone *= 0.94 + 0.14 * bestE * dot(bestDir, vec2(cos(h * 40.0), sin(h * 40.0)));
  vec3 sand = vec3(0.3, 0.27, 0.2);
  return mix(sand, stone, inside);
}

void main() {
  vec2 p = uRect.xy + vUv * uRect.zw;
  float shore = mix(${SHORE_RANGE[0].toFixed(1)}, ${SHORE_RANGE[1].toFixed(1)}, texture2D(uFields, vUv).g);
  // Pebbles bank up along the shore and thin out into sandy patches in the open water.
  float density = 0.6 + 0.4 * snoise(p * 0.11 + 4.2) + 0.45 * smoothstep(-6.0, -1.0, shore);
  vec3 n;
  float ao;
  vec3 albedo = pebbles(p, uTexel, density, n, ao);
  // Darker silt and soft green moss lying in drifts.
  albedo *= 0.6 + 0.4 * smoothstep(-0.5, 0.6, snoise(p * 0.085 + 1.7));
  float moss = smoothstep(0.05, 0.75, snoise(p * 0.16 + 5.0));
  albedo = mix(albedo, vec3(0.16, 0.3, 0.08), moss * 0.65 * smoothstep(0.4, 0.9, n.y));
  // Square-rooted, so the darks keep their precision in eight bits.
  gl_FragColor = vec4(sqrt(albedo * ao), max(dot(n, uSunW), 0.0));
}
`;

const detailBakeFragment = /* glsl */ `
${pondCommonGLSL}
varying vec2 vUv;
const float CELLS = ${DETAIL_CELLS.toFixed(1)};

// Value noise on a lattice that wraps every \`period\` cells.
float tiledNoise(vec2 p, float period, float seed) {
  vec2 i = floor(p);
  vec2 fr = fract(p);
  vec2 u = fr * fr * (3.0 - 2.0 * fr);
  float a = hash12(mod(i, period) + seed);
  float b = hash12(mod(i + vec2(1.0, 0.0), period) + seed);
  float c = hash12(mod(i + vec2(0.0, 1.0), period) + seed);
  float d = hash12(mod(i + vec2(1.0, 1.0), period) + seed);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Gradient (Perlin) noise on a lattice that wraps every \`period\` cells, about -0.7..0.7: crisper
// than value noise, for the surface's glittering chop.
float tiledGradient(vec2 p, float period, float seed) {
  vec2 i = floor(p);
  vec2 fr = fract(p);
  vec2 u = fr * fr * fr * (fr * (fr * 6.0 - 15.0) + 10.0);
  float n[4];
  for (int k = 0; k < 4; k++) {
    vec2 o = vec2(float(k - (k / 2) * 2), float(k / 2));
    float a = hash12(mod(i + o, period) + seed) * 6.2831853;
    n[k] = dot(vec2(cos(a), sin(a)), fr - o);
  }
  return mix(mix(n[0], n[1], u.x), mix(n[2], n[3], u.x), u.y);
}

void main() {
  vec2 p = vUv * CELLS;
  // Distance between the two nearest of a wrapping grid of scattered points: small along the
  // borders between cells, which the caustics draw as lines of light. Stored as the lines
  // themselves, which filter (and mipmap) without dimming.
  vec2 i = floor(p);
  vec2 fr = fract(p);
  float d1 = 8.0;
  float d2 = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 o = 0.5 + 0.42 * sin(6.2831 * hash22(mod(i + g, CELLS)));
      float d = length(g + o - fr);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
    }
  }
  float lines = exp(-(d2 - d1) * 7.0);
  // Two octaves of chop, each wrapping.
  float chopA = tiledGradient(p, CELLS, 17.0) * 0.7 + tiledGradient(p * 2.0, CELLS * 2.0, 29.0) * 0.3;
  float chopB = tiledGradient(p, CELLS, 37.0) * 0.7 + tiledGradient(p * 2.0, CELLS * 2.0, 43.0) * 0.3;
  float clouds = tiledNoise(p * 0.5, CELLS * 0.5, 61.0) * 0.62 + tiledNoise(p * 1.1, CELLS * 1.1, 83.0) * 0.38;
  gl_FragColor = vec4(lines, chopA * 0.6 + 0.5, chopB * 0.6 + 0.5, clouds);
}
`;

/** r: signed distance from each texel to the nearest pad's rim (negative inside a pad); g: its distance from the shore. */
function fields(): THREE.DataTexture {
  const [w, h] = FIELD_SIZE;
  const data = new Uint8Array(w * h * 2);
  const store = (v: number, [lo, hi]: readonly [number, number]) => Math.round(THREE.MathUtils.clamp((v - lo) / (hi - lo), 0, 1) * 255);
  for (let j = 0; j < h; j++) {
    const z = MAP_RECT.min[1] + ((j + 0.5) / h) * MAP_RECT.size[1];
    for (let i = 0; i < w; i++) {
      const x = MAP_RECT.min[0] + ((i + 0.5) / w) * MAP_RECT.size[0];
      let d = stagePadDistance(x, z);
      for (const pad of PADS) d = Math.min(d, Math.hypot(x - pad.at[0], z - pad.at[1]) - pad.radius);
      data[(j * w + i) * 2] = store(d, PAD_RANGE);
      data[(j * w + i) * 2 + 1] = store(shoreDistance(x, z), SHORE_RANGE);
    }
  }
  const texture = new THREE.DataTexture(data, w, h, THREE.RGFormat, THREE.UnsignedByteType);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** Draws a full-screen pass of `material` into `target`, once. */
function bake(gl: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget, material: THREE.ShaderMaterial): void {
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  const scene = new THREE.Scene().add(quad);
  const previous = gl.getRenderTarget();
  gl.setRenderTarget(target);
  gl.render(scene, new THREE.OrthographicCamera());
  gl.setRenderTarget(previous);
  quad.geometry.dispose();
  material.dispose();
}

/**
 * Bakes the pond's maps and hands them to the shared uniforms, before the first frame. Made,
 * baked and disposed of together in one effect, so a remount never leaves a disposed (empty)
 * map behind.
 */
export function usePondMaps(shared: PondUniforms): void {
  const gl = useThree((s) => s.gl);
  useLayoutEffect(() => {
    const floor = new THREE.WebGLRenderTarget(FLOOR_SIZE[0], FLOOR_SIZE[1], {
      depthBuffer: false,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
    });
    const detail = new THREE.WebGLRenderTarget(DETAIL_SIZE, DETAIL_SIZE, {
      depthBuffer: false,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
    });
    const field = fields();
    const rect = new THREE.Vector4(MAP_RECT.min[0], MAP_RECT.min[1], MAP_RECT.size[0], MAP_RECT.size[1]);
    bake(gl, floor, shaderMaterial({
      uniforms: { ...shared, uFields: { value: field }, uRect: { value: rect }, uTexel: { value: MAP_RECT.size[0] / FLOOR_SIZE[0] } },
      vertexShader: bakeVertex,
      fragmentShader: floorBakeFragment,
    }));
    bake(gl, detail, shaderMaterial({ uniforms: { ...shared }, vertexShader: bakeVertex, fragmentShader: detailBakeFragment }));
    shared.uFloorMap.value = floor.texture;
    shared.uDetailMap.value = detail.texture;
    shared.uFields.value = field;
    return () => {
      shared.uFloorMap.value = null;
      shared.uDetailMap.value = null;
      shared.uFields.value = null;
      floor.dispose();
      detail.dispose();
      field.dispose();
    };
  }, [gl, shared]);
}
