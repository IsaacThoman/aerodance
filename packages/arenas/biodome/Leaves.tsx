import * as THREE from 'three';
import { useDisposable } from '../../stages/shared/hooks.ts';
import { shaderMaterial } from '../../stages/shared/glsl.ts';
import { LIGHT, fx, instanced } from './shading.ts';

// Leaves as instanced cards, shaped in the vertex shader: each arches out from its base along
// a curve, folded at the midrib, on a stalk, swaying; the fragment shader cuts its outline's
// detail (a monstera's holes, a banana's tears, the leaflets of palm and fern fronds) and
// shades it glossy, with sunlight glowing through from behind.

export const LEAF = { broad: 0, monstera: 1, banana: 2, palm: 3, fern: 4, strap: 5 } as const;
export type LeafType = (typeof LEAF)[keyof typeof LEAF];

export interface LeafSpec {
  /** Where the stalk starts. */
  x: number;
  y: number;
  z: number;
  /** Stalk and blade together, metres. */
  length: number;
  /** The blade's width as a share of the length. */
  width: number;
  /** Heading (radians; 0 = +z) and how steeply it leaves the base (radians up from level). */
  yaw: number;
  pitch: number;
  roll?: number;
  type: LeafType;
  /** 0..1 colour variation (for strap leaves, above 0.8 is a red bract). */
  tone: number;
  /** How far it arches over along its length, radians. */
  bend: number;
  seed: number;
  /** The share of the length that's bare stalk. */
  stalk?: number;
  /** Folded up at the midrib (negative: drooping leaflets). */
  fold?: number;
  /** How much it sways. */
  sway?: number;
  /** The edges curling under. */
  curl?: number;
}

const LEAF_VERTEX = /* glsl */ `
attribute vec4 aPos;
attribute vec4 aOrient;
attribute vec4 aShape;
attribute vec4 aExtra;
uniform float uTime;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vLeaf;
varying vec4 vShape;
varying float vStalk;

float halfWidth(float type, float b) {
  if (type < 0.5) return pow(sin(3.14159 * pow(b, 0.7)), 0.75);
  if (type < 1.5) return pow(sin(3.14159 * pow(b, 0.82)), 0.55);
  if (type < 2.5) return min(1.0, b * 9.0) * sqrt(max(1.0 - pow(b, 5.0), 0.0));
  if (type < 3.5) return 0.15 + 0.85 * pow(sin(3.14159 * (0.12 + 0.88 * b)), 0.7);
  if (type < 4.5) return pow(sin(3.14159 * b), 0.7) * (1.0 - 0.35 * b) + 0.05;
  return min(1.0, b * 10.0) * (1.0 - b * b * b);
}

void main() {
  float u = position.x;
  float s = position.y;
  float L = aPos.w;
  float stalk = aExtra.x;
  float type = aShape.x;
  float b = clamp((s - stalk) / max(1.0 - stalk, 1e-3), 0.0, 1.0);
  float hw = s < stalk ? 0.014 / max(aOrient.w * L, 0.01) : halfWidth(type, b);
  float sway = aExtra.z;
  float ph = aShape.w * 6.2831 + aPos.x * 0.21 + aPos.z * 0.17;
  float t = uTime;
  float yaw = aOrient.x + (sin(t * 0.7 + ph) * 0.6 + sin(t * 1.9 + ph * 2.1) * 0.4) * 0.06 * sway;
  float pitch = aOrient.y + sin(t * 1.1 + ph * 1.3) * 0.05 * sway;
  float k = max(aShape.z + sin(t * 1.6 + ph * 0.7) * 0.08 * sway, 1e-3);
  float th = pitch - k * s;
  float fwd = (sin(pitch) - sin(th)) / k;
  float up = (cos(th) - cos(pitch)) / k;
  vec3 F = vec3(sin(yaw), 0.0, cos(yaw));
  vec3 R = vec3(cos(yaw), 0.0, -sin(yaw));
  vec3 U = vec3(0.0, 1.0, 0.0);
  vec3 N = U * cos(th) - F * sin(th);
  float roll = aOrient.z;
  vec3 R2 = R * cos(roll) + N * sin(roll);
  vec3 N2 = N * cos(roll) - R * sin(roll);
  float fold = aExtra.y;
  float curl = aExtra.w;
  float wid = hw * aOrient.w * L;
  float au = abs(u);
  vec3 p = aPos.xyz + (F * fwd + U * up) * L + R2 * (u * wid) + N2 * (au * wid * fold - u * u * wid * curl);
  vec3 n = normalize(N2 - R2 * sign(u) * fold + R2 * u * curl * 2.0);
  vec4 w = modelMatrix * vec4(p, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(mat3(modelMatrix) * n);
  vLeaf = vec2(u, s);
  vShape = aShape;
  vStalk = stalk;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const LEAF_CUT = /* glsl */ `
bool leafCut(float type, float u, float b, float seed) {
  float au = abs(u);
  if (type > 0.5 && type < 1.5) {
    // Monstera: slits in from the edge, and a row of windows between them.
    float q = b * 6.5 - au * 0.9 + seed * 3.0;
    float slit = abs(fract(q) - 0.5);
    if (au > 0.6 && slit < 0.05 + (au - 0.6) * 0.3 && b > 0.1 && b < 0.92) return true;
    vec2 h = vec2((fract(q + 0.5) - 0.5) * 2.4, (au - 0.36) * 6.0);
    if (b > 0.16 && b < 0.84 && dot(h, h) < 0.15) return true;
  } else if (type > 1.5 && type < 2.5) {
    // Banana: the wind's tears, across the blade.
    float band = floor(b * 18.0);
    float r = hash12(vec2(band, seed * 91.0));
    float r2 = hash12(vec2(band + 7.0, seed * 37.0));
    if (r > 0.5 && au > 0.08 && au > r2 * 0.7 && abs(fract(b * 18.0) - 0.5) < 0.07 && b > 0.1) return true;
  } else if (type > 2.5 && type < 4.5) {
    // Palm and fern fronds: leaflets sweeping forward off the rachis.
    float palm = step(type, 3.5);
    float q = (b - au * mix(0.2, 0.16, palm)) * mix(17.0, 24.0, palm);
    if (fwidth(q) < 0.45 && au > 0.06) {
      float leaflet = abs(fract(q) - 0.5);
      if (leaflet > mix(0.33, 0.3, palm) * (1.0 - au * au * 0.6)) return true;
    }
  }
  return false;
}
`;

const LEAF_FRAGMENT = /* glsl */ `
${LIGHT}
${LEAF_CUT}
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vLeaf;
varying vec4 vShape;
varying float vStalk;

void main() {
  float type = vShape.x;
  float tone = vShape.y;
  float seed = vShape.w;
  float u = vLeaf.x;
  float s = vLeaf.y;
  bool stalk = s < vStalk;
  float b = clamp((s - vStalk) / max(1.0 - vStalk, 1e-3), 0.0, 1.0);
  if (!stalk && leafCut(type, u, b, seed)) discard;
  float au = abs(u);

  vec3 deep = vec3(0.02, 0.17, 0.07);
  vec3 mid = vec3(0.09, 0.43, 0.13);
  float gloss = 0.7;
  if (type > 0.5 && type < 1.5) { deep = vec3(0.01, 0.14, 0.06); mid = vec3(0.04, 0.34, 0.12); gloss = 1.0; }
  else if (type > 1.5 && type < 2.5) { deep = vec3(0.1, 0.38, 0.07); mid = vec3(0.3, 0.64, 0.1); gloss = 0.6; }
  else if (type > 2.5 && type < 3.5) { deep = vec3(0.07, 0.3, 0.07); mid = vec3(0.26, 0.56, 0.09); gloss = 0.55; }
  else if (type > 3.5 && type < 4.5) { deep = vec3(0.1, 0.4, 0.06); mid = vec3(0.38, 0.72, 0.1); gloss = 0.4; }
  else if (type > 4.5) { deep = vec3(0.05, 0.3, 0.1); mid = vec3(0.2, 0.55, 0.16); gloss = 0.8; }
  vec3 albedo = mix(deep, mid, tone);
  // Fresh growth paler at the tips.
  albedo = mix(albedo, vec3(0.5, 0.8, 0.14), smoothstep(0.55, 1.0, b) * 0.22);
  if (type > 4.5 && tone > 0.8) {
    // Red bracts: bromeliad hearts and heliconia, scarlet fading to gold.
    albedo = mix(vec3(0.85, 0.08, 0.1), vec3(1.0, 0.62, 0.08), smoothstep(0.55, 1.0, b));
    gloss = 1.0;
  }
  // The midrib, and the lateral veins fading out with distance.
  float px = fwidth(b) * 12.0;
  float rib = 1.0 - smoothstep(0.03, 0.08, au);
  if (type < 2.5 || type > 4.5) {
    float vein = 1.0 - smoothstep(0.0, 0.06, abs(fract(b * 9.0 - au * 1.6) - 0.5) - 0.42);
    albedo = mix(albedo, albedo * 1.35 + 0.02, vein * (1.0 - smoothstep(0.2, 0.6, px)) * 0.5);
  }
  albedo = mix(albedo, vec3(0.55, 0.78, 0.36), rib * 0.55);
  if (stalk) albedo = vec3(0.18, 0.42, 0.12);

  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  vec3 v = normalize(cameraPosition - vWorld);
  float reach = sunReach(vWorld);
  float ndl = dot(n, uSunDir);
  vec3 col = albedo * (ambient(n) * 0.95 + SUN * max(ndl, 0.0) * 0.85 * reach);
  // Sun through the leaf from behind it: a lime glow, strongest looking into the light.
  float through = max(-ndl, 0.0) * reach;
  float back = pow(max(dot(-v, uSunDir), 0.0), 2.0);
  col += vec3(0.42, 0.8, 0.12) * SUN * through * (0.12 + 0.45 * back);
  // Glossy: a sun highlight and the sky's sheen at a glance.
  vec3 h = normalize(uSunDir + v);
  float spec = pow(max(dot(n, h), 0.0), 56.0) * step(0.0, ndl) * reach;
  col += SUN * spec * 0.55 * gloss;
  col += vec3(0.55, 0.78, 0.92) * pow(1.0 - max(dot(n, v), 0.0), 3.0) * 0.3 * gloss * (0.5 + 0.5 * n.y);
  gl_FragColor = vec4(haze(col, vWorld), 1.0);
}
`;

const DEPTH_FRAGMENT = /* glsl */ `
${LIGHT}
${LEAF_CUT}
varying vec2 vLeaf;
varying vec4 vShape;
varying float vStalk;
void main() {
  float b = clamp((vLeaf.y - vStalk) / max(1.0 - vStalk, 1e-3), 0.0, 1.0);
  if (vLeaf.y >= vStalk && leafCut(vShape.x, vLeaf.x, b, vShape.w)) discard;
  gl_FragColor = vec4(1.0);
}
`;

function buildLeaves(specs: readonly LeafSpec[]): THREE.InstancedBufferGeometry {
  // u -1..1 across (x), s 0..1 along (y).
  const base = new THREE.PlaneGeometry(2, 1, 2, 9).translate(0, 0.5, 0);
  base.deleteAttribute('normal');
  base.deleteAttribute('uv');
  const n = specs.length;
  const pos = new Float32Array(n * 4);
  const orient = new Float32Array(n * 4);
  const shape = new Float32Array(n * 4);
  const extra = new Float32Array(n * 4);
  specs.forEach((l, i) => {
    pos.set([l.x, l.y, l.z, l.length], i * 4);
    orient.set([l.yaw, l.pitch, l.roll ?? 0, l.width], i * 4);
    shape.set([l.type, l.tone, l.bend, l.seed], i * 4);
    extra.set([l.stalk ?? 0.05, l.fold ?? 0.2, l.sway ?? 1, l.curl ?? 0.1], i * 4);
  });
  const g = instanced(base, n, { aPos: [4, pos], aOrient: [4, orient], aShape: [4, shape], aExtra: [4, extra] });
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  return g;
}

export function Leaves({ specs, shadows = false }: { specs: readonly LeafSpec[]; shadows?: boolean }) {
  const geometry = useDisposable(() => buildLeaves(specs), [specs]);
  const materials = useDisposable(() => ({
    color: shaderMaterial({ uniforms: { ...fx }, vertexShader: LEAF_VERTEX, fragmentShader: LEAF_FRAGMENT, side: THREE.DoubleSide }),
    depth: shaderMaterial({ uniforms: { ...fx }, vertexShader: LEAF_VERTEX, fragmentShader: DEPTH_FRAGMENT, side: THREE.DoubleSide }),
  }));
  return (
    <mesh geometry={geometry} material={materials.color} customDepthMaterial={shadows ? materials.depth : undefined} castShadow={shadows} frustumCulled={false} />
  );
}
