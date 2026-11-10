import { useMemo } from 'react';
import { BackdropCamera } from '../shared/BackdropCamera.tsx';
import { useBackdropFrame } from '../shared/frame.ts';
import { FAR, MID, NEAR, THREADS, glintData } from './layout.ts';
import { world } from './palette.ts';
import { Glints, Ribbons } from './Ribbons.tsx';
import { Bokeh, RibbonSky } from './Sky.tsx';

function Clock() {
  useBackdropFrame((_state, _delta, time) => {
    world.uTime.value = time;
  });
  return null;
}

/**
 * Ribbons: silky swooshes of light, Vista Aurora / Xbox 360 style, sweeping across a bright
 * sky. Far sheets drift high up, the hero sweep (lime, white, cyan) rises across the top
 * towards the light on the right, a cooler aqua sweep runs low along the bottom, and a soft
 * lime swoosh passes out of focus in front. Glints ride the strands' edges; bokeh drifts up.
 */
export default function RibbonsBackdrop() {
  const glints = useMemo(() => glintData(THREADS, 21, 51), []);
  return (
    <>
      <Clock />
      <BackdropCamera position={[0, 0, 22]} target={[0, 0, 0]} fov={42} sway={[0.9, 0.35, 0.6]} parallax={[0.7, 0.35]} />
      <RibbonSky />
      <Ribbons bundles={FAR} fibres={0.3} specular={0.4} softness={0.6} minPixels={2} renderOrder={1} />
      <Bokeh renderOrder={2} />
      <Ribbons bundles={MID} fibres={0.9} renderOrder={3} />
      <Ribbons bundles={THREADS} fibres={0} specular={0.6} softness={0.5} minPixels={1.6} renderOrder={4} />
      <Glints data={glints} renderOrder={5} />
      <Ribbons bundles={NEAR} fibres={0} specular={0.5} softness={0.8} minPixels={3} renderOrder={6} />
    </>
  );
}
