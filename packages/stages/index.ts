import { lazy } from 'react';
import { STAGE_METAS } from './catalog.ts';

export { DEFAULT_STAGE, STAGE_LIST, resolveStage, stageName } from './catalog.ts';

// Each stage component loads lazily, so only the visible stage is fetched.
const LOADERS = {
  sanctuary: () => import('./sanctuary/SanctuaryStage.tsx'),
  reef: () => import('./reef/ReefStage.tsx'),
  openreef: () => import('./openreef/OpenReefStage.tsx'),
  falls: () => import('./falls/FallsStage.tsx'),
  club: () => import('./club/ClubStage.tsx'),
  beach: () => import('./beach/BeachStage.tsx'),
};

// Dance stages in browse order: { meta (see catalog.js), Component }.
export const STAGES = STAGE_METAS.map((meta) => ({ meta, Component: lazy(LOADERS[meta.id]) }));

// Starts fetching a stage before it's shown (the browser keeps the module for lazy()).
export const preloadStage = (id) => LOADERS[id]?.().catch(() => {});
