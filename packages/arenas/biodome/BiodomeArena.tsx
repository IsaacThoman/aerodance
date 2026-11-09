import { useLayoutEffect } from 'react';
import type { ReactNode } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useArenaFrame } from '../shared/frame.ts';
import { StageEnvironment } from '../../stages/shared/Environment.tsx';
import type { EnvironmentLight } from '../../stages/shared/Environment.tsx';
import type { PostOverrides } from '../../stages/shared/post.tsx';
import { useDisposable } from '../../stages/shared/hooks.ts';
import { Table } from '../shared/Table.tsx';
import { Dome } from './Dome.tsx';
import { Platform } from './Platform.tsx';
import { ForestFloor, Trees } from './Forest.tsx';
import { Mist, Pool, Rocks, Waterfalls } from './Falls.tsx';
import { Plants } from './Flora.tsx';
import { Birds, Butterflies, Hummingbirds, Motes, Shafts } from './Life.tsx';
import { Props } from './Props.tsx';
import { SUN_DIR } from './layout.ts';
import { HAZE_COLOR, HAZE_DENSITY, SUN_COLOR, SUN_INTENSITY, fx, makeNoiseTexture } from './shading.ts';

// Biodome: a table-tennis deck high in the canopy of a rainforest under a geodesic glass dome.
// The deck of pale timber and glossy white steel stands among the treetops beside a clear pool
// fed by a waterfall off a mossy cliff; light slants through the dome's cushions into the
// humid air, butterflies and hummingbirds work the flowers, and a walkway curves off into the
// jungle to a ring deck round a giant tree.

/** The Biodome's post-processing, for the host's RenderPipeline. */
export const BIODOME_POST: PostOverrides = {
  bloomStrength: 0.34,
  bloomRadius: 0.5,
  bloomThreshold: 1.45,
  exposure: 0.92,
  vignette: 0.22,
  saturation: 1.24,
  tint: [1.0, 0.99, 0.96],
};

/** How far the Biodome reaches from its table (m): its sky and clouds, 1.6-1.8 km out. */
export const BIODOME_FAR = 2500;

const SUN = SUN_DIR.clone().multiplyScalar(90).toArray();

// What glossy things reflect: the bright dome overhead, the low sun, forest all round.
const ENV_LIGHTS: readonly EnvironmentLight[] = [
  { position: [0, 30, 0], color: '#eaf8ff', intensity: 2.2, size: [30, 30] },
  { position: SUN_DIR.clone().multiplyScalar(40).toArray(), color: '#ffe9c4', intensity: 7, size: [5, 5] },
  { position: [-24, 4, 0], color: '#5fd07a', intensity: 1.2, size: [16, 10] },
  { position: [24, 4, 6], color: '#7ee08c', intensity: 1.1, size: [16, 10] },
  { position: [0, 3, -24], color: '#9ee8d8', intensity: 1.2, size: [20, 8] },
];

function Clock() {
  useArenaFrame((_state, _delta, time) => {
    fx.uTime.value = time;
  });
  return null;
}

function Fog() {
  const scene = useThree((s) => s.scene);
  useLayoutEffect(() => {
    scene.fog = new THREE.FogExp2(HAZE_COLOR.clone(), HAZE_DENSITY);
    return () => { scene.fog = null; };
  }, [scene]);
  return null;
}

/**
 * The Biodome round a table at the origin (its long axis along z, the deck at y = 0), with its
 * lights, fog and reflections. The host brings the camera and the post-processing (BIODOME_POST);
 * `children` go on the table (in its frame, as Table's do).
 */
export default function BiodomeArena({ children }: { children?: ReactNode }) {
  const noise = useDisposable(() => makeNoiseTexture());
  fx.uNoise.value = noise;
  return (
    <>
      <Clock />
      <Fog />
      <StageEnvironment top="#bfe6ff" horizon="#d9f4e6" bottom="#2c6a3c" lights={ENV_LIGHTS} intensity={1} />
      <hemisphereLight args={['#cbe9f2', '#4d7d46', 0.95]} />
      <directionalLight
        castShadow
        position={SUN}
        color={SUN_COLOR}
        intensity={SUN_INTENSITY}
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-11}
        shadow-camera-right={11}
        shadow-camera-top={11}
        shadow-camera-bottom={-11}
        shadow-camera-near={20}
        shadow-camera-far={160}
        shadow-bias={-0.0003}
        shadow-normalBias={0.03}
      />
      <Dome />
      <Platform />
      <Trees />
      <ForestFloor />
      <Rocks />
      <Pool />
      <Waterfalls />
      <Mist />
      <Plants />
      <Props />
      <Shafts />
      <Motes />
      <Butterflies />
      <Hummingbirds />
      <Birds />
      <Table top="#06704a" lines="#ffffff" edge="#f4fbf8" legs="arch" legColor="#ffffff" trim="#b8ff7a" trimIntensity={1.6} net="#0b3a28" netTape="#ffffff" gloss={0} roughness={0.8}>
        {children}
      </Table>
    </>
  );
}
