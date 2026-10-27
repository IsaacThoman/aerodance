import { AtriumScene, LOOKS } from './AtriumStage.tsx';
import { atrium } from './meta.ts';

/** atrium: the atrium at sunlit midday. */
export default function AtriumDayStage() {
  return <AtriumScene look={LOOKS.day} post={atrium.post} />;
}
