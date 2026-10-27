import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type * as THREE from 'three';
import type { Vec3 } from '../catalog.ts';
import { StageEnvironment } from '../shared/Environment.tsx';
import type { EnvironmentLight } from '../shared/Environment.tsx';
import { StageCamera, beat, reducedMotion } from '../shared/hooks.ts';
import { post } from '../shared/post.tsx';
import { CloudField, SkyDome } from '../shared/Sky.tsx';
import { usePondMaps } from './bake.ts';
import { pondTime } from './clock.ts';
import { Far } from './Far.tsx';
import { Garden } from './Garden.tsx';
import { Koi } from './Koi.tsx';
import { CAMERA, SUN_DIRECTION } from './layout.ts';
import { Lilies } from './Lilies.tsx';
import { Petals } from './Petals.tsx';
import { Ground } from './Pond.tsx';
import { useReflection } from './Reflection.tsx';
import { makePondUniforms } from './shaders.ts';
import type { PondUniforms } from './shaders.ts';
import { StagePad } from './StagePad.tsx';
import meta from './meta.ts';

const scale = (v: Vec3, k: number): Vec3 => [v[0] * k, v[1] * k, v[2] * k];

// Bright sky and white clouds for the glass dancers to mirror, the sun high behind them, the
// garden's green and the pond's jade below.
const ENV_LIGHTS: EnvironmentLight[] = [
  { position: scale(SUN_DIRECTION, 40), color: '#fff2d8', intensity: 7, size: [10, 10] },
  { position: [0, 16, 30], color: '#ffffff', intensity: 2.4, size: [44, 16] },
  { position: [-30, 8, 4], color: '#ffd0e4', intensity: 1.4, size: [16, 10] },
  { position: [30, 8, 0], color: '#d6f4ff', intensity: 1.2, size: [16, 10] },
];

/** A ring goes out across the water from the dancers' pad on every bar. */
const RING_BEATS = 4;

function Clock({ shared }: { shared: PondUniforms }) {
  useFrame((state) => {
    shared.uTime.value = pondTime(state);
    const rings = shared.uRings.value;
    if (reducedMotion) {
      rings.set(-1, -1, -1, -1);
    } else {
      const period = (RING_BEATS * 60) / beat.bpm;
      const last = Math.floor(beat.time / period);
      const age = (k: number) => (last - k >= 0 ? beat.time - (last - k) * period : -1);
      rings.set(age(0), age(1), age(2), age(3));
    }
    // Bloom breathes a little with the beat.
    post.bloomStrength = meta.post.bloomStrength * (1 + 0.15 * beat.pulse);
  });
  return null;
}

/**
 * pond: a garden koi pond in spring. The dancers stand on a giant lily pad in its middle; koi
 * circle it under the jade water, over a pebble bed rippling with caustics, among smaller pads
 * and lotus flowers. Cherry trees in bloom lean in from the banks and drop their petals on the
 * water, and a vermilion bridge crosses the stream that feeds it. Every bar sends a ring across
 * the water from the dancers' pad.
 */
export default function PondStage() {
  const shared = useMemo(() => makePondUniforms(), []);
  usePondMaps(shared);
  const scenery = useRef<THREE.Group>(null);
  useReflection(shared, scenery);
  const sun = useMemo(() => scale(SUN_DIRECTION, 30), []);

  return (
    <>
      <Clock shared={shared} />
      <StageCamera {...CAMERA} near={0.3} far={4000} orbit={reducedMotion ? [0, 0] : [0.1, 0.025]} sway={reducedMotion ? [0, 0, 0] : [0.12, 0.05, 0]} />
      <StageEnvironment top="#4c9be8" horizon="#e8f8ff" bottom="#2c6a52" lights={ENV_LIGHTS} intensity={1} />
      <hemisphereLight args={['#d2e9ff', '#5c8a3c', 0.75]} />
      <directionalLight
        castShadow
        position={sun}
        color="#fff1d8"
        intensity={2.5}
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-6}
        shadow-camera-right={6}
        shadow-camera-top={6}
        shadow-camera-bottom={-6}
        shadow-camera-near={10}
        shadow-camera-far={50}
        shadow-normalBias={0.03}
        shadow-bias={-0.0004}
      />
      <group ref={scenery}>
        <SkyDome top="#2f7fe0" horizon="#bfe6ff" bottom="#dff3ff" exponent={0.5} sunDirection={SUN_DIRECTION} sunColor="#fff3d6" sunDisc={4} sunGlow={0.7} radius={3500} />
        <CloudField count={22} center={[0, 230, -700]} area={[2600, 900]} heightJitter={60} size={[180, 360]} speed={3} seed={6} shade="#a9c9ee" fogColor="#cfeaff" fogNear={800} fogFar={2600} />
        <CloudField count={14} center={[0, 160, 420]} area={[2000, 500]} heightJitter={40} size={[150, 300]} speed={3.5} seed={12} shade="#a9c9ee" fogColor="#cfeaff" fogNear={500} fogFar={2000} renderOrder={-499} />
        <Far shared={shared} />
        <Ground shared={shared} />
        <Garden shared={shared} />
      </group>
      <StagePad />
      <Koi shared={shared} />
      <Lilies shared={shared} />
      <Petals shared={shared} />
    </>
  );
}
