import { AtriumScene } from './AtriumStage.tsx';
import { LOOKS } from './looks.ts';
import { atrium } from './meta.ts';

/** atrium: the atrium at sunlit midday. */
export default function AtriumDayStage() {
  return <AtriumScene look={LOOKS.day} post={atrium.post} />;
}
