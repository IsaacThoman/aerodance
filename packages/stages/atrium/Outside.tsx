import * as THREE from 'three';
import { useDisposable } from '../shared/hooks.ts';
import { shaderMaterial, uniform } from '../shared/glsl.ts';
import { makeCloudAtlas } from '../shared/Sky.tsx';
import { makeRandom } from '../shared/random.ts';
import { fill, instanced, mergeAll, sweepArc } from './geometry.ts';
import type { ProfilePoint } from './geometry.ts';
import { AXIS, LAYOUT_GLSL, polar } from './layout.ts';
import { LOOK_UNIFORMS, useAtrium } from './shading.ts';

// What the glass shows: blue sky and cumulus, a green park with white eco-towers, and a ring
// guideway on tall pylons that three maglev trains glide round.

/** The guideway ring: radius about the axis, height of the trains' centres. */
const RING_R = 50;
const RING_Y = 27;
/** Thetas the guideway and pylons are built over (what the glass wall can see, with margin). */
const RING_THETA: readonly [number, number] = [0.6, 3.7];
/** Train speed round the ring, radians per second, and the trains' length. */
const TRAIN_SPEED = 0.16;
const TRAIN_LEN = 30;

const OUTDOOR = /* glsl */ `
${LOOK_UNIFORMS}
${LAYOUT_GLSL}
#define SKY_HAZE (uSkyLow * 0.85)
vec3 outdoorHaze(vec3 col, vec3 wp) {
  float d = length(wp - cameraPosition);
  return mix(col, SKY_HAZE, clamp((1.0 - exp(-d * 0.0028)) * 0.75, 0.0, 0.75));
}
vec3 outdoorLight(vec3 albedo, vec3 n, vec3 v, float gloss) {
  vec3 s = normalize(uSunDir);
  float diff = max(dot(n, s), 0.0);
  vec3 sky = mix(uAmbDown * 1.2, uAmbUp * 1.15, n.y * 0.5 + 0.5);
  vec3 col = albedo * (sky + uSun * 1.1 * diff);
  float fres = 0.04 + 0.96 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
  vec3 r = reflect(-v, n);
  vec3 env = mix(uSkyLow * 0.85, uSkyHigh, clamp(r.y, 0.0, 1.0));
  env = mix(env, vec3(0.35, 0.5, 0.3) * uAmbDown * 2.0, smoothstep(0.0, -0.2, r.y));
  col += env * mix(0.04, 0.8, fres) * gloss;
  col += uSun * 0.5 * pow(max(dot(reflect(-s, n), v), 0.0), 60.0) * gloss * diff * 3.0;
  return col;
}
`;

const cloudVertex = /* glsl */ `
attribute vec4 aCloud;
attribute vec2 aSize;
attribute float aCell;
uniform float uTime;
varying vec2 vUv;
varying float vElev;
void main() {
  // Clouds on a ring round the camera, turning slowly: the loop never ends.
  float az = aCloud.x + uTime * aCloud.w;
  vec3 c = cameraPosition + vec3(sin(az), 0.0, -cos(az)) * aCloud.z;
  c.y = aCloud.y;
  vec4 mv = viewMatrix * vec4(c, 1.0);
  mv.xy += position.xy * aSize;
  gl_Position = projectionMatrix * mv;
  vElev = (aCloud.y - cameraPosition.y) / aCloud.z;
  vec2 cell = vec2(mod(aCell, 2.0), 1.0 - floor(aCell / 2.0));
  vUv = (uv + cell) * 0.5;
}
`;

const cloudFragment = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uCloudLit;
uniform vec3 uCloudShade;
uniform vec3 uSkyLow;
varying vec2 vUv;
varying float vElev;
void main() {
  vec4 t = texture2D(uMap, vUv);
  if (t.a < 0.004) discard;
  float light = clamp(t.r / t.a, 0.0, 1.0);
  vec3 col = mix(uCloudShade, uCloudLit, smoothstep(0.3, 1.0, light));
  // Low clouds sink into the horizon haze.
  col = mix(col, uSkyLow * 0.95, smoothstep(0.35, 0.05, vElev) * 0.6);
  float a = t.a;
  gl_FragColor = vec4(col * a, a);
}
`;

/** Cumulus billboards round the sky, drifting by on the backdrop clock. */
export function Clouds({ count = 21 }: { count?: number }) {
  const { look, uniforms } = useAtrium();
  const texture = useDisposable(() => makeCloudAtlas(11));
  const geometry = useDisposable(() => {
    const rand = makeRandom(57);
    const cloud = new Float32Array(count * 4);
    const size = new Float32Array(count * 2);
    const cell = new Float32Array(count);
    const items = [];
    for (let i = 0; i < count; i++) {
      const dist = rand.range(380, 620);
      // Spread round the sky: low ones big and puffy where the glass wall looks out, high ones
      // smaller, drifting over the dome.
      const az = (i / count) * Math.PI * 2 + rand.range(-0.15, 0.15);
      const elev = [rand.range(0.03, 0.2), rand.range(0.2, 0.5), rand.range(0.55, 0.85)][i % 3];
      const s = rand.range(160, 300) * (1 - elev * 0.6);
      items.push({ az, elev, dist, s, flip: rand.sign(), c: rand.int(0, 3) });
    }
    // Far ones first.
    items.sort((a, b) => b.dist - a.dist);
    items.forEach((it, i) => {
      cloud.set([it.az, 2.3 + Math.tan(it.elev) * it.dist, it.dist, 0.0035], i * 4);
      size.set([it.s * it.flip, it.s * 0.62], i * 2);
      cell[i] = it.c;
    });
    return instanced(new THREE.PlaneGeometry(1, 1), count, { aCloud: [4, cloud], aSize: [2, size], aCell: [1, cell] });
  });
  const material = useDisposable(() =>
    shaderMaterial({
      uniforms: {
        uTime: uniforms.uTime,
        uSkyLow: uniforms.uSkyLow,
        uMap: uniform<THREE.Texture | null>(null),
        uCloudLit: uniform(new THREE.Vector3(...look.cloudLit)),
        uCloudShade: uniform(new THREE.Vector3(...look.cloudShade)),
      },
      transparent: true,
      depthWrite: false,
      premultipliedAlpha: true,
      vertexShader: cloudVertex,
      fragmentShader: cloudFragment,
    }),
  );
  material.uniforms.uMap.value = texture;
  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={-900} />;
}

/** Far hills: a hazy band beyond the park, drawn on a cylinder. */
const hillsFragment = /* glsl */ `
${OUTDOOR}
varying vec3 vWorld;
float ridge(float x, float f, float s) { return sin(x * f + s) * 0.5 + sin(x * f * 2.3 + s * 1.7) * 0.25 + sin(x * f * 5.1 + s * 0.3) * 0.1; }
void main() {
  vec3 w = vWorld;
  float a = atan(w.x - AXIS.x, w.z - AXIS.z);
  float far = 10.0 + ridge(a, 4.0, 1.0) * 12.0;
  float near = 2.0 + ridge(a, 7.0, 4.0) * 5.0;
  vec3 col;
  float alpha = 1.0;
  vec3 light = uAmbUp * 1.1 + uSun * 0.3;
  if (w.y < near) col = mix(vec3(0.36, 0.66, 0.3), vec3(0.5, 0.78, 0.36), smoothstep(near - 8.0, near, w.y)) * light;
  else if (w.y < far) col = mix(vec3(0.5, 0.7, 0.62), vec3(0.62, 0.8, 0.78), smoothstep(far - 10.0, far, w.y)) * light;
  else { col = vec3(0.0); alpha = 0.0; }
  float px = fwidth(w.y) * 1.5;
  alpha *= 1.0 - smoothstep(far - px, far + px, w.y);
  col = mix(col, SKY_HAZE, 0.3);
  gl_FragColor = vec4(col * alpha, alpha);
}
`;

const outdoorVertex = /* glsl */ `
attribute vec3 aColor;
attribute float aGloss;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vColor;
varying float vGloss;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vColor = aColor;
  vGloss = aGloss;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

/** Lit outdoor surfaces: lawn, towers, guideway. Towers get glass bands and green terraces. */
const outdoorFragment = /* glsl */ `
${OUTDOOR}
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vColor;
varying float vGloss;
void main() {
  vec3 n = normalize(vNormal);
  vec3 w = vWorld;
  vec3 v = normalize(cameraPosition - w);
  vec3 albedo = vColor;
  float gloss = vGloss;
  float lightOn = 0.0;
  if (vGloss > 1.5) {
    // Towers: ribbon glazing between white bands, every fourth band planted.
    float floorH = fract(w.y / 4.0);
    float band = floor(w.y / 4.0);
    float glass = smoothstep(0.3, 0.36, floorH) * smoothstep(0.92, 0.86, floorH);
    float plant = step(mod(band, 4.0), 0.5) * (1.0 - glass);
    albedo = mix(vec3(0.9, 0.93, 0.95), vec3(0.02, 0.12, 0.22), glass);
    albedo = mix(albedo, vec3(0.22, 0.55, 0.14), plant);
    gloss = mix(0.3, 1.1, glass);
    // After dark, a scatter of lit windows.
    float a = atan(w.x - AXIS.x, w.z - AXIS.z) * 600.0;
    float lit = step(0.45, fract(sin(dot(vec2(floor(a / 3.0), band), vec2(12.9898, 78.233))) * 43758.5453));
    lightOn = glass * lit * uLamps;
  } else if (n.y > 0.9 && w.y < 0.5) {
    // Lawn with soft mowing stripes.
    float stripe = sin((w.x * 0.6 + w.z * 0.3) * 0.5) * 0.5 + 0.5;
    albedo *= 0.9 + 0.15 * stripe;
    gloss = 0.05;
  }
  vec3 col = outdoorLight(albedo, n, v, gloss) + uLamp * lightOn * 1.2;
  gl_FragColor = vec4(outdoorHaze(col, w), 1.0);
}
`;

function buildOutdoor(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const add = (g: THREE.BufferGeometry, color: readonly number[], gloss: number) => parts.push(fill(fill(g, 'aColor', color), 'aGloss', [gloss]));
  // The park.
  add(new THREE.CircleGeometry(400, 64).rotateX(-Math.PI / 2).translate(AXIS.x, -0.05, AXIS.z), [0.3, 0.6, 0.18], 0);
  // White eco-towers with rounded crowns.
  const rand = makeRandom(91);
  const towers: [theta: number, dist: number, radius: number, height: number][] = [
    [1.55, 210, 12, 92], [1.95, 300, 16, 150], [2.3, 175, 9, 70], [2.6, 260, 13, 118], [3.0, 330, 15, 96], [1.2, 250, 11, 80],
  ];
  for (const [theta, dist, radius, height] of towers) {
    const p = polar(dist, theta + rand.range(-0.03, 0.03));
    add(new THREE.CylinderGeometry(radius * 0.86, radius, height, 28, 1, true).translate(p.x, height / 2, p.z), [1, 1, 1], 2);
    add(new THREE.SphereGeometry(radius * 0.86, 28, 10, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.6, 1).translate(p.x, height, p.z), [0.95, 0.97, 0.99], 0.9);
  }
  // The guideway: a white beam on slender pylons.
  const R = RING_R;
  const H = RING_Y;
  const beam: ProfilePoint[] = [[R - 1.1, H - 1.9], [R + 1.1, H - 1.9], [R + 1.2, H - 2.6], [R + 0.8, H - 3.4], [R - 0.8, H - 3.4], [R - 1.2, H - 2.6], [R - 1.1, H - 1.9]];
  add(sweepArc(beam, RING_THETA[0], RING_THETA[1], 120), [0.94, 0.95, 0.97], 0.6);
  for (let theta = RING_THETA[0] + 0.1; theta < RING_THETA[1]; theta += 0.34) {
    const p = polar(R, theta);
    add(new THREE.CylinderGeometry(0.7, 1.0, H - 3.2, 14, 1).translate(p.x, (H - 3.2) / 2, p.z), [0.94, 0.95, 0.97], 0.5);
  }
  return mergeAll(parts);
}

/** The sky's lower half beyond the glass: park, hills, towers and the guideway. */
export function Landscape() {
  const { uniforms } = useAtrium();
  const geometry = useDisposable(buildOutdoor);
  const material = useDisposable(() =>
    shaderMaterial({ uniforms: { ...uniforms }, vertexShader: outdoorVertex, fragmentShader: outdoorFragment }),
  );
  const hills = useDisposable(() => sweepArc([[520, 60], [520, -10]], 0.4, 3.9, 96));
  const hillsMaterial = useDisposable(() =>
    shaderMaterial({
      uniforms: { ...uniforms },
      transparent: true,
      depthWrite: false,
      premultipliedAlpha: true,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() { vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }
      `,
      fragmentShader: hillsFragment,
    }),
  );
  return (
    <>
      <mesh geometry={hills} material={hillsMaterial} renderOrder={-800} />
      {/* After the room, which hides most of it. */}
      <mesh geometry={geometry} material={material} renderOrder={-5} />
    </>
  );
}

const trainVertex = /* glsl */ `
attribute float aPhase;
uniform float uTime;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vLocal;
${LAYOUT_GLSL}
void main() {
  // The body is built along +x; bend it round the ring at its place on the loop.
  vLocal = position;
  float theta = aPhase + uTime * ${TRAIN_SPEED.toFixed(4)} + position.x / ${RING_R.toFixed(1)};
  vec3 radial = vec3(sin(theta), 0.0, cos(theta));
  vec3 along = vec3(cos(theta), 0.0, -sin(theta));
  vec3 w = AXIS + radial * (${RING_R.toFixed(1)} + position.z) + vec3(0.0, ${RING_Y.toFixed(1)} + position.y, 0.0);
  vNormal = normalize(along * normal.x + vec3(0.0, normal.y, 0.0) + radial * normal.z);
  vWorld = w;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}
`;

const trainFragment = /* glsl */ `
${OUTDOOR}
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vLocal;
void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(cameraPosition - vWorld);
  vec3 lp = vLocal;
  float halfLen = ${(TRAIN_LEN / 2).toFixed(2)};
  // Livery, seen mostly from below: dark glass windows along the waist, a deep blue skirt with
  // a lime pinstripe, car joints, and an aqua glow under the floor.
  float win = smoothstep(-0.25, -0.15, lp.y) * smoothstep(0.75, 0.65, lp.y) * step(abs(lp.x), halfLen - 2.5);
  float nose = smoothstep(halfLen - 3.8, halfLen - 2.2, abs(lp.x)) * smoothstep(-0.2, 0.2, lp.y) * smoothstep(1.2, 0.8, lp.y);
  float glass = max(win, nose);
  float skirt = smoothstep(-0.55, -0.62, lp.y);
  float stripe = smoothstep(-0.38, -0.34, lp.y) * smoothstep(-0.26, -0.3, lp.y);
  float joint = step(abs(fract(lp.x / 10.0 + 0.5) - 0.5) * 10.0, 0.15) * step(abs(lp.x), halfLen - 4.0);
  vec3 albedo = vec3(0.95, 0.96, 0.98);
  albedo = mix(albedo, vec3(0.02, 0.28, 0.78), skirt);
  albedo = mix(albedo, vec3(0.5, 0.9, 0.08), stripe);
  albedo = mix(albedo, vec3(0.05, 0.17, 0.3), glass);
  albedo *= 1.0 - joint * 0.6;
  vec3 col = outdoorLight(albedo, n, v, mix(0.6, 0.45, glass));
  col += vec3(0.3, 0.95, 1.0) * smoothstep(-0.95, -1.1, lp.y) * 3.0;
  // Lit cabins after dark.
  col += uLamp * win * uLamps * 1.4;
  gl_FragColor = vec4(outdoorHaze(col, vWorld), 1.0);
}
`;

function buildTrain(): THREE.BufferGeometry {
  // A long capsule with stretched bullet noses, lying along x.
  const g = new THREE.CapsuleGeometry(1.5, TRAIN_LEN - 9, 8, 18).rotateZ(Math.PI / 2);
  const p = g.attributes.position;
  const core = (TRAIN_LEN - 9) / 2;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const over = Math.abs(x) - core;
    if (over > 0) p.setX(i, Math.sign(x) * (core + over * 3));
    // Flatter underside.
    if (p.getY(i) < -0.6) p.setY(i, -0.6 + (p.getY(i) + 0.6) * 0.75);
  }
  g.computeVertexNormals();
  return g;
}

/**
 * The trains' underglow haze: a ribbon round the ring under each train, facing the atrium, lit by
 * a soft band (the scene runs without bloom, so the glow is drawn rather than bled).
 */
const haloFragment = /* glsl */ `
uniform float uGlow;
varying vec3 vLocal;
void main() {
  float halfLen = ${(TRAIN_LEN / 2).toFixed(2)};
  // A bright core at the skirt and a wide soft spread, like bloom round an emissive strip.
  float y = vLocal.y + 1.05;
  float ends = smoothstep(halfLen + 4.0, halfLen - 6.0, abs(vLocal.x));
  float a = (exp(-y * y * 2.0) * 0.7 + exp(-abs(y) * 0.7) * 0.35) * ends;
  gl_FragColor = vec4(vec3(0.35, 0.95, 1.0) * a * uGlow, 1.0);
}
`;

const PHASES = [2.0, 2.0 + (Math.PI * 2) / 3, 2.0 + (Math.PI * 4) / 3];

/** Three maglev trains a third of a loop apart, gliding round the guideway. */
export function Maglev() {
  const { uniforms } = useAtrium();
  const geometry = useDisposable(() => instanced(buildTrain(), 3, { aPhase: [1, new Float32Array(PHASES)] }));
  const halo = useDisposable(() => {
    // Facing the atrium (normal -z in the train's frame), just in front of the train.
    const plane = new THREE.PlaneGeometry(TRAIN_LEN + 8, 9, 24, 1).rotateY(Math.PI).translate(0, -1.05, -2.2);
    return instanced(plane, 3, { aPhase: [1, new Float32Array(PHASES)] });
  });
  const material = useDisposable(() =>
    shaderMaterial({ uniforms: { ...uniforms }, vertexShader: trainVertex, fragmentShader: trainFragment }),
  );
  const haloMaterial = useDisposable(() =>
    shaderMaterial({
      uniforms: { ...uniforms, uGlow: { value: 1 + uniforms.uLamps.value * 0.4 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: trainVertex,
      fragmentShader: haloFragment,
    }),
  );
  return (
    <>
      <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={-5} />
      <mesh geometry={halo} material={haloMaterial} frustumCulled={false} renderOrder={5} />
    </>
  );
}
