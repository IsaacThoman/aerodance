import { lazy } from 'react';
import type { ComponentType, LazyExoticComponent } from 'react';
import { BACKDROP_METAS } from './catalog.ts';
import type { BackdropId, BackdropMeta } from './catalog.ts';

export { BACKDROP_METAS, isBackdropId } from './catalog.ts';
export type { BackdropId, BackdropMeta } from './catalog.ts';

/** A backdrop takes no props: it reads the shared clock (shared/frame.ts) and renders into the host's scene. */
export type BackdropComponent = ComponentType<Record<string, never>>;

export interface Backdrop {
  meta: BackdropMeta;
  Component: LazyExoticComponent<BackdropComponent>;
}

// Each backdrop loads lazily, so only the one showing is fetched.
const LOADERS: Record<BackdropId, () => Promise<{ default: BackdropComponent }>> = {
  aurora: () => import('./aurora/AuroraBackdrop.tsx'),
  bubbles: () => import('./bubbles/BubblesBackdrop.tsx'),
  ribbons: () => import('./ribbons/RibbonsBackdrop.tsx'),
  cloudsea: () => import('./cloudsea/CloudSeaBackdrop.tsx'),
  hills: () => import('./hills/HillsBackdrop.tsx'),
  koi: () => import('./koi/KoiBackdrop.tsx'),
  atrium: () => import('./atrium/AtriumBackdrop.tsx'),
  dew: () => import('./dew/DewBackdrop.tsx'),
  orbit: () => import('./orbit/OrbitBackdrop.tsx'),
  jellyfish: () => import('./jellyfish/JellyfishBackdrop.tsx'),
};

export const BACKDROPS: readonly Backdrop[] = BACKDROP_METAS.map((meta) => ({ meta, Component: lazy(LOADERS[meta.id]) }));
