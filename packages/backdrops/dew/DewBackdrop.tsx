import { BackdropCamera } from '../shared/BackdropCamera.tsx';
import { useBackdropFrame } from '../shared/frame.ts';
import { Bokeh, Canopy, Rain, Shafts } from './Distance.tsx';
import { CAMERA_POSITION, CAMERA_TARGET, FOV, inFrame } from './frame.ts';
import { Leaf } from './Leaf.tsx';
import type { LeafColors, LeafSpec } from './Leaf.tsx';
import { dew } from './light.ts';

// Macro dewdrops: a big glossy leaf beaded with water reaches in from the upper right, lit
// from behind by the sun; now and then a drop lets go, slides down it and falls from the
// tip. A second leaf rises at the lower left, blurred leaves and bokeh fill the distance.

const SUNLIT: LeafColors = { deep: '#0f5512', fresh: '#2e9418', vein: '#8fd04a', under: '#7fb860', glow: '#a4e83a' };
const SHADED: LeafColors = { deep: '#082e0c', fresh: '#1a6014', vein: '#4f9a2e', under: '#4f7a40', glow: '#86d030' };
const FAR: LeafColors = { deep: '#185a16', fresh: '#2f8420', vein: '#5aa83a', under: '#6a9a50', glow: '#a0e040' };

const LEAVES: LeafSpec[] = [
  // Far left, deep in shade behind the title: just a darker shape.
  {
    base: inFrame(-1.3, 0.95, -12), dir: [15, -7, 0], face: [0, 0.3, 1], length: 17, width: 4.2,
    droop: 0.2, cup: 0.15, sway: 0.03, phase: 2.0, blur: 0.9, haze: 0.15, translucency: 0.4, gloss: 0.3,
    colors: SHADED, renderOrder: -45,
  },
  // Behind the dancers: a big blurred leaf, mid green, so their glass reads against it.
  {
    base: inFrame(1.3, -1.35, -7), dir: [-12.6, 9.6, 0], face: [0.05, 0.35, 1], length: 15, width: 3.8,
    droop: 0.25, cup: 0.2, twist: -0.2, sway: 0.03, phase: 4.0, blur: 0.45, haze: 0.12, translucency: 1.0, gloss: 0.35,
    colors: FAR, renderOrder: -40,
  },
  // The star: in focus, beaded with drops, dripping from its tip.
  {
    base: inFrame(1.12, 0.95, 0), dir: [-6.5, -2.4, 0], face: [0.1, 0.45, 0.88], length: 7.4, width: 1.75,
    droop: 0.35, cup: 0.22, twist: 0.15, ripple: 0.06, curve: -0.04, sway: 0.035, phase: 0,
    blur: 0, translucency: 1.0, gloss: 1.0, colors: SUNLIT, veins: [10, 1.5, 0.07, 0.55],
    drops: { count: 24, seed: 11, size: [0.06, 0.3] },
    drip: { period: 11, offset: 0.1, from: [0.45, 0.25], size: 0.22, hang: 0.32 },
    renderOrder: 0,
  },
  // Lower left, nearer: under the menu buttons.
  {
    base: inFrame(-1.15, -1.25, 1.5), dir: [4.4, 1.55, 0.3], face: [0, 0.7, 0.7], length: 5, width: 1.3,
    droop: 0.3, cup: 0.25, twist: -0.1, sway: 0.04, phase: 1.3, blur: 0.012, translucency: 0.9, gloss: 1.0,
    colors: SUNLIT, drops: { count: 12, seed: 4, size: [0.05, 0.16] },
    drip: { period: 17, offset: 0.55, from: [0.55, 0.3], size: 0.14, hang: 0.15 },
    ladybug: { centre: [0.6, -0.38], reach: [0.1, 0.18], size: 0.32, speed: 0.11 },
    renderOrder: 10,
  },
  // Foreground, top left: a leaf tip right in front of the lens, far out of focus.
  {
    base: inFrame(-1.25, 1.3, 5), dir: [2.4, -0.75, 0], face: [0, 0.2, 1], length: 2.0, width: 0.48,
    droop: 0.3, cup: 0.2, sway: 0.05, phase: 3.1, blur: 0.1, haze: 0.0, translucency: 1.0, gloss: 0.4,
    colors: SHADED, renderOrder: 20,
  },
];

export default function DewBackdrop() {
  useBackdropFrame((_state, _delta, time) => {
    dew.uTime.value = time;
  });
  return (
    <>
      <BackdropCamera position={CAMERA_POSITION} target={CAMERA_TARGET} fov={FOV} sway={[0.15, 0.08, 0.12]} swaySpeed={0.8} parallax={[0.25, 0.15]} />
      <Canopy />
      <Bokeh />
      <Rain />
      <Shafts />
      {LEAVES.map((leaf) => <Leaf key={leaf.renderOrder} {...leaf} />)}
    </>
  );
}
