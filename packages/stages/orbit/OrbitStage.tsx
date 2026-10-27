import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { StageCamera, beat, reducedMotion } from '../shared/hooks.ts';
import { post } from '../shared/post.tsx';
import { StageEnvironment } from '../shared/Environment.tsx';
import type { EnvironmentLight } from '../shared/Environment.tsx';
import { CAMERA, DOME_CAMERA, MOON_DIR, NIGHT_SUN_DIR, SUN_DIR, world } from './layout.ts';
import type { OrbitVariant } from './layout.ts';
import { Planet } from './Planet.tsx';
import { Space } from './Space.tsx';
import { Deck } from './Deck.tsx';
import { Station } from './Station.tsx';
import { Dome } from './Dome.tsx';
import { Life } from './Life.tsx';
import meta from './meta.ts';

const BLOOM = meta.post.bloomStrength;

// The key lights: from the sun's side (or the Moon's), but raised so the dancers' shadows fall
// short and soft on the deck in front of them instead of streaking across it.
const SUN_KEY = new THREE.Vector3(SUN_DIR.x, 0, SUN_DIR.z).normalize().multiplyScalar(11).setY(17);
const MOON_KEY = new THREE.Vector3(MOON_DIR.x, 0, MOON_DIR.z).normalize().multiplyScalar(11).setY(17);

// The sun's panel in the reflections sits a little higher than the sun itself (just over the
// limb, below the deck's level), so the dancers catch it above the deck's edge.
const sunPanel = new THREE.Vector3(SUN_DIR.x, 0.14, SUN_DIR.z).normalize().multiplyScalar(40).toArray();
const moonPanel = MOON_DIR.clone().multiplyScalar(40).toArray();

// The glass dancers mostly reflect these: the bright planet below, the sun ahead, a soft panel
// overhead (the station's floodlights) so their heads don't mirror black space, aqua and lilac
// side lights, and a wide fill behind the camera so their fronts stay luminous.
const DAY_LIGHTS: EnvironmentLight[] = [
  { position: sunPanel, color: '#fff2dc', intensity: 8, size: [7, 5] },
  { position: [0, -18, -30], color: '#5fb4ff', intensity: 3, size: [90, 20] },
  { position: [0, 26, 4], color: '#e4f2ff', intensity: 2.4, size: [26, 22] },
  { position: [0, 8, 34], color: '#dff4ff', intensity: 3.2, size: [50, 16] },
  { position: [-30, 6, 8], color: '#7fe4ff', intensity: 1.6, size: [14, 10] },
  { position: [30, 8, 4], color: '#c8b8ff', intensity: 1.4, size: [14, 10] },
];
// At night the deck's lights take over: a cooler, dimmer world with the Moon as the key, aqua
// light up from the deck and the aurora's green below.
const NIGHT_LIGHTS: EnvironmentLight[] = [
  { position: moonPanel, color: '#dce8ff', intensity: 4.5, size: [6, 6] },
  { position: [0, -18, -30], color: '#3cffb0', intensity: 1.6, size: [90, 16] },
  { position: [0, 26, 4], color: '#b8ccff', intensity: 1.5, size: [26, 22] },
  { position: [0, 8, 34], color: '#b8d0ff', intensity: 2.6, size: [50, 16] },
  { position: [0, -4, 16], color: '#4ff0ff', intensity: 1.6, size: [30, 6] },
  { position: [-30, 6, 8], color: '#7f8cff', intensity: 1.2, size: [14, 10] },
  { position: [30, 8, 4], color: '#5fffd0', intensity: 1.2, size: [14, 10] },
];

function Clock({ night }: Pick<OrbitVariant, 'night'>) {
  useFrame((state) => {
    world.uTime.value = reducedMotion ? 0 : state.clock.elapsedTime;
    world.uBeat.value = beat.pulse;
    world.uNight.value = night ? 1 : 0;
    world.uSunDir.value.copy(night ? NIGHT_SUN_DIR : SUN_DIR);
    // Bloom breathes a little with the beat.
    post.bloomStrength = BLOOM * (1 + 0.15 * beat.pulse);
  });
  return null;
}

/**
 * orbit: a glossy white-and-glass deck on a space station high over a blue planet at sunrise.
 *   night (orbitnight): over the night side, city lights and the aurora below
 *   dome (orbitdome): the deck closed under a glass garden dome
 */
export default function OrbitStage({ night = false, dome = false }: Partial<OrbitVariant>) {
  const variant: OrbitVariant = { night, dome };
  return (
    <>
      <Clock night={night} />
      <StageCamera {...(dome ? DOME_CAMERA : CAMERA)} near={0.3} far={9000} orbit={[0.05, 0.015]} sway={[0.14, 0.06, 0]} />
      <color attach="background" args={['#01030c']} />
      <StageEnvironment
        top={night ? '#04081c' : '#060c26'}
        horizon={night ? '#123a6a' : '#3f8ee8'}
        bottom={night ? '#0b1838' : '#1f5fb8'}
        lights={night ? NIGHT_LIGHTS : DAY_LIGHTS}
        intensity={1}
      />
      <hemisphereLight args={[night ? '#6a78c8' : '#a8c8ff', night ? '#1a4a6a' : '#3a7fd8', night ? 0.35 : 0.45]} />
      <directionalLight
        castShadow
        position={(night ? MOON_KEY : SUN_KEY).toArray()}
        color={night ? '#c8d8ff' : '#fff0d8'}
        intensity={night ? 1.6 : 2.6}
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-9}
        shadow-camera-right={9}
        shadow-camera-top={9}
        shadow-camera-bottom={-9}
        shadow-camera-near={1}
        shadow-camera-far={45}
        shadow-normalBias={0.03}
        shadow-bias={-0.0004}
      />
      {/* Front fill from behind the camera, the light of the planet below. */}
      <directionalLight position={[-3, 4, 14]} color={night ? '#8fa8ff' : '#cfe6ff'} intensity={night ? 0.7 : 0.6} />
      {/* At night the deck's LED rings light the dancers from below and in front. */}
      {night && <pointLight position={[0, 0.5, 3.6]} color="#5ff0ff" intensity={9} distance={11} decay={2} />}
      <Space {...variant} />
      <Planet {...variant} />
      <Station {...variant} />
      <Deck {...variant} />
      {dome && <Dome {...variant} />}
      <Life {...variant} />
    </>
  );
}
