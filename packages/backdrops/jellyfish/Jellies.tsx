import { useMemo } from 'react';
import * as THREE from 'three';
import { useDisposable } from '../../stages/shared/hooks.ts';
import { makeRandom } from '../../stages/shared/random.ts';
import { shaderMaterial } from '../../stages/shared/glsl.ts';
import { ARMS, STRANDS, TENTACLES, makeJellies } from './layout.ts';
import type { JellyData } from './layout.ts';
import { jellyMotionGLSL, paletteGLSL } from './shaders.ts';
import type { SharedUniforms } from './shaders.ts';

// Premultiplied: a jelly mostly glows (adds light) and only dims what's behind it a little, so
// the order they overlap in hardly matters.
const GLOW_BLEND = {
  transparent: true,
  depthWrite: false,
  depthTest: false,
  blending: THREE.CustomBlending,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneMinusSrcAlphaFactor,
} as const;

// An instanced copy of `base`'s vertices carrying the jellies' data, `repeat` instances a jelly.
function instanced(base: THREE.BufferGeometry, jellies: JellyData, repeat = 1): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  g.index = base.index;
  g.setAttribute('position', base.attributes.position);
  g.setAttribute('uv', base.attributes.uv);
  const spread = (src: Float32Array) => {
    const out = new Float32Array(src.length * repeat);
    for (let i = 0; i < jellies.count; i++) for (let k = 0; k < repeat; k++) out.set(src.subarray(i * 4, i * 4 + 4), (i * repeat + k) * 4);
    return new THREE.InstancedBufferAttribute(out, 4);
  };
  g.setAttribute('aJ0', spread(jellies.j0));
  g.setAttribute('aJ1', spread(jellies.j1));
  g.setAttribute('aJ2', spread(jellies.j2));
  g.setAttribute('aJ3', spread(jellies.j3));
  g.instanceCount = jellies.count * repeat;
  return g;
}

// ---------------------------------------------------------------------------
// Bells: a lathe grid shaped in the vertex shader (bellPoint), so the squeeze, the scallops and
// the normals all come from one function. Fresnel-lit glass with glowing gonads, canals and a
// beaded margin, and an Aero window highlight.
// ---------------------------------------------------------------------------

const bellVertex = /* glsl */ `
${jellyMotionGLSL}
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vViewNormal;
varying float vS;
varying float vAng;
varying float vSqueeze;
varying float vHue;
varying float vFade;
varying float vGonads;
void main() {
  float t = uTime;
  float spin = t * 0.04 * (aJ0.w > 0.5 ? 1.0 : -1.0) + aJ0.w * 20.0;
  float a = uv.x * 6.2831853 + spin;
  float s = 1.0 - uv.y;
  float sq = jellySqueeze(jellyPhase(t));
  vec3 p = bellPoint(s, a, sq);
  // Normal from the surface's slopes (kept off the apex, where they vanish).
  float sn = max(s, 0.02);
  vec3 q = bellPoint(sn, a, sq);
  vec3 n = normalize(cross(bellPoint(sn, a + 0.02, sq) - q, bellPoint(sn + 0.02, a, sq) - q));
  mat3 basis = jellyBasis(t);
  vec3 c = jellyCenter(t);
  c.y += jellyWrap(t);
  vec3 wp = c + basis * p * aJ1.x;
  vWorld = wp;
  vNormal = basis * n;
  vViewNormal = mat3(viewMatrix) * vNormal;
  vS = s;
  vAng = a;
  vSqueeze = sq;
  vHue = aJ1.y;
  vFade = jellyFade(c);
  vGonads = aJ3.z;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const bellFragment = /* glsl */ `
uniform vec3 uSun;
${paletteGLSL}
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vViewNormal;
varying float vS;
varying float vAng;
varying float vSqueeze;
varying float vHue;
varying float vFade;
varying float vGonads;
void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(cameraPosition - vWorld);
  float facing = dot(n, v);
  float front = step(0.0, facing);
  float ndv = abs(facing);
  float fr = pow(max(1.0 - ndv, 0.0), 1.8);
  // The silhouette itself and the scalloped margin fade out: soft edges rather than stairs in
  // the unsmoothed 640x480 buffer.
  float soft = smoothstep(0.0, 0.2, ndv) * smoothstep(1.0, 0.95, vS);
  vec3 tint = jellyPal(vHue);
  vec3 rimTint = jellyPal(vHue + 0.1);
  // Both walls draw; the far one, seen through the near, dimmer.
  float wall = mix(0.6, 1.0, front);

  // Clear glass in the middle, coloured and glowing towards its silhouette, brighter as it
  // squeezes.
  vec3 col = tint * (0.02 + 0.7 * fr) * (1.0 + 0.5 * vSqueeze);
  float alpha = 0.1 + 1.1 * fr;
  // Eight soft radial canals.
  float canal = pow(min(abs(cos(vAng * 4.0)), 1.0), 24.0) * smoothstep(0.15, 0.5, vS) * smoothstep(0.92, 0.75, vS);
  col += tint * canal * 0.2;
  alpha += canal * 0.05;
  // The four gonads, the jelly's glowing heart: mostly on the far wall, so they sit inside.
  float lobe = pow(max(0.5 + 0.5 * cos(vAng * 4.0 + 0.8), 0.0), 2.5);
  float g = (vS - 0.3) / 0.12;
  float gonad = lobe * exp(-g * g);
  gonad *= vGonads;
  // In a neighbouring hue, so they read against the bell.
  col += jellyPal(vHue + 0.67) * gonad * (0.6 + 0.8 * vSqueeze) * (1.0 - 0.6 * front);
  alpha += gonad * 0.2;
  // A soft glow filling the dome, strongest under the apex.
  col += tint * (1.0 - vS) * 0.08 * (1.0 + vSqueeze);
  // A glowing ring just inside the margin, with brighter beads of light at its scallops.
  float ring = smoothstep(0.84, 0.93, vS);
  float beads = 0.45 + 0.55 * pow(max(0.5 + 0.5 * cos(vAng * 16.0), 0.0), 3.0);
  col += mix(rimTint, vec3(1.0), 0.12) * ring * beads * (1.25 + 1.1 * vSqueeze);
  alpha += ring * 0.25;
  col *= wall * soft;
  alpha *= wall * soft;

  // Aero gloss on the outside: a soft window highlight up and left, and the sun's glint.
  vec3 nv = normalize(vViewNormal) * (front * 2.0 - 1.0);
  float window = smoothstep(0.955, 0.99, dot(nv, normalize(vec3(-0.45, 0.62, 0.64)))) * front;
  float spec = pow(max(dot(n, normalize(uSun + v)), 0.0), 160.0) * front;
  col += vec3(0.92, 0.98, 1.0) * (window * 0.75 + spec * 0.5);
  alpha += window * 0.25;

  gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0) * 0.55) * vFade;
}
`;

function Bells({ shared, jellies }: { shared: SharedUniforms; jellies: JellyData }) {
  const geometry = useDisposable(() => instanced(new THREE.PlaneGeometry(1, 1, 64, 18), jellies));
  const material = useDisposable(() =>
    shaderMaterial({
      ...GLOW_BLEND,
      side: THREE.DoubleSide,
      uniforms: { uTime: shared.uTime, uSun: shared.uSun },
      vertexShader: bellVertex,
      fragmentShader: bellFragment,
    }),
  );
  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={3} />;
}

// ---------------------------------------------------------------------------
// Strands: every tentacle and oral arm of every jelly in one draw. Each is a ribbon widened in
// screen space (never thinner than about 2.5 pixels, dimmed instead), whose points follow the
// bell's path a moment late, so they trail its drift and the squeeze ripples down them.
//   aT: angle round the bell; length (radii); phase; kind (0 tentacle, 1 oral arm)
// ---------------------------------------------------------------------------

const strandVertex = /* glsl */ `
${jellyMotionGLSL}
uniform vec2 uHalfRes;
attribute vec4 aT;
varying float vU;
varying float vAcross;
varying float vThin;
varying float vHue;
varying float vKind;
varying float vSeed;
varying float vFade;
varying float vSqueeze;

// Seconds the tip lags the bell: tentacles trail further behind than the arms.
float strandLag() { return aT.w > 0.5 ? 1.6 : 2.6; }

vec3 strandPoint(float u, float t, float wrap) {
  float lag = t - u * strandLag();
  vec3 c = jellyCenter(lag);
  c.y += wrap;
  mat3 basis = jellyBasis(lag);
  float sq = jellySqueeze(jellyPhase(lag));
  float len = aT.y;
  vec3 root;
  if (aT.w < 0.5) {
    root = bellPoint(0.97, aT.x, sq) * vec3(0.96, 1.0, 0.96);
  } else {
    // Oral arms leave the middle of the underside and spiral slowly round each other as they hang.
    float a = aT.x + u * 2.2 + sin(t * 0.21 + aT.z * 6.2831853) * 0.3;
    float r = 0.18 + 0.08 * sin(u * 6.0 + aT.z * 9.0);
    root = vec3(cos(a) * r, 0.3, sin(a) * r);
  }
  // Hang along the bell's axis at first, then straight down.
  vec3 hang = basis * vec3(0.0, -(u - 0.5 * u * u) * len, 0.0) + vec3(0.0, -0.5 * u * u * len, 0.0);
  // Waves running down the strand, growing towards the tip, and a current they all lean in.
  float ph = aT.z * 6.2831853;
  float w = u * u * len * (aT.w > 0.5 ? 0.06 : 0.13);
  vec3 sway = vec3(sin(t * 0.8 - u * 5.0 + ph), 0.0, cos(t * 0.63 - u * 4.0 + ph * 1.3)) * w;
  sway.x += sin(t * 1.3 - u * 11.0 + ph * 2.0) * u * len * 0.025;
  sway.x += sin(t * 0.07 + aJ0.w * 6.2831853) * u * u * len * 0.15;
  return c + (basis * root + hang + sway) * aJ1.x;
}

void main() {
  float t = uTime;
  float u = 1.0 - uv.y;
  float wrap = jellyWrap(t);
  vec3 p0 = strandPoint(u, t, wrap);
  vec3 p1 = strandPoint(u + 0.015, t, wrap);
  vec4 c0 = projectionMatrix * viewMatrix * vec4(p0, 1.0);
  vec4 c1 = projectionMatrix * viewMatrix * vec4(p1, 1.0);
  vec2 d = (c1.xy / c1.w - c0.xy / c0.w) * uHalfRes;
  d = dot(d, d) > 1e-8 ? normalize(d) : vec2(0.0, 1.0);

  // Width: tentacles a fine taper, arms broad frilly curtains that twist as they hang.
  float width;
  if (aT.w < 0.5) {
    width = 0.05 * (1.0 - 0.6 * u);
  } else {
    float twist = abs(cos(u * 6.0 - t * 0.5 + aT.z * 6.2831853));
    width = 0.42 * (1.0 - 0.6 * u) * (0.3 + 0.7 * twist) * (0.82 + 0.18 * sin(u * 34.0 + t * 0.9));
  }
  float px = width * aJ1.x * projectionMatrix[1][1] * uHalfRes.y / c0.w;
  float wpx = max(px, 2.6);
  vThin = px / wpx;
  c0.xy += vec2(-d.y, d.x) * (uv.x - 0.5) * wpx / uHalfRes * c0.w;

  vU = u;
  vAcross = uv.x * 2.0 - 1.0;
  vHue = aJ1.y;
  vKind = aT.w;
  vSeed = aT.z;
  vec3 center = jellyCenter(t);
  center.y += wrap;
  vFade = jellyFade(center);
  vSqueeze = jellySqueeze(jellyPhase(t - u * strandLag()));
  gl_Position = c0;
}
`;

const strandFragment = /* glsl */ `
uniform float uTime;
${paletteGLSL}
varying float vU;
varying float vAcross;
varying float vThin;
varying float vHue;
varying float vKind;
varying float vSeed;
varying float vFade;
varying float vSqueeze;
void main() {
  float x = vAcross;
  vec3 tint = jellyPal(vHue + 0.06);
  vec3 col;
  float a;
  if (vKind < 0.5) {
    // Soft core across, fading out along to the tip, with beads of light drifting down it.
    float core = exp(-x * x * 3.5);
    float along = smoothstep(0.0, 0.04, vU) * pow(max(1.0 - vU, 0.0), 1.4);
    float b = fract(vU * 7.0 - uTime * 0.12 + vSeed * 3.0) - 0.5;
    float bead = exp(-b * b * 120.0);
    col = mix(tint, vec3(1.0), 0.22) * (1.0 + 0.5 * vSqueeze + bead * 1.5);
    a = core * along * 0.6;
  } else {
    // A frilly curtain: brighter, ruffled edges and a soft middle.
    float ax = abs(x);
    float edge = smoothstep(0.35, 0.85, ax) * smoothstep(1.0, 0.8, ax);
    float body = smoothstep(1.0, 0.2, ax);
    float along = smoothstep(0.0, 0.08, vU) * pow(max(1.0 - vU, 0.0), 1.1);
    col = mix(tint, vec3(1.0), 0.08 + 0.25 * edge) * (0.6 + 0.9 * edge) * (1.0 + 0.3 * vSqueeze);
    a = (body * 0.4 + edge * 0.45) * along;
  }
  a *= vThin * vFade;
  gl_FragColor = vec4(col * a, a * 0.35);
}
`;

function Strands({ shared, jellies }: { shared: SharedUniforms; jellies: JellyData }) {
  const geometry = useDisposable(() => {
    const strip = new THREE.PlaneGeometry(1, 1, 1, 40);
    const g = instanced(strip, jellies, STRANDS);
    const rand = makeRandom(77);
    const data = new Float32Array(jellies.count * STRANDS * 4);
    for (let i = 0; i < jellies.count; i++) {
      const tentacle = jellies.lengths[i * 2];
      const armLength = jellies.lengths[i * 2 + 1];
      for (let k = 0; k < STRANDS; k++) {
        const arm = k >= TENTACLES;
        const angle = arm ? ((k - TENTACLES) / ARMS) * Math.PI * 2 + rand.range(-0.3, 0.3) : (k / TENTACLES) * Math.PI * 2 + rand.range(-0.12, 0.12);
        const len = arm ? armLength * rand.range(0.85, 1.15) : tentacle * rand.range(0.7, 1.05);
        data.set([angle, len, rand.next(), arm ? 1 : 0], (i * STRANDS + k) * 4);
      }
    }
    g.setAttribute('aT', new THREE.InstancedBufferAttribute(data, 4));
    return g;
  });
  const material = useDisposable(() =>
    shaderMaterial({
      ...GLOW_BLEND,
      side: THREE.DoubleSide,
      uniforms: { uTime: shared.uTime, uHalfRes: shared.uHalfRes },
      vertexShader: strandVertex,
      fragmentShader: strandFragment,
    }),
  );
  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={2} />;
}

// ---------------------------------------------------------------------------
// Halos: a soft coloured glow round each bell, the light it spills into the water.
// ---------------------------------------------------------------------------

const haloVertex = /* glsl */ `
${jellyMotionGLSL}
varying vec2 vP;
varying vec3 vTint;
varying float vA;
${paletteGLSL}
void main() {
  float t = uTime;
  vec3 c = jellyCenter(t);
  c.y += jellyWrap(t);
  float sq = jellySqueeze(jellyPhase(t));
  vec4 mv = viewMatrix * vec4(c + jellyBasis(t)[1] * 0.2 * aJ1.x, 1.0);
  vP = uv * 2.0 - 1.0;
  mv.xy += vP * aJ1.x * 3.2;
  vTint = jellyPal(aJ1.y);
  vA = jellyFade(c) * (0.8 + 0.35 * sq);
  gl_Position = projectionMatrix * mv;
}
`;

const haloFragment = /* glsl */ `
varying vec2 vP;
varying vec3 vTint;
varying float vA;
void main() {
  float r2 = dot(vP, vP);
  float glow = exp(-r2 * 5.0) * 0.5 + exp(-r2 * 18.0) * 0.5;
  gl_FragColor = vec4(vTint * glow * vA * 0.08, 0.0);
}
`;

function Halos({ shared, jellies }: { shared: SharedUniforms; jellies: JellyData }) {
  const geometry = useDisposable(() => instanced(new THREE.PlaneGeometry(1, 1), jellies));
  const material = useDisposable(() =>
    shaderMaterial({
      ...GLOW_BLEND,
      uniforms: { uTime: shared.uTime },
      vertexShader: haloVertex,
      fragmentShader: haloFragment,
    }),
  );
  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={1} />;
}

/** Every jelly: halos, then strands, then bells, each one draw for all of them. */
export function Jellies({ shared }: { shared: SharedUniforms }) {
  const jellies = useMemo(() => makeJellies(), []);
  return (
    <>
      <Halos shared={shared} jellies={jellies} />
      <Strands shared={shared} jellies={jellies} />
      <Bells shared={shared} jellies={jellies} />
    </>
  );
}
