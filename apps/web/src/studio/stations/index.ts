// The five stations of making a dance, in the order a new project meets them.
import { lazy } from 'react';
import type { ComponentType, LazyExoticComponent } from 'react';
import type { IconName } from '../core/ui.tsx';

export type StationId = 'song' | 'record' | 'fix' | 'playtest' | 'share';
export interface StationInfo { id: StationId; label: string; hint: string; icon: IconName; Component: LazyExoticComponent<ComponentType>; }
export const STATIONS: readonly StationInfo[] = [
  { id: 'song', label: 'Song', hint: 'The music, its beat and its sections', icon: 'music', Component: lazy(() => import('./song/SongStation.tsx')) },
  { id: 'record', label: 'Record', hint: 'Dance each section in front of your camera, or bring in a video', icon: 'record', Component: lazy(() => import('./record/RecordStation.tsx')) },
  { id: 'fix', label: 'Fix', hint: 'Go through what needs a look, and touch up poses', icon: 'sparkle', Component: lazy(() => import('./fix/FixStation.tsx')) },
  { id: 'playtest', label: 'Playtest', hint: 'Dance it yourself and see where the points go', icon: 'game', Component: lazy(() => import('./playtest/PlaytestStation.tsx')) },
  { id: 'share', label: 'Share', hint: 'Add it to the game, send it to a TV, or save the file', icon: 'send', Component: lazy(() => import('./share/ShareStation.tsx')) },
];
export const isStationId = (v: unknown): v is StationId => STATIONS.some(s => s.id === v);
