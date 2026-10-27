import { useFrame } from '@react-three/fiber';
import { stagePlay } from '../shared/hooks.ts';
import { damp } from '../shared/random.ts';
import type { OrbitVariant } from './layout.ts';
import { life } from './glints.ts';
import { Meteors, Satellites } from './Orbits.tsx';
import { Craft } from './Craft.tsx';
import { Bokeh, Dust, SeedPuffs } from './Sparkle.tsx';

/** Eases the life's calm in while the dancers dance, and out again after. */
function Calm() {
  useFrame((_state, delta) => {
    life.uCalm.value = damp(life.uCalm.value, stagePlay.dancing ? 1 : 0, 1.5, Math.min(delta, 0.1));
  });
  return null;
}

/** Everything that moves round the station: satellites, craft and sparkle. */
export function Life(variant: OrbitVariant) {
  const { night, dome } = variant;
  return (
    <>
      <Calm />
      <Satellites />
      {night && <Meteors />}
      <Craft {...variant} />
      <Dust dome={dome} />
      {dome && <SeedPuffs />}
      <Bokeh />
    </>
  );
}
