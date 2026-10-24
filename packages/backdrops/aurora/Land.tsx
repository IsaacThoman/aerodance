import * as THREE from 'three';
import { useDisposable } from '../../stages/shared/hooks.ts';
import { makeRandom, smoothstep } from '../../stages/shared/random.ts';
import { shaderMaterial, simplex } from '../../stages/shared/glsl.ts';
import { fbm2, makeNoise2, ridged2 } from './noise.ts';
import { CABIN, palette, ripple, world } from './world.ts';

// [x, z, height, radius]: the snowy peaks, tallest right of centre above the menu dancers and
// low and rounded on the left behind the title.
const PEAKS: readonly [number, number, number, number][] = [
  [250, -720, 150, 290],
  [480, -810, 118, 240],
  [90, -880, 98, 230],
  [-190, -960, 78, 280],
  [-560, -800, 52, 320],
  [-960, -900, 82, 340],
  [790, -950, 128, 300],
  [1180, -880, 96, 320],
  // A far, hazy range showing over the low hills on the left.
  [-760, -1330, 170, 380],
  [-1250, -1420, 200, 420],
  [-330, -1480, 150, 360],
];

const LAND = { left: -1500, right: 1500, front: -196, back: -1850 };
const noise = makeNoise2(41);
const detail = makeNoise2(97);

/** Where the far shore meets the water along x. */
const shoreZ = (x: number) => -206 + 9 * fbm2(noise, x * 0.006, 3.7, 3);

/** Height of the land at (x, z): a low wooded bank, forested foothills, then the peaks. */
export function landHeight(x: number, z: number): number {
  const shore = shoreZ(x);
  const bank = smoothstep(shore + 4, shore - 16, z) * (6 + 3 * fbm2(detail, x * 0.02, z * 0.02, 2)) - 3;
  const foot = smoothstep(shore - 10, shore - 190, z) * (16 + 16 * fbm2(noise, x * 0.0045, z * 0.0045, 3));
  let peaks = 0;
  for (const [px, pz, ph, pr] of PEAKS) {
    const d = Math.hypot(x - px, (z - pz) * 1.2);
    peaks += ph * Math.max(0, 1 - d / pr) ** 1.6;
  }
  // Crests and gullies carved into the massifs.
  const crags = ridged2(noise, x * 0.006, z * 0.006, 5);
  peaks *= 0.4 + 0.95 * crags;
  let h = bank + foot + peaks;
  // A flat clearing for the cabin.
  const cabin = Math.hypot(x - CABIN.position[0], z - CABIN.position[2]);
  h += (4.2 - h) * (1 - smoothstep(9, 18, cabin)) * smoothstep(shore + 2, shore - 6, z);
  return h;
}

function terrainGeometry(): THREE.BufferGeometry {
  const cols = 320;
  const rows = 84;
  const positions = new Float32Array((cols + 1) * (rows + 1) * 3);
  let i = 0;
  for (let r = 0; r <= rows; r++) {
    // Rows bunch up near the shore, where they're seen closest.
    const z = LAND.front + (LAND.back - LAND.front) * (r / rows) ** 1.6;
    for (let c = 0; c <= cols; c++) {
      const x = LAND.left + (LAND.right - LAND.left) * (c / cols);
      positions.set([x, landHeight(x, z), z], i * 3);
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

// Shared lighting for land: a cool moon key from the front left, the aurora's green behind
// the ridges, and haze towards the horizon glow with distance and near the water.
const landLight = /* glsl */ `
const vec3 KEY = normalize(vec3(-0.8, 0.5, 0.25));
const vec3 FILL = normalize(vec3(0.3, 0.6, -0.7));
vec3 hazed(vec3 col, vec3 p, float h) {
  float d = length(p - cameraPosition);
  float haze = 1.0 - exp(-d * 0.0007) + smoothstep(900.0, 1600.0, d) * 0.22;
  haze = clamp(haze + exp(-max(h, 0.0) / 8.0) * 0.12, 0.0, 0.88);
  return mix(col, HAZE, haze);
}
`;

function terrainMaterial(mirror: boolean) {
  return shaderMaterial({
    side: mirror ? THREE.BackSide : THREE.FrontSide,
    defines: mirror ? { MIRROR: '' } : {},
    uniforms: { uTime: world.uTime },
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
      uniform float uTime;
      varying vec3 vPos;
      varying vec3 vWorld;
      varying vec3 vNormal;
      ${simplex}
      ${palette}
      ${ripple}
      ${landLight}
      void main() {
        if (vPos.y < 0.0) discard;
        vec3 n = normalize(vNormal);
        vec3 view = normalize(cameraPosition - vPos);
        // Snow above a wavering line, sliding off the steepest faces.
        float line = 62.0 + 26.0 * snoise(vPos.xz * 0.004) + 10.0 * snoise(vPos.xz * 0.02);
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
        vec2 slope = rippleSlope(waterHit(vWorld).xz);
        col = mix(WATER, col, 0.62) * (1.0 + slope.y * 22.0);
        #endif
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}

/** The mountains and wooded shore beyond the lake, and their reflection. */
export function Mountains() {
  const geometry = useDisposable(terrainGeometry);
  const land = useDisposable(() => terrainMaterial(false));
  const reflection = useDisposable(() => terrainMaterial(true));
  return (
    <>
      <mesh geometry={geometry} material={land} frustumCulled={false} renderOrder={1} />
      <mesh geometry={geometry} material={reflection} frustumCulled={false} renderOrder={2} />
    </>
  );
}

function pineGeometry(): THREE.InstancedBufferGeometry {
  const rand = makeRandom(5);
  const pines: { x: number; y: number; z: number; w: number; h: number; seed: number }[] = [];
  const [cx, , cz] = CABIN.position;
  for (let tries = 0; tries < 4000 && pines.length < 520; tries++) {
    const x = rand.range(-760, 760);
    const shore = shoreZ(x);
    // Most along the shore, thinning out up the foothills.
    const z = shore - 2 - rand.next() ** 1.8 * 300;
    const h = landHeight(x, z);
    if (h < 1.2 || h > 48) continue;
    if (Math.hypot(x - cx, z - cz) < 13) continue;
    const slope = Math.abs(landHeight(x + 4, z) - h) + Math.abs(landHeight(x, z - 4) - h);
    if (slope > 6) continue;
    const tall = rand.range(9, 19) * (1 + (shore - z) / 600);
    pines.push({ x, y: h - 0.8, z, w: tall * rand.range(0.36, 0.46), h: tall, seed: rand.next() });
  }
  // Far ones first, so nearer pines blend over them.
  pines.sort((a, b) => a.z - b.z);
  const plane = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
  const g = new THREE.InstancedBufferGeometry();
  g.index = plane.index;
  g.setAttribute('position', plane.getAttribute('position'));
  g.setAttribute('uv', plane.getAttribute('uv'));
  g.setAttribute('aBase', new THREE.InstancedBufferAttribute(new Float32Array(pines.flatMap((p) => [p.x, p.y, p.z])), 3));
  g.setAttribute('aSize', new THREE.InstancedBufferAttribute(new Float32Array(pines.flatMap((p) => [p.w, p.h, p.seed])), 3));
  g.instanceCount = pines.length;
  return g;
}

function pineMaterial(mirror: boolean) {
  return shaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    defines: mirror ? { MIRROR: '' } : {},
    uniforms: { uTime: world.uTime },
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
      ${simplex}
      ${palette}
      ${ripple}
      ${landLight}
      void main() {
        float x = vUv.x - 0.5;
        #ifdef MIRROR
        vec2 slope = rippleSlope(waterHit(vWorld).xz);
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

/** Dark pines along the far shore and up the foothills, and their reflection. */
export function Pines() {
  const geometry = useDisposable(pineGeometry);
  const pines = useDisposable(() => pineMaterial(false));
  const reflection = useDisposable(() => pineMaterial(true));
  return (
    <>
      <mesh geometry={geometry} material={reflection} frustumCulled={false} renderOrder={20} />
      <mesh geometry={geometry} material={pines} frustumCulled={false} renderOrder={21} />
    </>
  );
}

function cabinGeometry(): THREE.BufferGeometry {
  // An A-frame: a triangular prism whose front gable is all glass.
  const shape = new THREE.Shape([new THREE.Vector2(-6, 0), new THREE.Vector2(6, 0), new THREE.Vector2(0, 11)]);
  const g = new THREE.ExtrudeGeometry(shape, { depth: 11, bevelEnabled: false });
  g.translate(0, 0, -11);
  return g;
}

function cabinMaterial(mirror: boolean) {
  return shaderMaterial({
    side: mirror ? THREE.BackSide : THREE.FrontSide,
    defines: mirror ? { MIRROR: '' } : {},
    uniforms: { uTime: world.uTime },
    vertexShader: /* glsl */ `
      varying vec3 vLocal;
      varying vec3 vPos;
      varying vec3 vWorld;
      varying vec3 vNormal;
      void main() {
        vLocal = position;
        vNormal = normalize(mat3(modelMatrix) * normal);
        vec4 w = modelMatrix * vec4(position, 1.0);
        vPos = w.xyz;
        #ifdef MIRROR
        w.y = -w.y;
        #endif
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying vec3 vLocal;
      varying vec3 vPos;
      varying vec3 vWorld;
      varying vec3 vNormal;
      ${simplex}
      ${palette}
      ${ripple}
      ${landLight}
      void main() {
        vec3 n = normalize(vNormal);
        vec3 col;
        if (n.z > 0.9) {
          // The glass gable: a warm lit interior behind mullions, with a glossy sheen across it.
          vec2 p = vLocal.xy;
          float inset = min(p.y - 0.5, (6.0 - abs(p.x)) * 0.877 - p.y * 0.48 - 0.9);
          float frame = 1.0 - smoothstep(0.0, 0.2, inset);
          float mull = max(1.0 - smoothstep(0.08, 0.2, abs(fract(p.x / 2.4 + 0.5) - 0.5) * 2.4), 1.0 - smoothstep(0.08, 0.2, abs(p.y - 4.2)));
          vec3 lit = mix(vec3(1.9, 0.95, 0.34), vec3(0.95, 0.4, 0.16), smoothstep(0.0, 9.0, p.y));
          lit *= 0.9 + 0.1 * sin(uTime * 1.3 + p.x * 0.4);
          // The roof's edge frames the glass, its outer rim catching the moon like the roof's snow.
          vec3 edge = mix(vec3(0.02, 0.025, 0.04), vec3(0.3, 0.42, 0.62), smoothstep(-0.4, -0.85, inset) * step(0.6, p.y));
          col = mix(lit, edge, max(frame, mull * 0.85));
          float sheen = smoothstep(0.6, 0.0, abs(p.x * 0.7 + p.y - 6.0)) * 0.35;
          col += vec3(0.7, 0.85, 1.0) * sheen * (1.0 - frame);
        } else {
          // Snow on the roof, lit by the moon; dark timber at the back.
          float key = max(dot(n, KEY), 0.0);
          col = mix(vec3(0.05, 0.1, 0.22), vec3(0.55, 0.7, 0.95), key) * smoothstep(-0.2, 0.4, n.y);
          col += vec3(0.008, 0.01, 0.02);
        }
        col = hazed(col, vPos, 30.0);
        #ifdef MIRROR
        vec2 slope = rippleSlope(waterHit(vWorld).xz);
        col = mix(WATER, col, 0.75) * (1.0 + slope.y * 22.0);
        #endif
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}

/** A small glass A-frame cabin with warm windows on the far shore, and its reflection. */
export function Cabin() {
  const geometry = useDisposable(cabinGeometry);
  const cabin = useDisposable(() => cabinMaterial(false));
  const reflection = useDisposable(() => cabinMaterial(true));
  const [x, , z] = CABIN.position;
  const y = landHeight(x, z) - 0.3;
  return (
    <group position={[x, y, z]} rotation={[0, -0.18, 0]} scale={1.4}>
      <mesh geometry={geometry} material={cabin} renderOrder={3} frustumCulled={false} />
      <mesh geometry={geometry} material={reflection} renderOrder={4} frustumCulled={false} />
    </group>
  );
}
