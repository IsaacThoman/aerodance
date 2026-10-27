import { AtriumScene, LOOKS } from './AtriumStage.tsx';
import { atriumdusk } from './meta.ts';

/** atriumdusk: the atrium at golden hour. */
export default function AtriumDuskStage() {
  return <AtriumScene look={LOOKS.dusk} post={atriumdusk.post} />;
}
