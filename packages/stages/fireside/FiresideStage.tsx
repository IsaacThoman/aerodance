// fireside: inside the glass A-frame cabin from the menus' Aurora backdrop. A warm, glossy room
// of pine and firelight (a round hanging fireplace, a deep sofa heaped with knit blankets,
// shelves, plants, cocoa and candles, fairy lights along the beams) looks out through its
// all-glass gable over a frozen lake, snowy peaks and the northern lights, with snow falling
// outside. Warm in here, cool out there.
import { useMemo } from 'react';
import * as THREE from 'three';
import { StageCamera, reducedMotion } from '../shared/hooks.ts';
import { StageEnvironment } from '../shared/Environment.tsx';
import type { EnvironmentLight } from '../shared/Environment.tsx';
import { usePolarWorld } from '../polar/world.ts';
import { FIRE, FLOOR } from './layout.ts';
import { useRoomClock } from './room.ts';
import { Outside } from './Outside.tsx';
import { Cabin } from './Cabin.tsx';
import { Hearth } from './Hearth.tsx';
import { Lounge } from './Lounge.tsx';
import { Library } from './Library.tsx';
import { Glows } from './Glows.tsx';

// What the glass dancers reflect: the fire off to their left, the aurora-lit window behind
// them (their cool rims), the warm lamplit room behind the camera (their fronts), and the
// fairy lights overhead.
const ENV_LIGHTS: EnvironmentLight[] = [
  { position: [-24, 3, -8], color: '#ff9a4c', intensity: 6, size: [9, 7] },
  { position: [0, 9, -34], color: '#3ad8c0', intensity: 2.2, size: [40, 22] },
  { position: [0, 4, 34], color: '#ffe6cc', intensity: 5, size: [80, 16] },
  { position: [0, 26, 4], color: '#ffe2b8', intensity: 1.8, size: [34, 14] },
  { position: [28, 4, 2], color: '#ffc080', intensity: 2.4, size: [12, 10] },
  { position: [-14, 14, 22], color: '#fff0dc', intensity: 2.2, size: [8, 5] },
];

// The key: firelight from up and left, the one light that casts the dancers' shadows, its
// shadow camera drawn tight round them.
const KEY_FROM = new THREE.Vector3(FIRE.x - 1.5, FLOOR + 9, FIRE.z - 1).sub(new THREE.Vector3(0, FLOOR, 0)).normalize().multiplyScalar(14);

function Lights() {
  const target = useMemo(() => new THREE.Object3D(), []);
  return (
    <>
      <primitive object={target} position={[0, FLOOR + 1, 0]} />
      <hemisphereLight args={['#ffd8b0', '#5a3420', 0.35]} />
      <directionalLight
        castShadow
        target={target}
        position={[KEY_FROM.x, FLOOR + 1 + KEY_FROM.y, KEY_FROM.z]}
        color="#ffae6a"
        intensity={1.6}
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-6}
        shadow-camera-right={6}
        shadow-camera-top={6}
        shadow-camera-bottom={-6}
        shadow-camera-near={2}
        shadow-camera-far={30}
        shadow-normalBias={0.03}
        shadow-bias={-0.0004}
        shadow-radius={3}
      />
      {/* Lamplight from the room behind the camera, on the dancers' fronts. */}
      <directionalLight position={[3, FLOOR + 6, 12]} color="#ffd2a0" intensity={0.55} />
    </>
  );
}

export default function FiresideStage() {
  usePolarWorld();
  useRoomClock();
  return (
    <>
      <StageCamera
        position={[0, FLOOR + 2.2, 12.5]}
        target={[0, FLOOR + 2.4, 0]}
        fov={46}
        near={0.3}
        far={6000}
        orbit={reducedMotion ? [0, 0] : [0.04, 0.012]}
        sway={reducedMotion ? [0, 0, 0] : [0.1, 0.05, 0]}
        parallax={[0.3, 0.15]}
      />
      <StageEnvironment top="#6a4630" horizon="#b07850" bottom="#6a3c22" lights={ENV_LIGHTS} intensity={1} />
      <Lights />
      <Outside />
      <Cabin />
      <Hearth />
      <Lounge />
      <Library />
      <Glows />
    </>
  );
}
