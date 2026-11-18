// How the Studio writes times and sizes.
import type { Dance } from '../../../../../packages/dance/format.ts';

/** "1:02.5" */
export function clock(ms: number, tenths = true): string {
  const sign = ms < 0 ? '-' : '', t = Math.abs(ms), m = Math.floor(t / 60000), s = (t % 60000) / 1000;
  return `${sign}${m}:${tenths ? s.toFixed(1).padStart(4, '0') : String(Math.floor(s)).padStart(2, '0')}`;
}
export const beatMs = (dance: Pick<Dance, 'song'>) => dance.song.bpm ? 60000 / dance.song.bpm : null;
export const barMs = (dance: Pick<Dance, 'song'>) => dance.song.bpm ? 240000 / dance.song.bpm : null;
/** "12.3": bar 12, beat 3 (bars of four beats from the song's first downbeat), or null without a tempo or before that downbeat. */
export function barBeat(dance: Pick<Dance, 'song'>, ms: number): string | null {
  const beat = beatMs(dance);
  if (!beat) return null;
  const n = Math.floor((ms - dance.song.beatOffsetMs) / beat + 1e-6);
  // Before the first downbeat there is no bar yet (a pickup).
  if (n < 0) return null;
  return `${Math.floor(n / 4) + 1}.${n % 4 + 1}`;
}
/** The nearest point of the beat grid (`division` parts per beat), or the time itself without a tempo. */
export function snapToGrid(dance: Pick<Dance, 'song'>, ms: number, division = 1): number {
  const beat = beatMs(dance);
  if (!beat) return Math.round(ms);
  const step = beat / division;
  return Math.round((dance.song.beatOffsetMs + Math.round((ms - dance.song.beatOffsetMs) / step) * step) * 10) / 10;
}
/** The bar line at or before a time (or the time itself without a tempo). */
export function barStart(dance: Pick<Dance, 'song'>, ms: number): number {
  const bar = barMs(dance);
  return bar ? dance.song.beatOffsetMs + Math.floor((ms - dance.song.beatOffsetMs) / bar + 1e-6) * bar : ms;
}
export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024, u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[u]}`;
}
/** "3 minutes ago", "yesterday", or a date. */
export function ago(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const minutes = Math.round((now - then) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} h ago`;
  if (minutes < 60 * 48) return 'yesterday';
  return new Date(then).toLocaleDateString();
}
/** Each dancer's colour, as the game dresses them (P1 blue, P2 purple, P3 green, P4 pink). */
export const DANCER_COLORS = ['#078fff', '#b86bff', '#1fcf72', '#ff5fb4'] as const;
