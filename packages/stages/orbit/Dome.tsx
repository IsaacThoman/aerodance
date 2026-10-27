import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useDisposable } from '../shared/hooks.ts';
import { shaderMaterial } from '../shared/glsl.ts';
import type { OrbitVariant } from './layout.ts';
import { deckLights } from './Deck.tsx';
import { VERTEX, spaceGLSL, spaceUniforms } from './spaceShading.ts';
import { flowerSpots, makeDomeGlassGeometry, makeDomeGlowGeometry, makeDomeWhiteGeometry, makeGardenGeometry } from './domeGeometry.ts';

const FLOWER_COLORS = ['#ff6fb5', '#ffe14a', '#ffffff', '#c98cff', '#ff8a5c'];

// Clear glass with a thin-film sheen: nearly invisible face-on, so the sky and the planet read
// through it, brightening to iridescent edges, with space, the planet and the sun mirrored in it
// and a soft studio streak on the shoulders.
function makeGlassMaterial() {
  return shaderMaterial({
    transparent: true,
    premultipliedAlpha: true,
    depthWrite: false,
    uniforms: spaceUniforms(),
    vertexShader: VERTEX,
    fragmentShader: /* glsl */ `
      varying vec3 vNormal, vWorld;
      varying vec2 vUv;
      ${spaceGLSL}
      void main() {
        vec3 n = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0);
        vec3 v = normalize(cameraPosition - vWorld);
        float ndv = clamp(dot(n, v), 0.0, 1.0);
        float fresnel = 0.03 + 0.97 * pow(1.0 - ndv, 5.0);
        float rim = pow(1.0 - ndv, 2.4);
        vec3 r = reflect(-v, n);
        // Thin film: the hue drifts with the angle and the height up the dome.
        float film = ndv * 3.2 + vWorld.y * 0.18;
        vec3 irid = 0.5 + 0.5 * cos(6.2831853 * (film + vec3(0.0, 0.33, 0.67)));
        irid = mix(vec3(0.7, 0.95, 1.0), irid, 0.55);
        // A soft streak of reflected light down each side of the dome.
        float streak = smoothstep(0.75, 0.95, abs(n.x)) * smoothstep(0.1, 0.5, n.y) * (1.0 - smoothstep(0.75, 0.95, n.y));
        vec3 col = environment(r, vWorld) * fresnel * 0.9 + irid * pow(rim, 1.6) * (0.22 - 0.06 * uNight) + vec3(1.6, 1.8, 2.0) * streak * 0.14 + sunRim(n, v) * 0.3;
        float a = clamp(0.01 + fresnel * 0.45 + rim * 0.05 + streak * 0.08, 0.0, 1.0);
        gl_FragColor = vec4(col, a);
      }
    `,
  });
}

/**
 * orbitdome's glass garden dome over the deck: white ribs (none across the front), a crown cap,
 * thin-film glass, and inside a ring of planters with round trees at the sides, ferns, bushes and
 * flowers, lower at the back so the planet still shows; grow lights on the planter's lip and a
 * soft pink ring round the dome's shoulder.
 */
export function Dome(_props: OrbitVariant) {
  const geo = useDisposable(() => ({
    glass: makeDomeGlassGeometry(),
    white: makeDomeWhiteGeometry(),
    garden: makeGardenGeometry(),
    glow: makeDomeGlowGeometry(),
    flower: new THREE.IcosahedronGeometry(0.075, 1),
  }));
  const mats = useDisposable(() => ({
    glass: makeGlassMaterial(),
    white: new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.08, side: THREE.DoubleSide }),
    leaf: new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.5, clearcoat: 0.5, clearcoatRoughness: 0.25, side: THREE.DoubleSide }),
    flower: new THREE.MeshStandardMaterial({ roughness: 0.4, emissive: '#ffffff', emissiveIntensity: 0.12 }),
    glow: new THREE.MeshBasicMaterial({ vertexColors: true }),
  }));
  const flowers = useDisposable(() => {
    const spots = flowerSpots();
    const m = new THREE.InstancedMesh(geo.flower, mats.flower, spots.length);
    const mat = new THREE.Matrix4();
    const c = new THREE.Color();
    spots.forEach(({ at, color }, i) => {
      m.setMatrixAt(i, mat.makeTranslation(at.x, at.y, at.z));
      m.setColorAt(i, c.set(FLOWER_COLORS[color]));
    });
    return m;
  }, [geo, mats]);

  useFrame(() => {
    // The strips breathe with the deck's lights.
    mats.glow.color.setScalar(deckLights.uLevel.value * (1.5 + 0.5 * deckLights.uPulse.value * deckLights.uLively.value));
  });

  return (
    <group>
      <mesh geometry={geo.white} material={mats.white} receiveShadow />
      <mesh geometry={geo.garden} material={mats.leaf} receiveShadow />
      <primitive object={flowers} />
      <mesh geometry={geo.glow} material={mats.glow} />
      {/* Only the near side of the shell: from inside, the far side would veil the planet. */}
      <mesh geometry={geo.glass} material={mats.glass} renderOrder={6} />
    </group>
  );
}
