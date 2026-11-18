import type { StageId } from '../../../../../packages/stages/catalog.ts';
import { useCameraViews } from '../kit.ts';
import type { ScreensaverContext } from '../types.ts';
import { SceneClock } from './clocks.tsx';
import { SHOTS } from './shots.ts';

/*
 * Dance Party, mounted inside the stage's scene: flies the stage's camera through the views
 * (shots.ts; `stage` is left to the stage's own camera) and, while the Clock setting is In
 * scene, puts a clock that belongs there on the stage (clocks.tsx).
 */
export default function DanceParty({ ctx }: { ctx: ScreensaverContext }) {
  useCameraViews(ctx, SHOTS[ctx.scenario as StageId] ?? SHOTS.openreef);
  return <SceneClock ctx={ctx} />;
}
