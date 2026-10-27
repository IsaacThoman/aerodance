import { AtriumScene } from './AtriumStage.tsx';
import { LOOKS } from './looks.ts';
import { atriumnight } from './meta.ts';

/** atriumnight: the atrium after dark. */
export default function AtriumNightStage() {
  return <AtriumScene look={LOOKS.night} post={atriumnight.post} />;
}
