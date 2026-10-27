import { BackdropCamera } from '../shared/BackdropCamera.tsx';
import { useBackdropFrame } from '../shared/frame.ts';
import { FOV, ORIGIN, SUN_BOB, SUN_LIFT, SUN_PERIOD, keyDirection, sunDirection, world } from './layout.ts';
import { Planet } from './Planet.tsx';
import { Moon, SpaceSky, Stars } from './Space.tsx';
import { Orbits } from './Orbits.tsx';
import { SunFlare } from './Flare.tsx';
import { Station } from './Station.tsx';
import { Bokeh } from './Bokeh.tsx';

// Moves the shared uniforms on: the clock, and the sun rising a little over the limb and back.
function Clock() {
  useBackdropFrame((state, _delta, time) => {
    world.uTime.value = time;
    const lift = SUN_LIFT + SUN_BOB * Math.sin((time / SUN_PERIOD) * Math.PI * 2);
    sunDirection(ORIGIN, lift, world.uSunDir.value);
    keyDirection(world.uSunDir.value, state.camera.position, world.uKeyDir.value);
  });
  return null;
}

/**
 * Orbit: a glossy blue Earth from orbit. Its limb sweeps up across the lower right, under the menu
 * dancers, with the sun cresting it in a starburst; clouds drift over its oceans and continents,
 * city lights glitter on the night side and satellites trail light around it. A white-and-glass
 * station drifts above the title, against deep navy space, a faint nebula and a crescent Moon.
 */
export default function OrbitBackdrop() {
  return (
    <>
      <Clock />
      <BackdropCamera position={[0, 0, 0]} target={[0, 0, -100]} fov={FOV} near={0.5} far={4000} sway={[1.4, 0.7, 1.2]} swaySpeed={0.7} parallax={[1.6, 0.9]} />
      <SpaceSky />
      <Stars />
      <Moon />
      <Planet />
      <Orbits />
      <Station />
      <Bokeh />
      <SunFlare />
    </>
  );
}
