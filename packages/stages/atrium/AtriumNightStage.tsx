import { AtriumScene, LOOKS } from './AtriumStage.tsx';
import { atriumnight } from './meta.ts';

/** atriumnight: the atrium after dark. */
export default function AtriumNightStage() {
  return <AtriumScene look={LOOKS.night} post={atriumnight.post} />;
}
