import { SkyDome } from '../../stages/shared/Sky.tsx';
import { BackdropCamera } from '../shared/BackdropCamera.tsx';

// Placeholder until the scene is built.
export default function RibbonsBackdrop() {
  return (
    <>
      <BackdropCamera position={[0, 2, 12]} target={[0, 3, 0]} />
      <SkyDome top="#1aa0ff" horizon="#dfffd0" bottom="#0a5ab0" sunDisc={0} sunGlow={0} />
    </>
  );
}
