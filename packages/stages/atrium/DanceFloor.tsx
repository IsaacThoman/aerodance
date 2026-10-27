import * as THREE from 'three';
import { useDisposable } from '../shared/hooks.ts';
import { shaderMaterial } from '../shared/glsl.ts';
import { DANCE_FLOOR } from './layout.ts';
import { AA, COMMON, WORLD_VERTEX } from './shading.ts';
import type { AtriumUniforms } from './shading.ts';

// The dancers' floor in front of the pool: a low round dais whose top is glass over shallow,
// sunlit water, in panes on a white grid like the dome's, rippling out from the middle on every
// beat; a white stone rim with a glowing aqua inlay, and a row of lights round its lip. The
// atrium's light is drawn by its shaders, so the dancers' shadows (from the stage's sun) fall on
// a shadow-only disc laid over its top.

const { center: CENTER, radius: RADIUS, top: TOP } = DANCE_FLOOR;
/** The white rim round the glass. */
const RIM = 0.34;
const f = (n: number) => n.toFixed(4);

const floorFragment = /* glsl */ `
${COMMON}
${AA}
uniform float uBeat;
uniform float uBeatPhase;
varying vec3 vWorld;
varying vec3 vNormal;
const vec2 CENTER = vec2(${f(CENTER.x)}, ${f(CENTER.z)});
const float RADIUS = ${f(RADIUS)};
const float TOP = ${f(TOP)};
const float GLASS_R = ${f(RADIUS - RIM)};
void main() {
  vec3 w = vWorld;
  vec3 n = normalize(vNormal);
  vec3 v = normalize(cameraPosition - w);
  vec3 s = normalize(uSunDir);
  vec2 d = w.xz - CENTER;
  float r = length(d);
  float a = atan(d.x, d.y);
  float lit = sunLight(w);
  float sun = max(dot(n, s), 0.0) * lit;
  vec3 albedo = vec3(0.86, 0.88, 0.9);
  float gloss = 0.6;
  vec3 emit = vec3(0.0);
  float glass = 0.0;
  vec3 water = vec3(0.0);
  if (n.y > 0.7) {
    glass = smoothstep(GLASS_R + 0.01, GLASS_R - 0.01, r);
    // The water under the glass: deep aqua, caustics where the sun reaches it, a ring of light
    // spreading from the middle on each beat.
    vec2 cp = w.xz * 1.6;
    float ca = snoise(cp + vec2(0.23, 0.11) * uTime) + 0.5 * snoise(cp * 2.0 + 5.0 - vec2(0.15, -0.21) * uTime);
    float caustic = pow(max(1.0 - abs(ca), 0.0), 4.0);
    water = mix(vec3(0.0, 0.26, 0.42), vec3(0.02, 0.5, 0.66), smoothstep(GLASS_R, 0.0, r) * 0.6);
    water *= 0.7 + 0.45 * lit;
    water += vec3(0.35, 0.9, 1.0) * caustic * (0.08 + 0.32 * lit);
    float wave = uBeatPhase * GLASS_R * 1.1;
    water += vec3(0.3, 0.95, 1.0) * exp(-pow((r - wave) * 4.0, 2.0)) * (1.0 - uBeatPhase) * 0.6;
    // Panes on a white grid: spokes and rings, like the dome's ribs.
    float spokes = abs(fract(a / 6.2831853 * 12.0 + 0.5) - 0.5) * 6.2831853 / 12.0 * r;
    float rings = abs(fract(r / 0.75 + 0.5) - 0.5) * 0.75;
    float grid = max(aaLine(spokes, 0.025) * step(0.45, r), aaLine(rings, 0.025)) * step(0.2, r);
    glass *= 1.0 - grid;
    // The rim: polished white stone with an aqua inlay that glows with the beat.
    float inlay = smoothstep(RADIUS - 0.24, RADIUS - 0.22, r) * smoothstep(RADIUS - 0.12, RADIUS - 0.14, r);
    albedo = mix(albedo, vec3(0.2, 0.75, 0.9), inlay);
    emit += vec3(0.25, 0.85, 1.0) * inlay * (0.45 + 0.9 * uBeat);
  } else {
    // The lip: a row of round lights, brightest on the beat.
    float u = a / 6.2831853 * 72.0;
    vec2 cell = vec2((fract(u) - 0.5) * 6.2831853 * RADIUS / 72.0, w.y - TOP * 0.5);
    float lamp = smoothstep(0.03, 0.018, length(cell));
    emit += vec3(0.4, 0.95, 1.0) * lamp * (0.6 + 1.2 * uBeat);
    albedo = mix(albedo, vec3(0.35, 0.8, 0.9), lamp);
  }
  // Contact shade at the foot of the lip.
  float ao = mix(0.7, 1.0, smoothstep(0.0, TOP, w.y));
  vec3 col = albedo * (ambient(n) * ao + SUN * sun * 0.85);
  col = mix(col, water, glass);
  gloss = mix(gloss, 1.0, glass);
  float fres = 0.04 + 0.96 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
  col += roomReflect(reflect(-v, n)) * mix(0.05, 0.85, fres) * gloss * ao;
  col += SUN * pow(max(dot(reflect(-s, n), v), 0.0), 120.0) * sun * gloss * 1.6;
  col += emit;
  gl_FragColor = vec4(haze(col, w), 1.0);
}
`;

/** The soft shade the dais casts round its foot on the stone floor. */
const footFragment = /* glsl */ `
varying vec3 vWorld;
const vec2 CENTER = vec2(${f(CENTER.x)}, ${f(CENTER.z)});
const float RADIUS = ${f(RADIUS)};
void main() {
  float k = 1.0 - smoothstep(0.0, 0.6, length(vWorld.xz - CENTER) - RADIUS);
  float a = k * k * 0.32;
  gl_FragColor = vec4(vec3(0.05, 0.1, 0.14) * a, a);
}
`;

function buildDais(): THREE.BufferGeometry {
  // Up the lip and in across the top, so the normals face out and up.
  const profile = [[RADIUS + 0.03, 0], [RADIUS + 0.01, 0.02], [RADIUS, TOP - 0.06], [RADIUS - 0.03, TOP - 0.02], [RADIUS - 0.1, TOP], [0, TOP]]
    .map(([r, y]) => new THREE.Vector2(r, y));
  return new THREE.LatheGeometry(profile, 96).translate(CENTER.x, 0, CENTER.z);
}

export function DanceFloor({ uniforms }: { uniforms: AtriumUniforms }) {
  const geometry = useDisposable(buildDais);
  const material = useDisposable(() => shaderMaterial({ uniforms: { ...uniforms }, vertexShader: WORLD_VERTEX, fragmentShader: floorFragment }), [uniforms]);
  const foot = useDisposable(() => new THREE.RingGeometry(RADIUS, RADIUS + 0.6, 96, 1).rotateX(-Math.PI / 2).translate(CENTER.x, 0.004, CENTER.z));
  const footMaterial = useDisposable(() =>
    shaderMaterial({
      uniforms: {},
      transparent: true,
      depthWrite: false,
      premultipliedAlpha: true,
      vertexShader: WORLD_VERTEX,
      fragmentShader: footFragment,
    }),
  );
  const shade = useDisposable(() => new THREE.CircleGeometry(RADIUS - 0.08, 64).rotateX(-Math.PI / 2).translate(CENTER.x, TOP + 0.003, CENTER.z));
  const shadeMaterial = useDisposable(() => new THREE.ShadowMaterial({ color: '#163650', opacity: 0.34, depthWrite: false }));
  return (
    <>
      <mesh geometry={geometry} material={material} />
      <mesh geometry={foot} material={footMaterial} renderOrder={1} />
      <mesh geometry={shade} material={shadeMaterial} receiveShadow renderOrder={1} />
    </>
  );
}
