import { useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { StageCamera, beat, reducedMotion } from '../shared/hooks.ts';
import { StageEnvironment } from '../shared/Environment.tsx';
import type { EnvironmentLight } from '../shared/Environment.tsx';
import { post } from '../shared/post.tsx';
import { Atrium } from './Atrium.tsx';
import { DanceFloor } from './DanceFloor.tsx';
import { STAGE_CAMERA, SUN_DIR } from './layout.ts';
import { makeAtriumUniforms } from './shading.ts';
import meta from './meta.ts';

// atrium: the menu's sunlit atrium (Atrium.tsx) as a dance stage. The dancers dance on a round
// floor in front of the reflecting pool, the aquarium column rising behind them under the dome,
// seen from the entrance across the atrium. The room is lit by its own shaders; the stage's lights
// are for the glass dancers, the sun's among them casting their shadows.

// The backdrop's clock runs at half speed with prefers-reduced-motion; so does this one.
const MOTION = reducedMotion ? 0.5 : 1;
const SUN = SUN_DIR.clone().multiplyScalar(30).toArray();

// What the glass dancers reflect: the dome's sky overhead, the sun, the trees on the left, the
// glass wall's sky on the right and the sunlit balconies behind the camera. Blues kept rich, as a
// pale room greys their gel out.
const ENV_LIGHTS: readonly EnvironmentLight[] = [
  { position: [0, 24, -4], color: '#e6f5ff', intensity: 4, size: [26, 26] },
  { position: SUN_DIR.clone().multiplyScalar(40).toArray(), color: '#fff2d8', intensity: 6, size: [6, 6] },
  { position: [-18, 5, -4], color: '#6fe08a', intensity: 1.6, size: [10, 10] },
  { position: [18, 6, -4], color: '#7fd0ff', intensity: 2, size: [10, 12] },
  { position: [0, 4, 24], color: '#3fb0ff', intensity: 1.3, size: [24, 8] },
];

export default function AtriumStage() {
  const uniforms = useMemo(() => makeAtriumUniforms({ fov: STAGE_CAMERA.fov, foreShade: 0 }), []);
  useFrame((state) => {
    uniforms.uTime.value = state.clock.elapsedTime * MOTION;
    uniforms.uBeat.value = beat.pulse;
    uniforms.uBeatPhase.value = beat.phase;
    post.bloomStrength = meta.post.bloomStrength + beat.pulse * 0.03;
  });
  return (
    <>
      <StageCamera
        position={STAGE_CAMERA.position}
        target={STAGE_CAMERA.target}
        fov={STAGE_CAMERA.fov}
        near={0.3}
        far={3000}
        orbit={[0.08, 0.02]}
        sway={[0.12, 0.05, 0]}
        parallax={[0.35, 0.15]}
      />
      <StageEnvironment top="#cfeaff" horizon="#2a8fd8" bottom="#0e4a66" lights={ENV_LIGHTS} intensity={1.8} />
      <hemisphereLight args={['#d6eeff', '#8fae9a', 0.5]} />
      <directionalLight
        castShadow
        position={SUN}
        intensity={2.6}
        color="#fff4e2"
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-5}
        shadow-camera-right={5}
        shadow-camera-top={5}
        shadow-camera-bottom={-5}
        shadow-camera-near={10}
        shadow-camera-far={50}
        shadow-normalBias={0.03}
        shadow-bias={-0.0004}
      />
      <Atrium uniforms={uniforms} />
      <DanceFloor uniforms={uniforms} />
    </>
  );
}
