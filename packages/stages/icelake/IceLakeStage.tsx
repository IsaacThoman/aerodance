// icelake: the Aurora backdrop's mirror lake, frozen. The dancers stand on a cleared rink of
// black ice in the middle of the lake, which mirrors the folding curtains, the stars, the snowy
// peaks and the pines all round, with frozen bubbles stacked under the surface, wind-swept snow
// on top, lanterns round the rink, a red ice-fishing hut, and the glass cabin glowing warm up the
// far shore.
import { useRef } from 'react';
import type * as THREE from 'three';
import { StageCamera, reducedMotion } from '../shared/hooks.ts';
import { StageEnvironment } from '../shared/Environment.tsx';
import type { EnvironmentLight } from '../shared/Environment.tsx';
import { usePolarWorld } from '../polar/world.ts';
import { AuroraCurtains } from '../polar/Aurora.tsx';
import { Snowfall } from '../polar/Snowfall.tsx';
import { LakeSky } from './Sky.tsx';
import { Ice } from './Ice.tsx';
import { Cabin, Halos, Land, Mist, ShorePines } from './Shore.tsx';
import { Hut, Lanterns } from './Props.tsx';
import { CURTAINS } from './layout.ts';

// The aurora's green high behind the dancers, the cabin's warm windows far off between them,
// and a cool moonlit sky behind the camera for their fronts; the ice below mirrors the green.
const ENV_LIGHTS: EnvironmentLight[] = [
  { position: [0, 20, -40], color: '#2affb0', intensity: 2.4, size: [60, 14] },
  { position: [-30, 26, 10], color: '#8a6cff', intensity: 0.9, size: [30, 14] },
  { position: [2, 3, -40], color: '#ffa860', intensity: 3, size: [5, 5] },
  { position: [0, 8, 34], color: '#9cc8ff', intensity: 1.6, size: [50, 16] },
  { position: [0, -10, -20], color: '#1fd6a0', intensity: 0.8, size: [60, 10] },
];

export default function IceLakeStage() {
  usePolarWorld();
  // The scenery, hidden while the dancers' reflection in the ice is drawn (Ice.tsx): the lights,
  // lanterns and hut stay out of it, to be mirrored along with the dancers.
  const world = useRef<THREE.Group>(null);
  return (
    <>
      {/* Higher than most stages' cameras: the dancers' heads meet the far shore, and the ice and
          their reflections fill the lower half. */}
      <StageCamera
        position={[0, 3.1, 15.5]}
        target={[0, 1.5, 0]}
        fov={40}
        near={0.3}
        far={6000}
        orbit={reducedMotion ? [0, 0] : [0.05, 0.012]}
        sway={reducedMotion ? [0, 0, 0] : [0.1, 0.04, 0]}
      />
      <StageEnvironment top="#081a40" horizon="#1a6f78" bottom="#0f3440" lights={ENV_LIGHTS} intensity={1} />
      <hemisphereLight args={['#4a7ad0', '#123a48', 0.5]} />
      {/* The moon, from where the kit lights the land (landLight's KEY). */}
      <directionalLight
        castShadow
        position={[-8, 5, 2.5]}
        color="#b0ccff"
        intensity={1.6}
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-9}
        shadow-camera-right={9}
        shadow-camera-top={9}
        shadow-camera-bottom={-9}
        shadow-camera-near={1}
        shadow-camera-far={30}
        shadow-normalBias={0.03}
        shadow-bias={-0.0004}
        shadow-radius={3}
      />
      <group ref={world}>
        <LakeSky />
        <Ice world={world} />
        <Land />
        <Cabin />
        {/* Curtains and pines blend before the dancers, whose glass writes no depth to keep them off it. */}
        <AuroraCurtains curtains={CURTAINS} renderOrder={-50} />
        <ShorePines />
        <Mist />
        <Halos />
        <Snowfall count={1100} center={[0, 6, 0]} size={[48, 14, 48]} fade={40} />
      </group>
      <Lanterns />
      <Hut />
    </>
  );
}
