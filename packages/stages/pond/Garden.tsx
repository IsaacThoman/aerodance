import { shaderMaterial } from '../shared/glsl.ts';
import { useDisposable } from '../shared/hooks.ts';
import { KIND, gardenGeometry } from './garden.ts';
import { gardenGLSL, pondGLSL } from './shaders.ts';
import type { PondUniforms } from './shaders.ts';

// The garden round the pond (garden.ts) in one draw. Each vertex says what it is, which picks its
// detail and its shine here; blossom and needles sway in the breeze, the lanterns glow, and the
// stones and the bridge's legs sink under the water's surface like the koi.

const gardenVertex = /* glsl */ `
uniform float uTime;
attribute float aKind;
attribute float aSway;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vColor;
varying float vKind;

void main() {
  vec3 p = position;
  if (aSway > 0.0) {
    float ph = p.x * 0.3 + p.z * 0.25;
    p.x += (sin(uTime * 0.9 + ph) + 0.4 * sin(uTime * 2.1 + ph * 2.3)) * aSway * 0.12;
    p.z += sin(uTime * 0.7 + ph * 1.3 + 1.0) * aSway * 0.08;
  }
  vec4 world = modelMatrix * vec4(p, 1.0);
  vWorld = world.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vColor = color;
  vKind = aKind;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const k = (name: keyof typeof KIND) => `${KIND[name].toFixed(1)}`;

const gardenFragment = /* glsl */ `
${pondGLSL}
${gardenGLSL}
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vColor;
varying float vKind;

bool kindIs(float kind) { return abs(vKind - kind) < 0.5; }

void main() {
  vec3 n = normalize(vNormal);
  vec3 p = vWorld;
  vec3 v = normalize(cameraPosition - p);
  vec3 albedo = vColor;
  float wrap = 0.2;
  float gloss = 0.04;
  float shine = 0.0;
  vec3 glow = vec3(0.0);
  if (kindIs(${k('stone')}) || kindIs(${k('lantern')})) {
    // Speckled granite, mossy where it faces the sky.
    albedo *= 0.86 + 0.16 * snoise(p * 3.1) + 0.08 * snoise(p * 9.0);
    float moss = smoothstep(0.35, 0.85, n.y) * smoothstep(-0.3, 0.5, snoise(p * 1.4 + 4.0)) * step(0.0, p.y);
    albedo = mix(albedo, vec3(0.07, 0.24, 0.03), moss * (kindIs(${k('stone')}) ? 0.85 : 0.45));
    gloss = 0.08;
  } else if (kindIs(${k('bark')})) {
    albedo *= 0.78 + 0.3 * smoothstep(-0.6, 0.6, snoise(vec3(p.x * 7.0, p.y * 1.2, p.z * 7.0)));
  } else if (kindIs(${k('blossom')})) {
    // Clusters of blossom with shadowy gaps between, and paler flowers catching the light.
    float clump = snoise(p * 1.9) * 0.6 + snoise(p * 5.5) * 0.4;
    albedo *= mix(0.6, 1.08, smoothstep(-0.55, 0.55, clump));
    albedo = mix(albedo, vec3(1.0, 0.8, 0.86), smoothstep(0.5, 0.95, snoise(p * 10.0)) * 0.35);
    wrap = 0.7;
    gloss = 0.02;
    // The sun glowing through the petals from behind.
    glow = vColor * vec3(1.0, 0.45, 0.55) * pow(max(dot(-v, uSun), 0.0), 3.0) * 0.4;
  } else if (kindIs(${k('needles')})) {
    albedo *= mix(0.55, 1.2, smoothstep(-0.5, 0.6, snoise(p * 4.2) * 0.7 + snoise(p * 11.0) * 0.3));
    wrap = 0.45;
  } else if (kindIs(${k('leaves')})) {
    albedo *= 0.82 + 0.3 * smoothstep(-0.5, 0.5, snoise(p * 6.0));
    gloss = 0.2;
    wrap = 0.35;
  } else if (kindIs(${k('flowers')})) {
    // Azaleas: flowers packed over the mound, the leaves showing through in soft patches.
    float bloom = snoise(p * 2.2) * 0.7 + snoise(p * 7.0) * 0.3;
    albedo = mix(vec3(0.05, 0.18, 0.03), albedo * mix(0.82, 1.08, smoothstep(0.0, 0.8, bloom)), smoothstep(-0.8, -0.2, bloom) * 0.75 + 0.25);
    gloss = 0.08;
    wrap = 0.4;
  } else if (kindIs(${k('lacquer')})) {
    gloss = 0.9;
    shine = 0.35;
  } else if (kindIs(${k('wood')})) {
    albedo *= 0.85 + 0.15 * sin(dot(p.xz, vec2(0.408, 0.913)) * 40.0);
  } else if (kindIs(${k('brass')})) {
    gloss = 1.6;
    shine = 0.8;
  }
  vec3 col = gardenLight(albedo, n, p, wrap, gloss) + glow;
  if (shine > 0.0) {
    // Lacquer and brass mirror the garden.
    float fres = 0.04 + 0.96 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
    col += mirrored(p, reflect(-v, n)) * albedo * shine * (0.3 + fres);
  }
  // The lanterns' light boxes glow warm, a little brighter at their hearts.
  if (kindIs(${k('glow')})) col = vColor * (1.4 + 0.6 * max(dot(n, v), 0.0));
  if (p.y < 0.0) col = underWater(col, p, 1.0);
  gl_FragColor = vec4(gardenHaze(col, p), 1.0);
}
`;

export function Garden({ shared }: { shared: PondUniforms }) {
  const garden = useDisposable(() => ({
    geometry: gardenGeometry(),
    material: shaderMaterial({ uniforms: { ...shared }, vertexShader: gardenVertex, fragmentShader: gardenFragment, vertexColors: true }),
  }), [shared]);

  return <mesh geometry={garden.geometry} material={garden.material} frustumCulled={false} />;
}
