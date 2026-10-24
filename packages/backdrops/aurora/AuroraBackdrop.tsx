// aurora: a luminous polar night. Emerald, teal and violet curtains fold slowly over snowy
// peaks and a pine shore, mirrored in a still lake with a warm glass cabin on its far side,
// under twinkling stars and the odd shooting star. See world.ts for how the reflections work.
import { reducedMotion, useDisposable } from '../../stages/shared/hooks.ts';
import { BackdropCamera } from '../shared/BackdropCamera.tsx';
import { useBackdropFrame } from '../shared/frame.ts';
import { AuroraCurtains, type Curtain } from './Aurora.tsx';
import { Lake, Mist } from './Lake.tsx';
import { Cabin, Mountains, Pines } from './Land.tsx';
import { Fireflies } from './Life.tsx';
import { makeNoiseTexture } from './noise.ts';
import { NightSky } from './Sky.tsx';
import { CAMERA, world } from './world.ts';

// Far beyond the peaks: the main arc sweeps down from high on the left (above the menu's
// title) to just over the peaks on the right, with a brighter curtain over the menu dancers.
// Fainter violet ones farther off are painted into the sky (world.ts farAurora).
const CURTAINS: readonly Curtain[] = [
  { line: [-2200, -1500, 2600, -2800], bottom: [600, 330], height: [1000, 900], fold: 170, bow: 300, gain: [0.3, 1.0], rays: 90, seed: 0.13, reflected: true },
  { line: [200, -1700, 2600, -2300], bottom: [370, 285], height: [820, 720], fold: 120, bow: 120, gain: [0.9, 0.8], rays: 80, seed: 0.57, reflected: true },
];

function Clock() {
  useBackdropFrame((_state, _delta, time) => {
    world.uTime.value = time;
  });
  return null;
}

export default function AuroraBackdrop() {
  world.uNoise.value = useDisposable(makeNoiseTexture);
  return (
    <>
      <Clock />
      <BackdropCamera
        position={CAMERA.position}
        target={CAMERA.target}
        fov={CAMERA.fov}
        near={0.5}
        far={8000}
        sway={reducedMotion ? [0, 0, 0] : [1.6, 0.35, 0]}
        swaySpeed={0.8}
        parallax={[2.2, 0.6]}
      />
      <NightSky />
      <Lake />
      <Mountains />
      <Cabin />
      <AuroraCurtains curtains={CURTAINS} />
      <Pines />
      <Mist />
      <Fireflies />
    </>
  );
}
