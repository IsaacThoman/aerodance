import { lazy } from 'react';
import type { ComponentType } from 'react';
import { butterflyIcon, clockIcon, fishIcon, skylineIcon } from './icons.ts';
import { paddleIcon } from '../minigames/table-tennis/art.ts';
import type { IconDraw, IconName } from '../ui/draw.ts';

interface Screensaver {
  id: string;
  title: string;
  views: readonly string[];
  icon: IconName | IconDraw;
  clock?: boolean;
  shadows?: boolean;
  /** Direct-to-screen ACES exposure for scenes lit in linear space. */
  exposure?: number;
  Content: ComponentType<{ view: number; clock: boolean }>;
}

export const scenes: readonly Screensaver[] = [
  {
    id: 'rally', title: 'Canopy Rally', views: ['Courtside', 'Skybox'], icon: paddleIcon, clock: true, shadows: true, exposure: 0.92,
    Content: lazy(() => import('./Rally.tsx')),
  },
  {
    id: 'lagoon', title: 'Moonjelly Lagoon', views: ['Reef window', 'Drift current'], icon: 'bubbles', clock: true,
    Content: lazy(() => import('./Lagoon.tsx')),
  },
  {
    id: 'atrium', title: 'Atrium Promenade', views: ['Pool terrace', 'Glass gallery'], icon: clockIcon, clock: true,
    Content: lazy(() => import('./Atrium.tsx')),
  },
  {
    id: 'conservatory', title: 'Biodome Butterflies', views: ['Falls garden', 'Canopy walk'], icon: butterflyIcon, shadows: true, exposure: 0.92,
    Content: lazy(() => import('./Conservatory.tsx')),
  },
  {
    id: 'reef', title: 'Open Reef Drift', views: ['Coral garden', 'Turtle swim'], icon: fishIcon, exposure: 0.92,
    Content: lazy(() => import('./Reef.tsx')),
  },
  {
    id: 'sanctuary', title: 'Sanctuary Skyway', views: ['Canal flight', 'Glass gardens'], icon: skylineIcon, exposure: 0.88,
    Content: lazy(() => import('./Sanctuary.tsx')),
  },
  {
    id: 'falls', title: 'Rainbow Falls', views: ['Valley glide', 'Rainbow basin'], icon: 'landscape', exposure: 1,
    Content: lazy(() => import('./Falls.tsx')),
  },
  {
    id: 'mobile', title: 'Pendulum Pavilion', views: ['Gallery', 'Along the wave'], icon: 'gear', shadows: true, exposure: 0.95,
    Content: lazy(() => import('./Mobile.tsx')),
  },
];
