import * as THREE from 'three';
import { useDisposable } from '../shared/hooks.ts';
import { makeRandom } from '../shared/random.ts';
import type { Random } from '../shared/random.ts';
import { shaderMaterial } from '../shared/glsl.ts';
import { makeNoise2, ridged2 } from './noise.ts';
import { noiseTexture, palette, polar, ripple } from './world.ts';

/** A height in world units at (x, z). */
export type HeightField = (x: number, z: number) => number;

/** [x, z, height, radius]: one snowy massif. */
export type Peak = readonly [x: number, z: number, height: number, radius: number];

/** The rectangle of ground a terrain covers. Rows bunch up towards `front`, where it's seen closest. */
export interface LandArea {
  left: number;
  right: number;
  front: number;
  back: number;
}

const crags = makeNoise2(41);

/** Snowy massifs: a cone per peak, carved into crests and gullies. Add a stage's own foothills and clearings to it. */
export function massifHeight(peaks: readonly Peak[], x: number, z: number): number {
  let h = 0;
  for (const [px, pz, ph, pr] of peaks) {
    const d = Math.hypot(x - px, (z - pz) * 1.2);
    h += ph * Math.max(0, 1 - d / pr) ** 1.6;
  }
  return h * (0.4 + 0.95 * ridged2(crags, x * 0.006, z * 0.006, 5));
}

export function terrainGeometry(height: HeightField, area: LandArea, cols: number, rows: number): THREE.BufferGeometry {
  const positions = new Float32Array((cols + 1) * (rows + 1) * 3);
  let i = 0;
  for (let r = 0; r <= rows; r++) {
    const z = area.front + (area.back - area.front) * (r / rows) ** 1.6;
    for (let c = 0; c <= cols; c++) {
      const x = area.left + (area.right - area.left) * (c / cols);
      positions.set([x, height(x, z), z], i * 3);
      i++;
    }
  }
  const index: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = r * (cols + 1) + c;
      const b = a + cols + 1;
      index.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

/**
 * Shared lighting for the far land: a cool moon key from the front left, the aurora's green
 * behind the ridges, and haze towards the horizon glow with distance and low down.
 */
export const landLight = /* glsl */ `
const vec3 KEY = normalize(vec3(-0.8, 0.5, 0.25));
const vec3 FILL = normalize(vec3(0.3, 0.6, -0.7));
vec3 hazed(vec3 col, vec3 p, float h) {
  float d = length(p - cameraPosition);
  float haze = 1.0 - exp(-d * 0.0007) + smoothstep(900.0, 1600.0, d) * 0.22;
  haze = clamp(haze + exp(-max(h, 0.0) / 8.0) * 0.12, 0.0, 0.88);
  return mix(col, HAZE, haze);
}
`;

function terrainMaterial(mirror: boolean, snowLine: number, cut: number) {
  return shaderMaterial({
    side: mirror ? THREE.BackSide : THREE.FrontSide,
    defines: mirror ? { MIRROR: '' } : {},
    uniforms: { uTime: polar.uTime, uNoise: polar.uNoise, uSnowLine: { value: snowLine }, uCut: { value: cut } },
    vertexShader: /* glsl */ `
      varying vec3 vPos;
      varying vec3 vWorld;
      varying vec3 vNormal;
      void main() {
        vPos = position;
        vNormal = normal;
        vec3 p = position;
        #ifdef MIRROR
        p.y = -p.y;
        #endif
        vWorld = p;
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime, uSnowLine, uCut;
      varying vec3 vPos;
      varying vec3 vWorld;
      varying vec3 vNormal;
      ${noiseTexture}
      ${palette}
      ${ripple}
      ${landLight}
      void main() {
        if (vPos.y < uCut) discard;
        vec3 n = normalize(vNormal);
        vec3 view = normalize(cameraPosition - vPos);
        // Snow above a wavering line, sliding off the steepest faces.
        float line = uSnowLine + 26.0 * noise4(vPos.xz * 0.004).b + 10.0 * noise4(vPos.xz * 0.02).a;
        float snow = smoothstep(line - 14.0, line + 14.0, vPos.y) * smoothstep(0.42, 0.68, n.y);
        float key = max(dot(n, KEY), 0.0);
        float fill = max(dot(n, FILL), 0.0);
        vec3 rock = mix(vec3(0.002, 0.005, 0.012), vec3(0.02, 0.032, 0.06), key);
        vec3 white = mix(vec3(0.02, 0.05, 0.13), vec3(0.27, 0.4, 0.64), smoothstep(0.1, 0.9, key));
        white += vec3(0.0, 0.08, 0.06) * fill;
        vec3 col = mix(rock, white, snow);
        // A glossy sheen on the snow, and the aurora's green catching every crest.
        col += vec3(0.5, 0.7, 0.9) * pow(max(dot(reflect(-KEY, n), view), 0.0), 12.0) * snow * 0.35;
        float rim = pow(1.0 - max(dot(n, view), 0.0), 2.0) * smoothstep(0.1, 0.7, n.y);
        col += vec3(0.02, 0.2, 0.13) * rim * (0.35 + 0.65 * snow) * smoothstep(20.0, 90.0, vPos.y);
        col = hazed(col, vPos, vPos.y);
        #ifdef MIRROR
        vec2 slope = mirrorRipple(waterHit(vWorld).xz);
        col = mix(WATER, col, 0.62) * (1.0 + slope.y * 22.0);
        #endif
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}

export interface MountainsProps {
  height: HeightField;
  area: LandArea;
  /** [columns, rows] of the grid. */
  grid?: readonly [number, number];
  /** Also draw it mirrored below y = 0, on this coarser grid. */
  mirrorGrid?: readonly [number, number];
  /** Snow covers the land above about this height (and everything gentle enough above it). */
  snowLine?: number;
  /** Land below this height isn't drawn (a lake's surface, say). */
  cut?: number;
  renderOrder?: number;
}

/** Far mountains and foothills, moonlit, snowy above `snowLine` and hazed with distance; and their reflection, given `mirrorGrid`. */
export function Mountains({ height, area, grid = [288, 64], mirrorGrid, snowLine = 62, cut = -1e6, renderOrder = 1 }: MountainsProps) {
  const geometry = useDisposable(() => terrainGeometry(height, area, ...grid), [height, area, ...grid]);
  const mirrored = useDisposable(() => (mirrorGrid ? terrainGeometry(height, area, ...mirrorGrid) : null), [height, area, mirrorGrid?.join()]);
  const land = useDisposable(() => terrainMaterial(false, snowLine, cut), [snowLine, cut]);
  const reflection = useDisposable(() => terrainMaterial(true, snowLine, cut), [snowLine, cut]);
  return (
    <>
      <mesh geometry={geometry} material={land} frustumCulled={false} renderOrder={renderOrder} />
      {mirrored && <mesh geometry={mirrored} material={reflection} frustumCulled={false} renderOrder={renderOrder + 1} />}
    </>
  );
}

/** One far pine: where its trunk meets the ground, how wide and tall it is, and a random 0–1. */
export interface FarPine {
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  seed: number;
}

export interface ScatterPinesOptions {
  count: number;
  seed?: number;
  /** A candidate spot, or null to skip it (a clearing, a lake, too steep). */
  spot: (rand: Random) => readonly [x: number, z: number] | null;
  height: HeightField;
  /** Tree height for a spot, before ±30% variation. */
  size: (x: number, z: number) => number;
}

/** Scatters far pines with `spot` until there are `count` of them, sorted far to near for blending. */
export function scatterPines({ count, seed = 5, spot, height, size }: ScatterPinesOptions): FarPine[] {
  const rand = makeRandom(seed);
  const pines: FarPine[] = [];
  for (let tries = 0; tries < count * 10 && pines.length < count; tries++) {
    const at = spot(rand);
    if (!at) continue;
    const [x, z] = at;
    const tall = size(x, z) * rand.range(0.7, 1.3);
    pines.push({ x, y: height(x, z) - tall * 0.05, z, width: tall * rand.range(0.36, 0.46), height: tall, seed: rand.next() });
  }
  return pines.sort((a, b) => a.z - b.z);
}

function pineGeometry(pines: readonly FarPine[]): THREE.InstancedBufferGeometry {
  const plane = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
  const g = new THREE.InstancedBufferGeometry();
  g.index = plane.index;
  g.setAttribute('position', plane.getAttribute('position'));
  g.setAttribute('uv', plane.getAttribute('uv'));
  g.setAttribute('aBase', new THREE.InstancedBufferAttribute(new Float32Array(pines.flatMap((p) => [p.x, p.y, p.z])), 3));
  g.setAttribute('aSize', new THREE.InstancedBufferAttribute(new Float32Array(pines.flatMap((p) => [p.width, p.height, p.seed])), 3));
  g.instanceCount = pines.length;
  return g;
}

function pineMaterial(mirror: boolean) {
  return shaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    defines: mirror ? { MIRROR: '' } : {},
    uniforms: { uTime: polar.uTime, uNoise: polar.uNoise },
    vertexShader: /* glsl */ `
      attribute vec3 aBase;
      attribute vec3 aSize;
      varying vec2 vUv;
      varying vec3 vBase;
      varying vec3 vWorld;
      varying float vSeed;
      void main() {
        // Upright billboards: turned to face the camera about their trunks.
        vec3 right = normalize(vec3(viewMatrix[0][0], 0.0, viewMatrix[2][0]));
        vec3 p = aBase + right * position.x * aSize.x + vec3(0.0, position.y * aSize.y, 0.0);
        #ifdef MIRROR
        p.y = -p.y;
        #endif
        vUv = uv;
        vBase = aBase;
        vWorld = p;
        vSeed = aSize.z;
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying vec2 vUv;
      varying vec3 vBase;
      varying vec3 vWorld;
      varying float vSeed;
      ${noiseTexture}
      ${palette}
      ${ripple}
      ${landLight}
      void main() {
        float x = vUv.x - 0.5;
        #ifdef MIRROR
        vec2 slope = mirrorRipple(waterHit(vWorld).xz);
        x += slope.x * 6.0;
        #endif
        float y = vUv.y;
        float aa = fwidth(x) * 1.3;
        // Tiers of boughs, each flaring out at its foot, under a cone from the tip.
        float t = clamp((1.0 - y) / 0.9, 0.0, 1.0);
        float tiers = 5.0 + floor(vSeed * 3.0);
        float flare = fract(t * tiers + vSeed * 0.3);
        float w = 0.5 * pow(t, 0.95) * (0.42 + 0.58 * flare);
        float boughs = (1.0 - smoothstep(w - aa, w + aa, abs(x))) * smoothstep(0.06, 0.1, y);
        float trunk = (1.0 - smoothstep(0.03, 0.03 + aa, abs(x))) * (1.0 - smoothstep(0.1, 0.14, y));
        float alpha = max(boughs, trunk);
        if (alpha < 0.01) discard;
        // Near black, with a frosty teal edge where the aurora light wraps the boughs.
        vec3 col = vec3(0.003, 0.010, 0.016);
        float edge = smoothstep(w - 0.1, w, abs(x)) * boughs;
        col += vec3(0.02, 0.11, 0.10) * edge * (0.4 + 0.6 * (1.0 - t));
        col = mix(col, HAZE, 1.0 - exp(-length(vBase - cameraPosition) * 0.00045));
        #ifdef MIRROR
        col = mix(WATER, col, 0.7);
        #endif
        gl_FragColor = vec4(col, alpha);
      }
    `,
  });
}

/**
 * Dark pine silhouettes for far shores and foothills (camera-facing billboards; build nearer
 * trees in 3D), and their reflection below y = 0 if `reflected`. Like the curtains, they blend
 * before the dancers by default.
 */
export function FarPines({ pines, reflected = false, renderOrder = -40 }: { pines: readonly FarPine[]; reflected?: boolean; renderOrder?: number }) {
  const geometry = useDisposable(() => pineGeometry(pines), [pines]);
  const material = useDisposable(() => pineMaterial(false));
  const reflection = useDisposable(() => pineMaterial(true));
  return (
    <>
      {reflected && <mesh geometry={geometry} material={reflection} frustumCulled={false} renderOrder={renderOrder} />}
      <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={renderOrder + 1} />
    </>
  );
}
