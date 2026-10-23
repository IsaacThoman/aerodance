import type { AeroPart } from './aero/aeroBackground.ts';

/*
 * Diagnostics from the page's URL, for measuring what things cost: ?aeroHide=clouds,birds leaves
 * parts of the Aero world out (see AeroPart), and ?diag=nodancers,nobloom,nostageshadows switches
 * off the menu dancers, the stages' bloom and the stages' shadows. ?diag=stats shows the full
 * stats overlay (stats/StatsOverlay.tsx) whatever Settings → Graphics → Stats says. ?diag=noui
 * leaves the in-engine UI out of the picture (the overlays and the mirror's dancers) while it
 * still takes input, for recording the world and dancers alone, like the README's banner.
 */
const params = typeof location === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.search);

export const aeroHide = (params.get('aeroHide')?.split(',') ?? []) as AeroPart[];
const diag = new Set(params.get('diag')?.split(',') ?? []);
export const diagnostic = (name: 'nodancers' | 'nobloom' | 'nostageshadows' | 'stats' | 'noui') => diag.has(name);
