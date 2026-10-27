import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { world } from './layout.ts';
import { life } from './glints.ts';

// The shuttle and the camera drones: glossy white shells with dark glass and glowing aqua trim,
// each a single merged mesh painted per vertex. `color` is the paint; `aGlow` is light the part
// gives off ([r, g, b] and how it blinks: 0 steady, 1 with the beat, 2 a strobe).

/** How a part's glow blinks. */
export const Blink = { steady: 0, beat: 1, strobe: 2 } as const;
type Blink = (typeof Blink)[keyof typeof Blink];

type RGB = readonly [number, number, number];

const WHITE: RGB = [0.95, 0.97, 1];
const PEARL: RGB = [0.8, 0.86, 0.94];
const GLASS: RGB = [0.02, 0.07, 0.16];
const AQUA: RGB = [0.1, 0.78, 1];
const NONE: RGB = [0, 0, 0];

interface Paint {
  color: RGB;
  glow?: RGB;
  blink?: Blink;
}

/** Paints a part (all one paint, or per vertex from its position) and drops its index so parts merge. */
function part(geometry: THREE.BufferGeometry, paint: Paint | ((p: THREE.Vector3) => Paint)): THREE.BufferGeometry {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  if (g !== geometry) geometry.dispose();
  const position = g.attributes.position;
  const color = new Float32Array(position.count * 3);
  const glow = new Float32Array(position.count * 4);
  const p = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    const { color: c, glow: e = NONE, blink = Blink.steady } = typeof paint === 'function' ? paint(p.fromBufferAttribute(position, i)) : paint;
    color.set(c, i * 3);
    glow.set([...e, blink], i * 4);
  }
  g.setAttribute('color', new THREE.BufferAttribute(color, 3));
  g.setAttribute('aGlow', new THREE.BufferAttribute(glow, 4));
  g.deleteAttribute('uv');
  return g;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts);
  parts.forEach((p) => p.dispose());
  if (!g) throw new Error('craft: parts did not merge');
  return g;
}

/** A thin extruded outline, `depth` thick, laid in the xy plane and centred on z = 0. */
function plate(outline: readonly (readonly [number, number])[], depth: number): THREE.BufferGeometry {
  const shape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: depth * 0.4, bevelSize: depth * 0.4, bevelSegments: 2 });
  g.translate(0, 0, -depth / 2);
  return g;
}

/**
 * A small glossy shuttle about 4.6 long, nose to +z: a rounded white fuselage with an aqua
 * belly stripe, a dark glass canopy, swept wings with aqua tips, a tail fin and a glowing engine.
 */
export function shuttleGeometry(): THREE.BufferGeometry {
  // The fuselage turned round its long axis: [radius, along], tail to nose.
  const profile: [number, number][] = [
    [0, -2.05], [0.4, -2.02], [0.56, -1.7], [0.64, -1], [0.64, 0.3], [0.58, 1.1], [0.44, 1.75], [0.24, 2.18], [0, 2.32],
  ];
  const body = new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), 28);
  body.rotateX(Math.PI / 2);
  body.scale(1, 0.82, 1);
  const fuselage = part(body, (p) => {
    const belly = p.y < -0.18 && p.y > -0.36;
    return { color: belly ? AQUA : p.y < -0.36 ? PEARL : WHITE, glow: belly ? [0.02, 0.12, 0.18] : NONE };
  });

  const canopy = new THREE.SphereGeometry(0.42, 20, 12);
  canopy.scale(0.78, 0.55, 1.5);
  canopy.translate(0, 0.24, 1.05);

  const wing = (side: 1 | -1) => {
    const g = plate([[0.4, -1.5], [2.1, -1.85], [2.2, -1.45], [0.4, 0.4]], 0.08);
    g.rotateX(Math.PI / 2);
    if (side < 0) g.scale(-1, 1, 1);
    g.translate(0, -0.22, 0);
    return part(g, (p) => (Math.abs(p.x) > 1.85 ? { color: AQUA, glow: [0.05, 0.4, 0.6] } : { color: WHITE }));
  };

  const fin = plate([[-1.35, 0.3], [-1.95, 0.3], [-2.25, 1.25], [-1.95, 1.25]], 0.07);
  fin.rotateY(-Math.PI / 2);

  const nozzle = new THREE.CylinderGeometry(0.34, 0.44, 0.34, 20, 1, true);
  nozzle.rotateX(Math.PI / 2);
  nozzle.translate(0, -0.05, -2.14);
  const flame = new THREE.CircleGeometry(0.34, 20);
  flame.rotateY(Math.PI);
  flame.translate(0, -0.05, -2.2);

  return merge([
    fuselage,
    part(canopy, { color: GLASS }),
    wing(1),
    wing(-1),
    part(fin, (p) => (p.y > 1.05 ? { color: AQUA } : { color: WHITE })),
    part(nozzle, { color: PEARL }),
    part(flame, { color: AQUA, glow: [0.6, 2.2, 3.2], blink: Blink.beat }),
  ]);
}

/**
 * A cute camera drone about 0.95 across, lens to +z: a glossy white ball with a big dark glass
 * lens ringed in light, two little rotor rings on arms, and an antenna whose tip blinks.
 */
export function droneGeometry(): THREE.BufferGeometry {
  const shell = new THREE.SphereGeometry(0.3, 28, 18);
  shell.scale(1, 0.9, 0.95);
  const lens = new THREE.SphereGeometry(0.17, 20, 12);
  lens.scale(1, 1, 0.5);
  lens.translate(0, 0.01, 0.255);
  const ring = new THREE.TorusGeometry(0.175, 0.026, 8, 28);
  ring.translate(0, 0.01, 0.262);
  const pupil = new THREE.SphereGeometry(0.05, 12, 8);
  pupil.translate(0, 0.01, 0.335);

  const rotor = (side: 1 | -1) => {
    const arm = new THREE.CylinderGeometry(0.028, 0.028, 0.2, 8);
    arm.rotateZ(Math.PI / 2);
    arm.translate(side * 0.3, 0.06, -0.02);
    const guard = new THREE.TorusGeometry(0.15, 0.028, 8, 24);
    guard.rotateX(Math.PI / 2);
    guard.translate(side * 0.47, 0.08, -0.02);
    const hub = new THREE.CylinderGeometry(0.04, 0.05, 0.05, 10);
    hub.translate(side * 0.47, 0.08, -0.02);
    return [part(arm, { color: PEARL }), part(guard, { color: WHITE, glow: [0.02, 0.1, 0.14] }), part(hub, { color: GLASS })];
  };

  const antenna = new THREE.CylinderGeometry(0.012, 0.012, 0.18, 6);
  antenna.rotateZ(0.25);
  antenna.translate(-0.06, 0.34, -0.06);
  const tip = new THREE.SphereGeometry(0.038, 10, 8);
  tip.translate(-0.083, 0.43, -0.06);

  return merge([
    part(shell, (p) => ({ color: p.y < -0.13 ? PEARL : WHITE })),
    part(lens, { color: GLASS }),
    part(ring, { color: AQUA, glow: [0.2, 1.1, 1.6], blink: Blink.beat }),
    part(pupil, { color: GLASS, glow: [0.25, 0.5, 0.9], blink: Blink.beat }),
    ...rotor(1),
    ...rotor(-1),
    part(antenna, { color: PEARL }),
    part(tip, { color: WHITE, glow: [1.6, 0.5, 0.7], blink: Blink.strobe }),
  ]);
}

/**
 * Glossy clear-coated white for the craft, lit by the stage, with each part's glow added on top:
 * steady, swelling with the beat, or a short strobe. `accent` tints the glow per instance
 * (an `aAccent` instanced attribute).
 */
export function craftMaterial(accent = false): THREE.MeshPhysicalMaterial {
  const material = new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    roughness: 0.22,
    metalness: 0.05,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
  });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, { uTime: world.uTime, uBeat: world.uBeat, uCalm: life.uCalm });
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec4 aGlow;
        ${accent ? 'attribute vec3 aAccent;' : ''}
        varying vec4 vGlow;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vGlow = aGlow;
        ${accent ? 'vGlow.rgb *= aAccent;' : ''}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uTime, uBeat, uCalm;
        varying vec4 vGlow;`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        // Steady, swelling with the beat (a little less while the dancers dance), or a strobe
        // (each accent tint at its own moment).
        float blink = vGlow.w < 0.5 ? 1.0
          : vGlow.w < 1.5 ? 0.55 + (0.9 - 0.4 * uCalm) * uBeat
          : 0.15 + 2.0 * step(0.86, fract(uTime * 0.7 + vGlow.g * 3.0));
        totalEmissiveRadiance += vGlow.rgb * blink;`,
      );
  };
  material.customProgramCacheKey = () => `orbit-craft-${accent}`;
  return material;
}
