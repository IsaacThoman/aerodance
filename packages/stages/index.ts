import { lazy } from 'react';
import type { ComponentType, LazyExoticComponent } from 'react';
import { STAGE_METAS } from './catalog.ts';
import type { StageId, StageMeta } from './catalog.ts';

export { DEFAULT_STAGE, STAGE_LIST, isStageId, resolveStage } from './catalog.ts';
export type { DancerPlacement, PreviewOrbit, StageId, StageListing, StageMeta, Vec2, Vec3 } from './catalog.ts';

/**
 * What the host passes a `<Name>Stage`: nothing. A stage reads its meta and the live state it
 * reacts to (beat, post, stageOrbit) from the shared modules, and renders into the host's scene.
 */
export type StageProps = Record<string, never>;
export type StageComponent = ComponentType<StageProps>;

export interface Stage {
  meta: StageMeta;
  Component: LazyExoticComponent<StageComponent>;
}

// Each stage component loads lazily, so only the visible stage is fetched.
const LOADERS: Record<StageId, () => Promise<{ default: StageComponent }>> = {
  sanctuary: () => import('./sanctuary/SanctuaryStage.tsx'),
  reef: () => import('./reef/ReefStage.tsx'),
  openreef: () => import('./openreef/OpenReefStage.tsx'),
  falls: () => import('./falls/FallsStage.tsx'),
  club: () => import('./club/ClubStage.tsx'),
  beach: () => import('./beach/BeachStage.tsx'),
  atrium: () => import('./atrium/AtriumStage.tsx'),
  pond: () => import('./pond/PondStage.tsx'),
};

// Dance stages in browse order (see catalog.ts).
export const STAGES: readonly Stage[] = STAGE_METAS.map((meta) => ({ meta, Component: lazy(LOADERS[meta.id]) }));

// Starts fetching a stage before it's shown (the browser keeps the module for lazy()).
export const preloadStage = (id: StageId): Promise<unknown> => LOADERS[id]().catch(() => {});
