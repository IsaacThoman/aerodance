import { BackdropCamera } from '../shared/BackdropCamera.tsx';
import { useBackdropFrame } from '../shared/frame.ts';
import { CAMERA_FOV, CAMERA_POSITION, CAMERA_TARGET, atmos } from './palette.ts';
import { SunriseSky } from './Sky.tsx';
import { CloudSea } from './CloudSea.tsx';
import { Fleet } from './Fleet.tsx';
import { CloudBanks } from './CloudBanks.tsx';
import { Birds } from './Birds.tsx';
import { SunFlare } from './Flare.tsx';
import { Motes } from './Motes.tsx';

// One clock for the scene's shared uniforms.
function Clock() {
  useBackdropFrame((_state, _delta, time) => {
    atmos.uTime.value = time;
  });
  return null;
}

/** Sunrise above an endless sea of clouds. */
export default function CloudSeaBackdrop() {
  return (
    <>
      <Clock />
      <BackdropCamera position={CAMERA_POSITION} target={CAMERA_TARGET} fov={CAMERA_FOV} near={1} far={9000} sway={[3, 1.2, 0]} parallax={[4, 1.6]} />
      <SunriseSky />
      <CloudSea />
      <CloudBanks />
      <Fleet />
      <Birds />
      <Motes />
      <SunFlare />
    </>
  );
}
