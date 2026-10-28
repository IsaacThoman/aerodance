import * as THREE from 'three';
import { useDisposable } from '../shared/hooks.ts';
import { NOTCH, ORDER, STAGE_PAD, SUN_DIRECTION } from './layout.ts';

// The dancers' floor: a giant lily pad, a big one of the small pads round it (Lilies.tsx), with
// the same slit, fresh green, radiating veins, pale edge and bead of water. It's flat where the
// dancers stand, so it doesn't ride the swell. A lit standard material, so it takes their shadows;
// its outline fades over the last pixel like the small pads', drawn among them before the dancers.

const RINGS = [0, 0.16, 0.36, 0.56, 0.7, 0.8, 0.86, 0.91, 0.95, 0.98, 1];
const SEGMENTS = 120;

/** Height of the pad's top at u (0 middle .. 1 edge): flat under the dancers, then turning up at the edge. */
const lift = (u: number) => STAGE_PAD.curl * THREE.MathUtils.smoothstep(u, 0.78, 1) ** 1.4;

/** The pad, round from one side of its slit to the other. aPolar = (u, 0..1 around from the slit). */
function padGeometry(): THREE.BufferGeometry {
  const { radius: R, top, slit } = STAGE_PAD;
  const positions: number[] = [];
  const normals: number[] = [];
  const polar: number[] = [];
  const indices: number[] = [];
  const n = new THREE.Vector3();
  for (const u of RINGS) {
    const slope = (lift(Math.min(u + 0.01, 1)) - lift(Math.max(u - 0.01, 0))) / (0.02 * R);
    for (let j = 0; j <= SEGMENTS; j++) {
      const t = j / SEGMENTS;
      const a = slit + NOTCH + t * (Math.PI * 2 - 2 * NOTCH);
      positions.push(Math.cos(a) * u * R, top + lift(u), Math.sin(a) * u * R);
      n.set(-Math.cos(a) * slope, 1, -Math.sin(a) * slope).normalize();
      normals.push(n.x, n.y, n.z);
      polar.push(u, t);
    }
  }
  for (let i = 0; i < RINGS.length - 1; i++) {
    for (let j = 0; j < SEGMENTS; j++) {
      const a = i * (SEGMENTS + 1) + j;
      const b = a + SEGMENTS + 1;
      indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setAttribute('aPolar', new THREE.Float32BufferAttribute(polar, 2));
  g.setIndex(indices);
  return g;
}

const f = (n: number) => n.toFixed(4);

/** The bead of water: centre (x, z) and radius, out of the dancers' way behind them on the left. */
const BEAD = { at: [-0.9, -2.5], radius: 0.3 };
const sunFlat = new THREE.Vector2(SUN_DIRECTION[0], SUN_DIRECTION[2]).normalize();

const vertexHead = /* glsl */ `
attribute vec2 aPolar;
varying vec2 vPolar;
varying vec3 vPadWorld;
`;

const head = /* glsl */ `
varying vec2 vPolar;
varying vec3 vPadWorld;

// 0..1 inside the bead, with d the point's offset from its middle in radii.
float bead(out vec2 d) {
  d = (vPadWorld.xz - vec2(${f(BEAD.at[0])}, ${f(BEAD.at[1])})) / ${f(BEAD.radius)};
  return 1.0 - smoothstep(0.85, 1.0, length(d));
}
`;

// The small pads' fresh green, darkening to the edge, with lighter veins and a pale rim.
const colorPatch = /* glsl */ `
{
  float r = vPolar.x;
  float around = vPolar.y;
  vec3 centre = vec3(0.3, 0.58, 0.07);
  vec3 edge = vec3(0.08, 0.36, 0.03);
  vec3 col = mix(centre, edge, smoothstep(0.15, 1.0, r));
  float va = around * 34.0 + 0.15 * sin(r * 9.0 + 3.0);
  float vd = abs(fract(va) - 0.5) * 2.0;
  float vein = smoothstep(1.0 - (0.06 + fwidth(va) * 1.5), 1.0, vd) * smoothstep(0.06, 0.3, r) * (1.0 - smoothstep(0.7, 0.95, r));
  col = mix(col, col * 1.25 + vec3(0.02, 0.03, 0.0), vein * 0.3);
  col = mix(col, edge * 1.6 + vec3(0.06, 0.08, 0.0), smoothstep(0.9, 0.985, r) * 0.6);
  // The bead: the leaf seen a little darker through it.
  vec2 bd;
  col = mix(col, col * 0.75 + vec3(0.02, 0.04, 0.03), bead(bd));
  // Lit by the stage's lights rather than the small pads' own, so brighter to match them.
  diffuseColor.rgb = col * 1.45;
  // Soft edges: over the last pixel or so of the rim and along the slit.
  float px = length(fwidth(vPadWorld.xz));
  float rimDist = (1.0 - r) * ${f(STAGE_PAD.radius)};
  float slitDist = min(around, 1.0 - around) * ${f(Math.PI * 2 - 2 * NOTCH)} * r * ${f(STAGE_PAD.radius)};
  diffuseColor.a = smoothstep(0.0, px * 1.5, min(rimDist, slitDist));
}
`;

// The bead's glint towards the sun and the caustic crescent opposite it.
const emissivePatch = /* glsl */ `
{
  vec2 bd;
  float drop = bead(bd);
  totalEmissiveRadiance += vec3(1.0, 0.95, 0.84) * 3.0 * (1.0 - smoothstep(0.0, 0.32, length(bd - vec2(${f(sunFlat.x * 0.46)}, ${f(sunFlat.y * 0.46)})))) * drop;
  totalEmissiveRadiance += vec3(0.5, 0.7, 0.3) * smoothstep(0.45, 0.85, length(bd + vec2(${f(sunFlat.x * 0.32)}, ${f(sunFlat.y * 0.32)}))) * drop * 0.5;
}
`;

function padMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    roughness: 0.42,
    metalness: 0,
    envMapIntensity: 0.3,
    transparent: true,
    side: THREE.DoubleSide,
  });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${vertexHead}`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPolar = aPolar;\nvPadWorld = (modelMatrix * vec4(position, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${head}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${colorPatch}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${emissivePatch}`);
  };
  material.customProgramCacheKey = () => 'pond-stage-pad';
  return material;
}

export function StagePad() {
  const pad = useDisposable(() => ({ geometry: padGeometry(), material: padMaterial() }));
  return <mesh geometry={pad.geometry} material={pad.material} renderOrder={ORDER.pads} receiveShadow />;
}
