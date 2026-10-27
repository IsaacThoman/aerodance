// snowcabin: a clearing of fresh, sparkling snow in a pine forest at night, the dancers in front
// of a glass A-frame cabin glowing warm from inside, under the northern lights. Warm windows and
// lanterns against the cool moon and aurora.
import { useFrame } from '@react-three/fiber';
import { StageCamera, beat, reducedMotion } from '../shared/hooks.ts';
import { smoothstep } from '../shared/random.ts';
import { post } from '../shared/post.tsx';
import { StageEnvironment } from '../shared/Environment.tsx';
import type { EnvironmentLight } from '../shared/Environment.tsx';
import { usePolarWorld } from '../polar/world.ts';
import { AuroraCurtains } from '../polar/Aurora.tsx';
import type { Curtain } from '../polar/Aurora.tsx';
import { FarPines, Mountains, scatterPines } from '../polar/Land.tsx';
import { Snowfall } from '../polar/Snowfall.tsx';
import meta from './meta.ts';
import { snowcabin } from './palette.ts';
import { FAR_CUT, LAND_AHEAD, LAND_BEHIND, farHeight, landHeight } from './terrain.ts';
import { cabinClearance } from './layout.ts';
import { SnowSky, MOON } from './Sky.tsx';
import { Ground } from './Ground.tsx';
import { Cabin } from './Cabin.tsx';
import { Pines } from './Pines.tsx';
import { MOON_LIGHT } from './forest.ts';
import { Props } from './Props.tsx';
import { Lights } from './Lights.tsx';

const BLOOM = meta.post.bloomStrength;

// Curtains ahead and overhead, and a fainter pair behind the camera for the preview's circle.
const CURTAINS: readonly Curtain[] = [
  { line: [-2200, -1500, 2600, -2800], bottom: [260, 200], height: [900, 800], fold: 170, bow: 300, gain: [0.6, 1.0], rays: 90, seed: 0.13, reflected: false },
  { line: [-1400, -1300, 1800, -1700], bottom: [150, 120], height: [700, 620], fold: 120, bow: 120, gain: [0.9, 0.8], rays: 80, seed: 0.57, reflected: false },
  { line: [1900, 1300, -2100, 2300], bottom: [240, 300], height: [800, 900], fold: 160, bow: 240, gain: [0.7, 0.5], rays: 85, seed: 0.31, reflected: false },
  { line: [-2400, 600, -1800, -2200], bottom: [220, 260], height: [760, 700], fold: 140, bow: 200, gain: [0.45, 0.7], rays: 75, seed: 0.79, reflected: false },
];

// Dark pines filling the forest round the clearing and up the foothills, but standing well back
// beyond the dancers, where a long white meadow opens towards the peaks. Sorted far from the
// middle first, so wherever the preview's camera is, nearer ones blend over farther ones.
const FAR_PINES = scatterPines({
  count: 560,
  spot: (rand) => {
    // a: 0 straight out beyond the dancers.
    const a = rand.range(-Math.PI, Math.PI);
    const meadow = 1 - smoothstep(0.5, 1.1, Math.abs(a));
    const r = 42 + meadow * 80 + rand.next() ** 1.5 * 380;
    const x = Math.sin(a) * r;
    const z = -Math.cos(a) * r;
    return cabinClearance(x, z) < 12 ? null : [x, z];
  },
  height: landHeight,
  size: (x, z) => 13 + Math.hypot(x, z) * 0.03,
}).sort((a, b) => Math.hypot(b.x, b.z) - Math.hypot(a.x, a.z));

const moonLight = MOON.clone().multiplyScalar(30).toArray();

// Reflections for the glass dancers: the aurora overhead and ahead, the moon, the cabin's warm
// glass behind on the left and the snow's cool glow in front.
const ENV_LIGHTS: EnvironmentLight[] = [
  { position: [0, 22, -40], color: '#2affb0', intensity: 2.2, size: [60, 14] },
  { position: [-18, 6, -22], color: '#ffa458', intensity: 4, size: [9, 9] },
  { position: [moonLight[0], moonLight[1], moonLight[2]], color: '#e4ecff', intensity: 6, size: [3, 3] },
  { position: [0, 8, 34], color: '#9cc8ff', intensity: 1.5, size: [50, 16] },
  { position: [-14, 3, 10], color: '#ffb070', intensity: 1.6, size: [5, 5] },
  { position: [16, 3, 10], color: '#ffb070', intensity: 1.2, size: [5, 5] },
];

function Clock() {
  useFrame((state) => {
    const t = reducedMotion ? 0 : state.clock.elapsedTime;
    snowcabin.uBeat.value = beat.pulse;
    snowcabin.uFire.value = 1 + 0.06 * Math.sin(t * 7.3) + 0.04 * Math.sin(t * 13.1 + 1.7);
    snowcabin.uLanterns.value.forEach((l, i) => {
      l.w = (0.9 + 0.07 * Math.sin(t * 9 + i * 2.3) + 0.04 * Math.sin(t * 23 + i)) * (1 + 0.12 * beat.pulse);
    });
    // Bloom breathes a little with the beat.
    post.bloomStrength = BLOOM * (1 + 0.15 * beat.pulse);
  });
  return null;
}

export default function SnowCabinStage() {
  usePolarWorld();
  return (
    <>
      <Clock />
      <StageCamera position={[0, 2.4, 15.5]} target={[0, 2.1, 0]} fov={40} near={0.3} far={6000} orbit={reducedMotion ? [0, 0] : [0.05, 0.012]} sway={reducedMotion ? [0, 0, 0] : [0.1, 0.04, 0]} />
      <StageEnvironment top="#0a2050" horizon="#1d6f78" bottom="#c8dcf2" lights={ENV_LIGHTS} intensity={1} />
      <hemisphereLight args={['#3a64c8', '#8fa8e0', 1.1]} />
      <directionalLight
        castShadow
        position={MOON_LIGHT.toArray()}
        color="#9ab8ff"
        intensity={1.6}
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
      <SnowSky />
      <Mountains height={farHeight} area={LAND_AHEAD} cut={FAR_CUT} />
      <Mountains height={farHeight} area={LAND_BEHIND} cut={FAR_CUT} />
      {/* The glass dancers write no depth: layers behind them blend first (negative orders), not over them. */}
      <AuroraCurtains curtains={CURTAINS} renderOrder={-50} />
      <FarPines pines={FAR_PINES} renderOrder={-40} />
      <Ground />
      <Cabin />
      <Pines />
      <Props />
      <Lights />
      <Snowfall count={4200} center={[0, 7, 0]} size={[84, 16, 84]} flake={0.06} intensity={1.2} fade={38} />
    </>
  );
}
