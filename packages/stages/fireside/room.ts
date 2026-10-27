// The cabin's shared clock, firelight and material patch. Everything inside is lit warm by the
// fire (a real point light, plus a soft fake glow in the shaders so the room never needs a
// second shadowed light) against the cool aurora outside.
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { WebGLProgramParametersWithUniforms } from 'three';
import { reducedMotion } from '../shared/hooks.ts';
import { hash } from '../shared/glsl.ts';
import { noiseTexture, polar } from '../polar/world.ts';
import { FIRE_LIGHT } from './layout.ts';

export const room = {
  /** The fire's brightness, about 1, flickering. */
  uFlicker: { value: 1 },
  uFire: { value: new THREE.Vector3(...FIRE_LIGHT) },
};

/** The fire's flicker at time t: a few incommensurate wobbles, never dropping far. */
export function flicker(t: number): number {
  return 0.86 + 0.07 * Math.sin(t * 7.3) + 0.045 * Math.sin(t * 13.1 + 1.7) + 0.03 * Math.sin(t * 23.7 + 0.4);
}

/** Runs the firelight; call once in the stage. */
export function useRoomClock(): void {
  useFrame((state) => {
    room.uFlicker.value = reducedMotion ? 0.9 : flicker(state.clock.elapsedTime);
  });
}

// Linear HDR colours for the room (the pipeline tone maps with ACES afterwards).
export const roomPalette = /* glsl */ `
const vec3 EMBER = vec3(1.0, 0.36, 0.08);
const vec3 FIRELIGHT = vec3(1.0, 0.5, 0.2);
const vec3 BULB = vec3(1.0, 0.66, 0.32);
`;

/**
 * Warm light from the fire on a surface at p facing n: a soft fake on top of the real point
 * light, that reaches round corners and across the ceiling. Needs `uFire` and `uFlicker`.
 */
const fireGlow = /* glsl */ `
vec3 fireGlow(vec3 p, vec3 n) {
  vec3 d = uFire - p;
  float l = length(d);
  float facing = 0.3 + 0.7 * max(dot(n, d / max(l, 1e-3)), 0.0);
  return FIRELIGHT * uFlicker * facing / (1.0 + l * l * 0.06);
}
`;

const roomDecl = /* glsl */ `
uniform float uTime, uFlicker;
uniform vec3 uFire;
varying vec3 vRoomWorld;
varying vec3 vRoomNormal;
${hash}
${noiseTexture}
${roomPalette}
${fireGlow}
`;

/** Extra GLSL spliced into a patched material (each has `vRoomWorld` and `vRoomNormal`, in world space). */
export interface RoomPatch {
  /** Distinguishes this patch's program in three's cache. */
  key: string;
  uniforms?: Record<string, THREE.IUniform>;
  /** Declarations after `#include <common>`. */
  head?: string;
  /** Runs after `#include <color_fragment>`: change `diffuseColor`. */
  color?: string;
  /** Runs after `#include <roughnessmap_fragment>`: change `roughnessFactor`. */
  roughness?: string;
  /** Runs after `#include <normal_fragment_maps>`: tilt `normal` (view space). */
  normal?: string;
  /** Runs after `#include <emissivemap_fragment>`: add to `totalEmissiveRadiance`. */
  emissive?: string;
  /**
   * How much of the environment's reflections it takes (the environment is tuned for the
   * dancers): a number, or a GLSL expression for one that varies over the surface.
   */
  ibl?: number | string;
}

/** Patch a lit three.js material with the room's clock, firelight and world-space varyings. */
export function patchRoom<M extends THREE.Material>(material: M, { key, uniforms = {}, head = '', color, roughness, normal, emissive, ibl = 1 }: RoomPatch): M {
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    Object.assign(shader.uniforms, room, { uTime: polar.uTime, uNoise: polar.uNoise }, uniforms);
    const share = typeof ibl === 'number' ? ibl.toFixed(3) : `(${ibl})`;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRoomWorld;\nvarying vec3 vRoomNormal;')
      .replace(
        '#include <project_vertex>',
        /* glsl */ `#include <project_vertex>
        {
          vec4 rw = vec4(transformed, 1.0);
          vec3 rn = objectNormal;
          #ifdef USE_INSTANCING
            rw = instanceMatrix * rw;
            rn = mat3(instanceMatrix) * rn;
          #endif
          vRoomWorld = (modelMatrix * rw).xyz;
          vRoomNormal = normalize(mat3(modelMatrix) * rn);
        }`,
      );
    let frag = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${roomDecl}\n${head}`)
      .replace(
        '#include <lights_fragment_maps>',
        /* glsl */ `#include <lights_fragment_maps>
        {
          float iblShare = ${share};
          radiance *= iblShare;
          clearcoatRadiance *= iblShare;
          iblIrradiance *= iblShare;
        }`,
      );
    if (color) frag = frag.replace('#include <color_fragment>', `#include <color_fragment>\n{\n${color}\n}`);
    if (roughness) frag = frag.replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n{\n${roughness}\n}`);
    if (normal) frag = frag.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n{\n${normal}\n}`);
    if (emissive) frag = frag.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n{\n${emissive}\n}`);
    shader.fragmentShader = frag;
  };
  // Same onBeforeCompile source for every patch, so tell three which program is which.
  material.customProgramCacheKey = () => `fireside-${key}`;
  return material;
}
