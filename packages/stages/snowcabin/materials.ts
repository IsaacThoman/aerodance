import * as THREE from 'three';
import { hash } from '../shared/glsl.ts';
import { noiseTexture, palette } from '../polar/world.ts';
import { haze, panes, snowcabin, sparkle, warmth } from './palette.ts';

/** Extra GLSL spliced into a patched material's fragment shader. */
export interface FragmentPatch {
  uniforms?: Record<string, THREE.IUniform>;
  /** Declarations after `#include <common>`. */
  head?: string;
  /** After `#include <color_fragment>`: change `diffuseColor`. */
  color?: string;
  /** After `#include <normal_fragment_maps>`: change the view-space `normal`. */
  normal?: string;
  /** After `#include <roughnessmap_fragment>`: change `roughnessFactor`. */
  roughness?: string;
  /** After `#include <lights_fragment_end>`: change `reflectedLight`. */
  light?: string;
}

export interface SceneryOptions {
  /** Program cache key, unique per distinct patch. */
  key: string;
  /** Share of the environment lighting it takes (the environment is tuned for the glass dancers). */
  ibl?: number;
  /** Sparkle on bright (snowy) parts: the share of grid cells that glint. */
  sparkle?: number;
  fragment?: FragmentPatch;
}

/**
 * Patches a lit material into the scene: the warm light from the cabin and lanterns, snow
 * sparkle on its white parts, a share of the environment and the distance haze. The moon and
 * sky light come from the stage's three.js lights as usual.
 */
export function patchScenery<M extends THREE.MeshStandardMaterial>(material: M, { key, ibl = 0.5, sparkle: density = 0, fragment }: SceneryOptions): M {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, snowcabin, { uIbl: { value: ibl }, uSparkle: { value: density } }, fragment?.uniforms ?? {});
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWorld;').replace(
      '#include <fog_vertex>',
      `#include <fog_vertex>
      {
        vec4 w = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          w = instanceMatrix * w;
        #endif
        vWorld = (modelMatrix * w).xyz;
      }`,
    );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vWorld;
        uniform float uTime, uBeat, uIbl, uSparkle;
        ${hash}
        ${noiseTexture}
        ${palette}
        ${panes}
        ${warmth}
        ${sparkle}
        ${haze}
        ${fragment?.head ?? ''}`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          vec3 nW = inverseTransformDirection(normal, viewMatrix);
          vec3 view = normalize(cameraPosition - vWorld);
          totalEmissiveRadiance += diffuseColor.rgb * warmth(vWorld, nW);
          if (uSparkle > 0.0) {
            float snowy = smoothstep(0.45, 0.75, dot(diffuseColor.rgb, vec3(0.3, 0.5, 0.2)));
            vec3 tint = vec3(0.75, 0.88, 1.0) + warmth(vWorld, nW) * 2.0;
            totalEmissiveRadiance += tint * glint(vWorld, nW, view, uSparkle) * snowy * 3.5;
          }
        }`,
      )
      .replace(
        '#include <lights_fragment_maps>',
        `#include <lights_fragment_maps>
        #if defined( RE_IndirectSpecular )
          radiance *= uIbl;
        #endif
        #if defined( RE_IndirectDiffuse )
          iblIrradiance *= uIbl;
        #endif`,
      )
      .replace('#include <fog_fragment>', '#include <fog_fragment>\ngl_FragColor.rgb = fieldHaze(gl_FragColor.rgb, vWorld);');
    if (fragment?.color) shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>\n${fragment.color}`);
    if (fragment?.normal) shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${fragment.normal}`);
    if (fragment?.roughness) shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${fragment.roughness}`);
    if (fragment?.light) shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${fragment.light}`);
  };
  material.customProgramCacheKey = () => `snowcabin-${key}`;
  return material;
}
