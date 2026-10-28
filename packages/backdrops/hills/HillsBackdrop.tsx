// Bliss Hills: Windows XP's "Bliss" by way of Aero. Smooth emerald hills with wind sweeping the
// grass and cloud shadows drifting over them, a sparkling river winding down the valley, glossy
// white turbines turning on the ridge under the sun, big cumulus in a deep blue sky.
import { useMemo } from 'react';
import { useDisposable } from '../../stages/shared/hooks.ts';
import { makeCloudAtlas } from '../../stages/shared/Sky.tsx';
import { BackdropCamera } from '../shared/BackdropCamera.tsx';
import { useBackdropFrame } from '../shared/frame.ts';
import { fx, makeNoiseTexture, tickHills } from './fx.ts';
import { Motes } from './Air.tsx';
import { Wildflowers } from './Flowers.tsx';
import { Greenhouses, type DomeSite } from './Greenhouse.tsx';
import { Land, River } from './Land.tsx';
import { BlissSky, Cumulus, SunFlare } from './Sky.tsx';
import { CAMERA, crestPoint, groundPoint } from './terrain.ts';
import { Turbines, type TurbineSite } from './Turbines.tsx';

// Along the skyline of the ridge on the right, [azimuth degrees right of ahead, size]: big at the
// frame's edge, smaller as the ridge recedes towards the valley.
const TURBINE_VIEW: readonly (readonly [number, number])[] = [[35, 0.98], [28.5, 0.92], [22.5, 0.82], [17, 0.72]];

function Driver() {
  useBackdropFrame((_state, _delta, time) => tickHills(time));
  return null;
}

export default function HillsBackdrop() {
  const turbines = useMemo(
    () =>
      TURBINE_VIEW.map(([azimuth, size]): TurbineSite => {
        const [x, z, r] = crestPoint(azimuth, 60, 300);
        const back = (r + 8) / r;
        // Scaled with distance, so `size` is how big it looks.
        return [CAMERA.position[0] + (x - CAMERA.position[0]) * back, CAMERA.position[2] + (z - CAMERA.position[2]) * back, (size * r) / 200];
      }),
    [],
  );
  // A pair of glass domes on the far bank, in the open middle of the frame between menu and dancers.
  const domes = useMemo((): DomeSite[] => {
    const [x, z] = groundPoint(0.2, -5);
    return [[x, z, 8], [x + 12, z + 6, 4.8]];
  }, []);
  const noise = useDisposable(makeNoiseTexture);
  fx.uNoise.value = noise;
  const clouds = useDisposable(() => makeCloudAtlas(7));
  return (
    <>
      <Driver />
      <BackdropCamera position={CAMERA.position} target={CAMERA.target} fov={CAMERA.fov} near={0.5} far={8000} sway={[0.8, 0.25, 0]} parallax={[1.2, 0.4]} />
      <BlissSky />
      <Cumulus atlas={clouds} count={9} center={[0, 330, -1500]} area={[4200, 500]} heightJitter={90} size={[520, 820]} speed={2.4} seed={5} />
      <Cumulus atlas={clouds} count={7} center={[0, 120, -1100]} area={[3000, 300]} heightJitter={30} size={[260, 420]} speed={3.2} seed={11} renderOrder={-499} />
      <Land />
      <River />
      <Turbines sites={turbines} />
      <Greenhouses sites={domes} />
      <Wildflowers />
      <Motes />
      <SunFlare />
    </>
  );
}
