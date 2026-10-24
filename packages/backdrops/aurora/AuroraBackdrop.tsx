// aurora: a luminous polar night. Emerald, teal and violet curtains fold slowly over snowy
// peaks and a pine shore, mirrored in a still lake with a warm glass cabin on its far side,
// under twinkling stars and the odd shooting star. See world.ts for how the reflections work.
import { reducedMotion } from '../../stages/shared/hooks.ts';
import { BackdropCamera } from '../shared/BackdropCamera.tsx';
import { useBackdropFrame } from '../shared/frame.ts';
import { AuroraCurtains, type Curtain } from './Aurora.tsx';
import { Lake, Mist } from './Lake.tsx';
import { Cabin, Mountains, Pines } from './Land.tsx';
import { Fireflies } from './Life.tsx';
import { NightSky } from './Sky.tsx';
import { CAMERA, world } from './world.ts';

// Far beyond the peaks: the main arc sweeps down from high on the left (above the menu's
// title) to just over the peaks on the right, with a brighter, more folded curtain over the
// menu dancers and fainter violet ones behind.
const CURTAINS: readonly Curtain[] = [
  { line: [-2200, -1500, 2600, -2800], bottom: [600, 330], height: [1000, 900], fold: 170, bow: 300, gain: [0.3, 1.0], rays: 90, seed: 0.13 },
  { line: [200, -1700, 2600, -2300], bottom: [370, 285], height: [820, 720], fold: 120, bow: 120, gain: [0.9, 0.8], rays: 80, seed: 0.57 },
  { line: [-2800, -2600, 2400, -3600], bottom: [1150, 850], height: [1300, 1200], fold: 220, bow: 200, gain: [0.2, 0.5], rays: 70, seed: 0.81 },
  { line: [-3000, -1600, -200, -2600], bottom: [1100, 850], height: [1100, 1100], fold: 140, bow: 0, gain: [0.15, 0.3], rays: 60, seed: 0.36 },
];

function Clock() {
  useBackdropFrame((_state, _delta, time) => {
    world.uTime.value = time;
  });
  return null;
}

export default function AuroraBackdrop() {
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
