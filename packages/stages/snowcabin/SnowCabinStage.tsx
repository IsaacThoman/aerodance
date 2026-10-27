// snowcabin: placeholder, to be replaced by the real stage.
import { StageCamera } from '../shared/hooks.ts';
import { StageEnvironment } from '../shared/Environment.tsx';
import type { EnvironmentLight } from '../shared/Environment.tsx';
import { usePolarWorld } from '../polar/world.ts';
import { NightSky } from '../polar/Sky.tsx';
import { AuroraCurtains } from '../polar/Aurora.tsx';
import type { Curtain } from '../polar/Aurora.tsx';
import { FarPines, Mountains, massifHeight, scatterPines } from '../polar/Land.tsx';
import type { LandArea, Peak } from '../polar/Land.tsx';
import { Snowfall } from '../polar/Snowfall.tsx';

const CURTAINS: readonly Curtain[] = [
  { line: [-2200, -1500, 2600, -2800], bottom: [260, 200], height: [900, 800], fold: 170, bow: 300, gain: [0.6, 1.0], rays: 90, seed: 0.13, reflected: false },
  { line: [-1400, -1300, 1800, -1700], bottom: [150, 120], height: [700, 620], fold: 120, bow: 120, gain: [0.9, 0.8], rays: 80, seed: 0.57, reflected: false },
];

const PEAKS: readonly Peak[] = [
  [250, -720, 150, 290],
  [-260, -820, 120, 300],
  [700, -900, 130, 300],
  [-800, -900, 110, 340],
];

const AREA: LandArea = { left: -1500, right: 1500, front: -60, back: -1800 };
const height = (x: number, z: number) => Math.max(0, massifHeight(PEAKS, x, z) + 6 * Math.min(1, (-60 - z) / 200));
const PINES = scatterPines({
  count: 300,
  spot: (rand) => [rand.range(-400, 400), rand.range(-60, -300)],
  height,
  size: () => 14,
});

const ENV_LIGHTS: EnvironmentLight[] = [
  { position: [0, 20, -40], color: '#2affb0', intensity: 2.5, size: [60, 14] },
  { position: [-12, 4, -14], color: '#ffa860', intensity: 3, size: [6, 6] },
  { position: [0, 8, 34], color: '#9cc8ff', intensity: 1.6, size: [50, 16] },
];

export default function SnowCabinStage() {
  usePolarWorld();
  return (
    <>
      <StageCamera position={[0, 1.9, 15]} target={[0, 2.4, 0]} fov={42} near={0.3} far={6000} orbit={[0.05, 0.012]} sway={[0.1, 0.04, 0]} />
      <StageEnvironment top="#0a2050" horizon="#1d6f78" bottom="#c8dcf2" lights={ENV_LIGHTS} intensity={1} />
      <hemisphereLight args={['#4a7ad0', '#d8e8ff', 0.5]} />
      <directionalLight castShadow position={[-6, 9, 8]} color="#a8c8ff" intensity={1.6} shadow-mapSize={[2048, 2048]} shadow-camera-left={-9} shadow-camera-right={9} shadow-camera-top={9} shadow-camera-bottom={-9} />
      <NightSky />
      <Mountains height={height} area={AREA} />
      <AuroraCurtains curtains={CURTAINS} />
      <FarPines pines={PINES} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[400, 400]} />
        <meshStandardMaterial color="#c8d8ee" roughness={0.85} />
      </mesh>
      <Snowfall />
    </>
  );
}
