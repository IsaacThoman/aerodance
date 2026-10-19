import type { AeroPart, AeroQuality } from './aero/aeroBackground.ts';

/*
 * The game's graphics settings, from the page's URL or the host app.
 *
 * ?quality=tv (or a host that sets globalThis.__aerodanceQuality = 'tv' before the game loads,
 * like the Apple TV app) picks the tier for weak devices: a cheaper Aero world, no MSAA and a
 * lighter stage pipeline. 'high' and 'low' force the Aero world's own tiers; by default it
 * picks for itself.
 *
 * Diagnostics, for measuring what things cost: ?aeroHide=clouds,birds leaves parts of the Aero
 * world out (see AeroPart), and ?diag=nodancers,nobloom,nostageshadows switches off the menu
 * dancers, the stages' bloom and the stages' shadows.
 */
const params = typeof location === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.search);
const host = globalThis as { __aerodanceQuality?: string };
const asked = params.get('quality') ?? host.__aerodanceQuality;

export const quality: AeroQuality = asked === 'tv' || asked === 'high' || asked === 'low' ? asked : 'auto';
export const tv = quality === 'tv';
export const aeroHide = (params.get('aeroHide')?.split(',') ?? []) as AeroPart[];
const diag = new Set(params.get('diag')?.split(',') ?? []);
export const diagnostic = (name: 'nodancers' | 'nobloom' | 'nostageshadows') => diag.has(name);
