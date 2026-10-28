import * as THREE from 'three';
import { shaderMaterial } from '../../stages/shared/glsl.ts';
import { useDisposable } from '../../stages/shared/hooks.ts';
import { makeRandom } from '../../stages/shared/random.ts';
import type { Vec3 } from '../../stages/catalog.ts';
import { PETAL_AREA } from './layout.ts';
import { pondGLSL } from './shaders.ts';
import type { PondUniforms } from './shaders.ts';

// ---------------------------------------------------------------------------
// Cherry petals and the sun's twinkles, each one instanced draw of quads shaped in the shader.
// A petal's life is a loop worked out from the clock alone: it flutters down out of the air,
// settles on the water, drifts with the current and slowly sinks away, then begins again
// somewhere else, so there is no state and nothing pops.
// ---------------------------------------------------------------------------

const PETALS = 52;
/** Seconds in a petal's life: falling, then floating, then sinking. */
const LIFE = { cycle: 44, fall: 8, sink: 6 };
const TWINKLES = 14;

/** An instanced copy of a quad, sharing its attributes. */
function quads(count: number): THREE.InstancedBufferGeometry {
  const base = new THREE.PlaneGeometry(1, 1);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setIndex(base.getIndex());
  geometry.setAttribute('position', base.getAttribute('position'));
  geometry.setAttribute('uv', base.getAttribute('uv'));
  geometry.instanceCount = count;
  return geometry;
}

const petalVertex = /* glsl */ `
${pondGLSL}
attribute vec4 aSeed;
varying vec2 vUv;
varying float vAlpha;
varying float vShade;
varying float vSunk;
varying float vSoft;

mat3 rotation(vec3 axis, float angle) {
  axis = normalize(axis);
  float s = sin(angle);
  float c = cos(angle);
  float oc = 1.0 - c;
  return mat3(
    oc * axis.x * axis.x + c, oc * axis.x * axis.y + axis.z * s, oc * axis.z * axis.x - axis.y * s,
    oc * axis.x * axis.y - axis.z * s, oc * axis.y * axis.y + c, oc * axis.y * axis.z + axis.x * s,
    oc * axis.z * axis.x + axis.y * s, oc * axis.y * axis.z - axis.x * s, oc * axis.z * axis.z + c);
}

void main() {
  const float CYCLE = ${LIFE.cycle.toFixed(1)};
  const float FALL = ${LIFE.fall.toFixed(1)};
  const float SINK = ${LIFE.sink.toFixed(1)};
  float tt = uTime + aSeed.x * CYCLE;
  float lap = floor(tt / CYCLE);
  float age = tt - lap * CYCLE;
  // Each lap lands somewhere new.
  vec2 h = hash22(vec2(lap * 1.37 + aSeed.y * 91.0, aSeed.z * 47.0));
  vec2 land = mix(vec2(${PETAL_AREA.min[0].toFixed(2)}, ${PETAL_AREA.min[1].toFixed(2)}), vec2(${PETAL_AREA.max[0].toFixed(2)}, ${PETAL_AREA.max[1].toFixed(2)}), h);
  float fall = clamp(age / FALL, 0.0, 1.0);
  float air = 1.0 - fall;
  // Falling: fluttering in loose spirals, carried by the breeze, slowing as it nears the water.
  float height = 5.5 * air * air * (3.0 - 2.0 * air) + 0.012;
  vec2 flutter = vec2(sin(age * 1.7 + aSeed.w * 6.3), cos(age * 1.3 + aSeed.y * 6.3)) * 0.45 * air;
  vec2 breeze = vec2(-1.6, -0.6) * air * air;
  // Floating: drifting on a slow current that meanders.
  float drift = max(age - FALL, 0.0);
  vec2 current = vec2(0.055, 0.025) * drift + vec2(sin(drift * 0.11 + aSeed.y * 9.0), cos(drift * 0.09 + aSeed.z * 9.0)) * 0.25 * min(drift * 0.2, 1.0);
  vec2 xz = land + flutter + breeze + current;
  vec3 sw = swell(xz);
  float sinking = smoothstep(CYCLE - SINK, CYCLE, age);
  float y = mix(height, sw.z * 0.9 + 0.012, fall * fall) - sinking * 0.12;

  // Tumbling in the air; lying flat (turning slowly) on the water.
  float size = 0.34 + 0.12 * aSeed.w;
  vec3 local = vec3(position.x * size, 0.0, position.y * size * 1.15);
  vec3 axis = vec3(sin(aSeed.y * 17.0), 0.6, cos(aSeed.z * 13.0));
  float tumble = age * (2.2 + 1.5 * aSeed.z) * air;
  float spin = aSeed.w * 6.28 + drift * 0.05;
  mat3 lie = rotation(vec3(0.0, 1.0, 0.0), spin);
  vec3 p = lie * local;
  vec3 n = lie * vec3(0.0, 1.0, 0.0);
  if (air > 0.0) {
    mat3 r = rotation(axis, tumble);
    p = r * p;
    n = r * n;
  }
  vec3 world = vec3(xz.x, y, xz.y) + p;
  vec3 v = normalize(cameraPosition - world);
  vShade = 0.55 + 0.45 * abs(dot(n, uSun)) + 0.25 * pow(abs(dot(n, normalize(uSun + v))), 30.0);
  vAlpha = smoothstep(0.0, 1.5, age) * (1.0 - smoothstep(CYCLE - SINK * 0.6, CYCLE, age));
  vSunk = sinking;
  // Petals close to the camera are a little out of focus.
  vSoft = 0.06 + 0.25 * (1.0 - smoothstep(3.0, 9.0, distance(world, cameraPosition)));
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const petalFragment = /* glsl */ `
varying vec2 vUv;
varying float vAlpha;
varying float vShade;
varying float vSunk;
varying float vSoft;

void main() {
  // A rounded petal narrowing to its base, with a small notch at the tip.
  vec2 p = vUv * 2.0 - 1.0;
  p.y = -p.y;
  float w = 0.8 * sqrt(max(1.0 - p.y * p.y, 0.0)) * (0.45 + 0.55 * smoothstep(-1.0, 0.4, p.y));
  float body = abs(p.x) - w;
  float notch = 0.22 - length(vec2(p.x * 1.4, p.y - 1.05));
  float d = max(body, notch);
  float soft = vSoft + fwidth(d) * 1.2;
  float shape = 1.0 - smoothstep(-soft, soft * 0.5, d);
  float tip = smoothstep(-0.9, 0.9, p.y);
  vec3 col = mix(vec3(1.0, 0.86, 0.9), vec3(0.98, 0.52, 0.68), tip * 0.75 + abs(p.x) * 0.3);
  col *= vShade;
  // Sinking petals take on the water's colour.
  col = mix(col, vec3(0.2, 0.42, 0.4), vSunk * 0.7);
  gl_FragColor = vec4(col, shape * vAlpha * 0.95);
}
`;

const twinkleVertex = /* glsl */ `
${pondGLSL}
attribute vec4 aSeed;
uniform vec3 uCentre;
uniform vec2 uSpread;
varying vec2 vUv;
varying float vGlow;

void main() {
  // Each twinkle flares and fades on its own beat, moving somewhere new while it is dark.
  float period = 2.6 + 2.2 * aSeed.x;
  float tt = uTime / period + aSeed.y;
  float lap = floor(tt);
  float ph = tt - lap;
  vec2 h = hash22(vec2(lap, aSeed.z * 61.0)) * 2.0 - 1.0;
  vec3 centre = uCentre + vec3(h.x * uSpread.x, 0.02, h.y * uSpread.y);
  float flare = pow(sin(3.14159 * ph), 6.0);
  // Brightest at the heart of the glitter.
  vGlow = flare * (1.0 - 0.6 * dot(h, h));
  vec4 view = viewMatrix * vec4(centre, 1.0);
  float size = (0.5 + 0.5 * aSeed.w) * (0.4 + 0.6 * flare);
  view.xy += position.xy * size;
  vUv = uv;
  gl_Position = projectionMatrix * view;
}
`;

const twinkleFragment = /* glsl */ `
varying vec2 vUv;
varying float vGlow;

void main() {
  // A four-pointed star with a soft core, bright enough to bloom.
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float core = exp(-r * r * 30.0);
  float rays = exp(-abs(p.x) * 40.0) * exp(-abs(p.y) * 3.5) + exp(-abs(p.y) * 40.0) * exp(-abs(p.x) * 3.5);
  vec2 q = vec2(p.x + p.y, p.x - p.y) * 0.7071;
  rays += 0.35 * (exp(-abs(q.x) * 50.0) * exp(-abs(q.y) * 6.0) + exp(-abs(q.y) * 50.0) * exp(-abs(q.x) * 6.0));
  float glow = (core * 2.5 + rays * 1.4) * (1.0 - smoothstep(0.7, 1.0, r)) * vGlow;
  gl_FragColor = vec4(vec3(1.0, 0.96, 0.86) * glow * 3.0, 1.0);
}
`;

/** Where on the water the sun's glitter is centred (world x, z). */
function glitterCentre(sun: THREE.Vector3, camera: Vec3): THREE.Vector3 {
  // The mirror image of the sun: where the camera's line of sight reflects straight into it.
  const down = new THREE.Vector3(sun.x, -sun.y, sun.z);
  const t = camera[1] / sun.y;
  return new THREE.Vector3(camera[0], camera[1], camera[2]).addScaledVector(down, t);
}

export function Petals({ shared, camera }: { shared: PondUniforms; camera: Vec3 }) {
  const petals = useDisposable(() => {
    const random = makeRandom(41);
    const geometry = quads(PETALS);
    const seeds = new Float32Array(PETALS * 4);
    for (let i = 0; i < PETALS; i++) seeds.set([(i + random.next() * 0.6) / PETALS, random.next(), random.next(), random.next()], i * 4);
    geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    const material = shaderMaterial({
      uniforms: { ...shared },
      vertexShader: petalVertex,
      fragmentShader: petalFragment,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    return { geometry, material };
  }, [shared]);

  const twinkles = useDisposable(() => {
    const random = makeRandom(7);
    const geometry = quads(TWINKLES);
    const seeds = new Float32Array(TWINKLES * 4);
    for (let i = 0; i < TWINKLES; i++) seeds.set([random.next(), random.next(), random.next(), random.next()], i * 4);
    geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    const material = shaderMaterial({
      uniforms: { ...shared, uCentre: { value: glitterCentre(shared.uSun.value, camera) }, uSpread: { value: new THREE.Vector2(3.2, 1.6) } },
      vertexShader: twinkleVertex,
      fragmentShader: twinkleFragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    return { geometry, material };
  }, [shared, camera]);

  return (
    <>
      <mesh geometry={petals.geometry} material={petals.material} renderOrder={5} frustumCulled={false} />
      <mesh geometry={twinkles.geometry} material={twinkles.material} renderOrder={6} frustumCulled={false} />
    </>
  );
}
