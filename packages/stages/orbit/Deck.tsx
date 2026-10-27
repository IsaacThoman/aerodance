import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { beat, reducedMotion, stagePlay, useDisposable } from '../shared/hooks.ts';
import { damp } from '../shared/random.ts';
import { DECK_RADIUS, DECK_WINDOWS, world } from './layout.ts';
import type { OrbitVariant } from './layout.ts';
import { makeChromeGeometry, makeHullGeometry, makeLedGeometry, makePaneGeometry, makeRailGlassGeometry, makeSlabGeometry } from './deckGeometry.ts';

/** The deck lights, moved on each frame: how bright, the beat's pulse, and where the ripple is. */
export const deckLights = {
  uLevel: { value: 1 },
  uPulse: { value: 0 },
  /** 0..1 through the beat, for the ripple rolling outwards. */
  uPhase: { value: 0 },
  /** How strong the ripple and pulse are: calmer while the dancers dance. */
  uLively: { value: 1 },
};

// The dance floor: glossy pearl-white ceramic with soft aqua LED rings set into it, a glass
// medallion in the middle, faint panel seams, and glowing wells round the glass windows.
function makeFloorMaterial() {
  // The env map is mostly for the dancers' bright panels; the floor takes a little of it, or it
  // would mirror the sun and the front fill as wide white glare.
  const mat = new THREE.MeshPhysicalMaterial({ color: '#f6f9fc', roughness: 0.3, metalness: 0, clearcoat: 0.8, clearcoatRoughness: 0.08, envMapIntensity: 0.6 });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, deckLights, { uNight: world.uNight });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vDeck;\nvarying vec3 vDeckN;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvDeck = (modelMatrix * vec4(position, 1.0)).xyz;\nvDeckN = normalize(mat3(modelMatrix) * normal);',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        uniform float uLevel, uPulse, uPhase, uLively, uNight;
        varying vec3 vDeck;
        varying vec3 vDeckN;
        // An antialiased line w wide at r = at.
        float line(float r, float at, float w) {
          float aa = fwidth(r) * 1.2;
          return 1.0 - smoothstep(w * 0.5 - aa, w * 0.5 + aa, abs(r - at));
        }
        float halo(float r, float at, float w) { float d = (r - at) / w; return exp(-d * d); }`,
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
        float r = length(vDeck.xz);
        float ang = atan(vDeck.z, vDeck.x);
        float top = smoothstep(0.6, 0.9, vDeckN.y);
        // Pearl white, cooling to pale aqua towards the rim.
        diffuseColor.rgb *= mix(vec3(1.0), vec3(0.86, 0.95, 1.0), smoothstep(2.5, ${DECK_RADIUS.toFixed(2)}, r));
        // Glass medallion in the middle.
        float medal = 1.0 - smoothstep(0.82, 0.82 + fwidth(r) * 1.5, r);
        diffuseColor.rgb = mix(diffuseColor.rgb, mix(vec3(0.3, 0.78, 0.98), vec3(0.75, 0.95, 1.0), r / 0.82), medal * top);
        // Faint panel seams between the rings; fade them out where they'd shimmer.
        float seg = 6.2831853 / 16.0;
        float sd = abs(mod(ang + seg * 0.5, seg) - seg * 0.5) * r;
        float seamFade = 1.0 - smoothstep(0.02, 0.05, fwidth(sd));
        float seam = (1.0 - smoothstep(0.02, 0.02 + fwidth(sd) * 1.5, sd)) * step(1.0, r) * step(r, 5.1) * seamFade;
        seam = max(seam, line(r, 2.35, 0.03) * (1.0 - smoothstep(0.02, 0.05, fwidth(r))));
        diffuseColor.rgb *= 1.0 - seam * 0.12 * top;
        // LED rings, set in flush: the inlays cover the white so they stay saturated.
        float rings = line(r, 0.9, 0.07) + line(r, 3.55, 0.09) + line(r, ${(DECK_WINDOWS.inner - 0.32).toFixed(2)}, 0.06)
          + line(r, ${(DECK_WINDOWS.outer + 0.3).toFixed(2)}, 0.08);
        rings = min(rings, 1.0) * top;
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.3, 0.9, 1.0), rings);
        // The window wells: their walls glow from within.
        float well = (1.0 - abs(vDeckN.y)) * step(${(DECK_WINDOWS.inner - 0.2).toFixed(2)}, r) * step(r, ${(DECK_WINDOWS.outer + 0.2).toFixed(2)});
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.6, 0.95, 1.0), well);`,
      )
      // Cap what the floor mirrors (and the key's highlight) so they glint without blooming.
      .replace(
        '#include <lights_fragment_maps>',
        `#include <lights_fragment_maps>
        radiance = min(radiance, vec3(0.6));
        #ifdef USE_CLEARCOAT
          clearcoatRadiance = min(clearcoatRadiance, vec3(0.6));
        #endif`,
      )
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
        reflectedLight.directSpecular = min(reflectedLight.directSpecular, vec3(0.35));
        #ifdef USE_CLEARCOAT
          clearcoatSpecularDirect = min(clearcoatSpecularDirect, vec3(0.35));
        #endif`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `#include <emissivemap_fragment>
        vec3 led = vec3(0.3, 1.0, 1.15);
        float lit = uLevel * (1.0 + 0.7 * uPulse * uLively);
        // A soft wave rolls out over the floor on each beat.
        float wave = halo(r, uPhase * 7.5, 0.55) * (1.0 - uPhase) * uLively * step(r, ${(DECK_RADIUS - 0.4).toFixed(2)}) * top;
        totalEmissiveRadiance += led * (rings * 1.9 * lit + well * 0.9 * lit + medal * top * (0.22 + 0.2 * uPulse * uLively) + wave * 0.16);
        // The rings' glow spilling onto the floor, stronger at night.
        float spill = halo(r, 3.55, 0.35) + halo(r, 0.9, 0.3) + halo(r, ${(DECK_WINDOWS.outer + 0.3).toFixed(2)}, 0.3);
        totalEmissiveRadiance += led * spill * top * (0.05 + 0.1 * uNight) * lit;`,
      );
  };
  mat.customProgramCacheKey = () => 'orbit-deck-floor';
  return mat;
}

/**
 * The deck the dancers stand on: a glossy white saucer with LED rings that pulse on the beat, a
 * ring of glass windows down to the planet, a low glass rail with a chrome top, and a lit skirt.
 * Under the dome (dome) the floor is solid, for the planters, and the rail gives way to the dome.
 */
export function Deck({ night, dome }: OrbitVariant) {
  const geo = useDisposable(
    () => ({
      slab: makeSlabGeometry(!dome),
      panes: dome ? null : makePaneGeometry(),
      hull: makeHullGeometry(),
      chrome: dome ? null : makeChromeGeometry(),
      railGlass: dome ? null : makeRailGlassGeometry(),
      led: makeLedGeometry(!dome),
    }),
    [dome],
  );
  const mats = useDisposable(() => ({
    floor: makeFloorMaterial(),
    hull: new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.3, clearcoat: 0.8, clearcoatRoughness: 0.1, envMapIntensity: 0.45, side: THREE.DoubleSide }),
    chrome: new THREE.MeshStandardMaterial({ color: '#f2fbff', metalness: 1, roughness: 0.12 }),
    pane: new THREE.MeshPhysicalMaterial({
      color: '#9fe6ff',
      roughness: 0.04,
      metalness: 0,
      transparent: true,
      opacity: 0.22,
      envMapIntensity: 1.6,
      depthWrite: false,
    }),
    railGlass: new THREE.MeshPhysicalMaterial({
      color: '#c8f4ff',
      roughness: 0.05,
      transparent: true,
      opacity: 0.16,
      envMapIntensity: 1.5,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
    led: new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: true }),
  }));

  useFrame((_, delta) => {
    deckLights.uLevel.value = night ? 1.5 : 1;
    // Gentle while the dancers dance, livelier in the menus and on the results.
    deckLights.uLively.value = damp(deckLights.uLively.value, reducedMotion ? 0 : stagePlay.dancing ? 0.35 : 1, 2, delta);
    deckLights.uPulse.value = beat.pulse;
    deckLights.uPhase.value = beat.phase;
    const k = deckLights.uLevel.value * (1.6 + 0.9 * beat.pulse * deckLights.uLively.value);
    mats.led.color.setScalar(k);
  });

  return (
    <group>
      <mesh geometry={geo.slab} material={mats.floor} receiveShadow />
      <mesh geometry={geo.hull} material={mats.hull} receiveShadow />
      <mesh geometry={geo.led} material={mats.led} />
      {geo.panes && <mesh geometry={geo.panes} material={mats.pane} receiveShadow renderOrder={1} />}
      {geo.chrome && <mesh geometry={geo.chrome} material={mats.chrome} />}
      {geo.railGlass && <mesh geometry={geo.railGlass} material={mats.railGlass} renderOrder={2} />}
    </group>
  );
}
