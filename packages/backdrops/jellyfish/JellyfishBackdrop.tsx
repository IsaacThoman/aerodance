import { SkyDome } from '../../stages/shared/Sky.tsx';
import { BackdropCamera } from '../shared/BackdropCamera.tsx';

// Placeholder until the scene is built.
export default function JellyfishBackdrop() {
  return (
    <>
      <BackdropCamera position={[0, 2, 12]} target={[0, 3, 0]} />
      <SkyDome top="#041a4a" horizon="#1a6ad8" bottom="#020a20" sunDisc={0} sunGlow={0} />
    </>
  );
}
