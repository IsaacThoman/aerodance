import * as THREE from 'three';
import { useDisposable } from '../../stages/shared/hooks.ts';
import { hash, shaderMaterial } from '../../stages/shared/glsl.ts';
import { fx, landGLSL, skyGLSL } from './fx.ts';
import { CAMERA, landHeight, RIVER_HALF_WIDTH, RIVER_PATH, riverDistance, WATER } from './terrain.ts';

// A polar grid around the camera: columns fan out across the view and rows grow geometrically
// with distance, so the near slopes are fine, the far hills cheap, and every crest line smooth.
const COLUMNS = 320;
const ROWS = 200;
const NEAR = 2;
const FAR = 6000;
const SPREAD = THREE.MathUtils.degToRad(58);

function buildLand() {
  const [cx, , cz] = CAMERA.position;
  const count = (COLUMNS + 1) * (ROWS + 1);
  const pos = new Float32Array(count * 3);
  const river = new Float32Array(count);
  let k = 0;
  for (let j = 0; j <= ROWS; j++) {
    const r = NEAR * Math.pow(FAR / NEAR, j / ROWS);
    for (let i = 0; i <= COLUMNS; i++) {
      const a = -SPREAD + (2 * SPREAD * i) / COLUMNS;
      const x = cx + Math.sin(a) * r;
      const z = cz - Math.cos(a) * r;
      const d = riverDistance(x, z);
      pos.set([x, landHeight(x, z, d), z], k * 3);
      river[k] = d;
      k++;
    }
  }
  const index: number[] = [];
  for (let j = 0; j < ROWS; j++) {
    for (let i = 0; i < COLUMNS; i++) {
      const a = j * (COLUMNS + 1) + i;
      const b = a + COLUMNS + 1;
      index.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aRiver', new THREE.BufferAttribute(river, 1));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

const landVert = /* glsl */ `
  attribute float aRiver;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying float vRiver;
  void main() {
    vWorld = position;
    vNormal = normal;
    vRiver = aRiver;
    gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
  }
`;

const landFrag = /* glsl */ `
  uniform vec3 uDeep, uGrass, uLime, uSheen, uBank;
  ${skyGLSL}
  ${landGLSL}
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying float vRiver;
  void main() {
    vec3 n = normalize(vNormal);
    vec3 toCam = cameraPosition - vWorld;
    float dist = length(toCam);
    vec3 v = toCam / dist;
    // Broad soft patches of deeper and brighter green; no fine detail to shimmer.
    vec4 pn = tnoise(vWorld.xz * 0.01);
    float patches = pn.r * 0.65 + pn.g * 0.35;
    vec3 albedo = mix(uDeep, uGrass, smoothstep(-0.55, 0.5, patches));
    float key = dot(n, uKeyDir);
    albedo = mix(albedo, uLime, smoothstep(0.5, 0.98, key) * 0.55);
    // A lusher, darker meadow along the river.
    albedo = mix(uBank, albedo, smoothstep(3.0, 26.0, vRiver));
    float shadow = cloudShadow(vWorld.xz);
    float dif = clamp((key + 0.3) / 1.3, 0.0, 1.0);
    vec3 col = albedo * (uKeyColor * dif * shadow + ambient(n));
    // Velvet sheen: grazing slopes and backlit crests glow towards the sun.
    float graze = pow(1.0 - max(dot(n, v), 0.0), 3.0);
    float towardSun = pow(max(dot(-v, uSunDir) * 0.5 + 0.5, 0.0), 3.0);
    col += uSheen * graze * graze * (0.04 + towardSun * 0.3) * shadow;
    // A soft pale rim where the slopes turn away over their crests, melting the skyline edge.
    col = mix(col, hazeColor(-v) * 1.05, pow(graze, 7.0) * 0.4);
    // Wind sweeping across the grass: pale, silvery fronts on the near and middle hills.
    float g = gust(vWorld.xz);
    float near = 1.0 - smoothstep(250.0, 900.0, dist);
    col = mix(col, col * 1.5 + uSheen * 0.06, g * near);
    col = applyLandHaze(col, vWorld);
    gl_FragColor = vec4(col, 1.0);
  }
`;

export function Land() {
  const geometry = useDisposable(buildLand);
  const material = useDisposable(() =>
    shaderMaterial({
      uniforms: {
        ...fx,
        uDeep: { value: new THREE.Color('#174a0b') },
        uGrass: { value: new THREE.Color('#2e7a12') },
        uLime: { value: new THREE.Color('#62a824') },
        uSheen: { value: new THREE.Color('#b8f070') },
        uBank: { value: new THREE.Color('#1f6414') },
      },
      vertexShader: landVert,
      fragmentShader: landFrag,
    }),
  );
  return <mesh geometry={geometry} material={material} frustumCulled={false} />;
}

// ------------------------------------------------------------------ river

function buildRiver() {
  const p = RIVER_PATH;
  const n = p.length / 2;
  const half = RIVER_HALF_WIDTH * 1.35;
  const pos = new Float32Array(n * 2 * 3);
  const uv = new Float32Array(n * 2 * 2);
  let along = 0;
  for (let i = 0; i < n; i++) {
    const x = p[i * 2];
    const z = p[i * 2 + 1];
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    let tx = p[b * 2] - p[a * 2];
    let tz = p[b * 2 + 1] - p[a * 2 + 1];
    const len = Math.hypot(tx, tz) || 1;
    tx /= len;
    tz /= len;
    if (i > 0) along += Math.hypot(x - p[i * 2 - 2], z - p[i * 2 - 1]);
    pos.set([x - tz * half, WATER, z + tx * half, x + tz * half, WATER, z - tx * half], i * 6);
    uv.set([0, along, 1, along], i * 4);
  }
  const index: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2;
    index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(index);
  return g;
}

const riverFrag = /* glsl */ `
  uniform vec3 uDeepWater;
  ${skyGLSL}
  ${landGLSL}
  varying vec2 vUv;
  varying vec3 vWorld;
  // Soft twinkling sparkles on a grid of cells along the river; cell size in world units.
  float sparkles(vec2 q, float cell) {
    vec2 c = floor(q / cell);
    vec2 f = q / cell - c;
    float rnd = hash12(c + 7.3);
    vec2 at = 0.25 + 0.5 * hash22(c);
    float tw = pow(max(sin(uTime * (0.9 + rnd * 1.6) + rnd * 40.0), 0.0), 10.0);
    float d = length((f - at) * vec2(1.0, 2.2));
    return smoothstep(0.32, 0.0, d) * tw * step(0.45, rnd);
  }
  void main() {
    vec3 toCam = cameraPosition - vWorld;
    float dist = length(toCam);
    vec3 v = toCam / dist;
    // Flowing ripples tilt the mirror a little, stretching the sky into streaks.
    vec2 flow = vec2(vUv.x * 6.0, vUv.y * 0.25 - uTime * 0.6);
    vec4 rn = tnoise(flow * vec2(1.0, 0.35));
    vec3 n = normalize(vec3(rn.r * 0.05, 1.0, rn.g * 0.12));
    vec3 r = reflect(-v, n);
    r.y = abs(r.y);
    vec3 sky = skyGradient(r) * 1.15 + sunHalo(r) * 0.6;
    float fres = 0.15 + 0.7 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
    vec3 col = mix(uDeepWater, sky, fres);
    // A soft glassy sheen in the ripples, brightest towards the sun.
    col += uGlow * smoothstep(0.35, 0.9, rn.b) * 0.18 * (0.5 + sunward(-v));
    // Glints: two cell sizes, cross-faded by distance so they never shrink below a few pixels.
    float lod = log2(max(dist / 45.0, 1.0));
    float l0 = floor(lod);
    float blend = lod - l0;
    vec2 q = vec2(vUv.x * ${(RIVER_HALF_WIDTH * 2.7).toFixed(2)}, vUv.y);
    // Each level has its own pattern, keyed by its number, so the hand-over between levels is seamless.
    float s = mix(sparkles(q + 31.0 * l0, 0.9 * exp2(l0)), sparkles(q + 31.0 * (l0 + 1.0), 0.9 * exp2(l0 + 1.0)), blend);
    // Brightest along the sun's glitter path, where the ripples tilt the sun into view.
    float path = pow(max(dot(r, uSunDir), 0.0), 120.0);
    col += uSunColor * s * (1.2 + path * 9.0) + uSunColor * path * 0.5;
    col = applyLandHaze(col, vWorld);
    // Soft shorelines rather than a hard line against the bank.
    float edge = smoothstep(0.0, 0.2, vUv.x) * smoothstep(1.0, 0.8, vUv.x);
    gl_FragColor = vec4(col, edge);
  }
`;

export function River() {
  const geometry = useDisposable(buildRiver);
  const material = useDisposable(() =>
    shaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { ...fx, uDeepWater: { value: new THREE.Color('#06808c') } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        varying vec3 vWorld;
        void main() {
          vUv = uv;
          vWorld = position;
          gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `${hash}${riverFrag}`,
    }),
  );
  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={1} />;
}
