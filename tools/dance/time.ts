// Times in ops and on the command line: milliseconds, or a readable form.
//
//   4200, "4200ms", "4.2s", "1:02.5" (minutes:seconds), "b17" (beat 17, from 1 at beatOffsetMs;
//   fractions like "b17.5" are allowed, and need the song's bpm)
import type { Dance } from './format.ts';

export type TimeRef = number | string;

/** Beat n (from 1) of the song's grid, in ms. */
export function beatTime(dance: Pick<Dance, 'song'>, beat: number): number {
  const { bpm, beatOffsetMs } = dance.song;
  if (!bpm) throw Error('Beat times need the song bpm: set it with {"op":"song","set":{"bpm":120,"beatOffsetMs":0}}');
  return beatOffsetMs + (beat - 1) * 60000 / bpm;
}
/** The beat number (from 1, fractional) at a time, or null without a bpm. */
export function beatAt(dance: Pick<Dance, 'song'>, ms: number): number | null {
  const { bpm, beatOffsetMs } = dance.song;
  return bpm ? (ms - beatOffsetMs) * bpm / 60000 + 1 : null;
}
export function parseTime(ref: unknown, dance?: Pick<Dance, 'song'>): number {
  if (typeof ref === 'number' && Number.isFinite(ref)) return ref;
  if (typeof ref !== 'string') throw Error(`Expected a time, got ${JSON.stringify(ref)}`);
  const s = ref.trim();
  let m: RegExpExecArray | null;
  if ((m = /^(-?\d+(?:\.\d+)?)\s*ms$/.exec(s)) || (m = /^(-?\d+(?:\.\d+)?)$/.exec(s))) return Number(m[1]);
  if ((m = /^(-?\d+(?:\.\d+)?)\s*s$/.exec(s))) return Number(m[1]) * 1000;
  if ((m = /^(\d+):(\d+(?:\.\d+)?)$/.exec(s))) return (Number(m[1]) * 60 + Number(m[2])) * 1000;
  if ((m = /^b(?:eat)?\s*(\d+(?:\.\d+)?)$/i.exec(s))) {
    if (!dance) throw Error(`Beat time ${s} needs a dance`);
    return beatTime(dance, Number(m[1]));
  }
  throw Error(`Can't read time ${JSON.stringify(ref)}; use ms (4200), seconds (4.2s), m:ss (1:02.5) or a beat (b17)`);
}
/** A range "a:b" or [a, b]; either end may use any time form. */
export function parseRange(ref: unknown, dance?: Pick<Dance, 'song'>): [number, number] {
  let parts: unknown[];
  if (Array.isArray(ref)) parts = ref;
  else if (typeof ref === 'string' && ref.includes('..')) parts = ref.split('..');
  else if (typeof ref === 'string') {
    // "a:b", but "1:02.5:1:04" has minute forms: split on the colon that leaves two valid times.
    const colons = [...ref.matchAll(/:/g)].map(m => m.index);
    const split = colons.map(i => [ref.slice(0, i), ref.slice(i + 1)]).find(([a, b]) => {
      try { parseTime(a, dance); parseTime(b, dance); return true; } catch { return false; }
    });
    parts = split ?? [ref];
  } else parts = [ref];
  if (parts.length !== 2) throw Error(`Expected a range start:end (e.g. 4000:6000 or 4s:6s), got ${JSON.stringify(ref)}`);
  const [a, b] = parts.map(p => parseTime(p, dance));
  if (!(b > a)) throw Error(`A range must end after it starts: ${JSON.stringify(ref)}`);
  return [a, b];
}
/** "4.200s" for messages; with a bpm, the beat too. */
export function formatTime(ms: number, dance?: Pick<Dance, 'song'>): string {
  const beat = dance ? beatAt(dance, ms) : null;
  return `${(ms / 1000).toFixed(3)}s${beat === null ? '' : ` (b${Math.round(beat * 100) / 100})`}`;
}
/** A song time on the video's clock, and back. */
export function songToVideo(dance: Pick<Dance, 'sources'>, songMs: number): number {
  const v = dance.sources.video;
  return v ? (songMs - v.startMs) * v.rate : songMs;
}
export function videoToSong(dance: Pick<Dance, 'sources'>, videoMs: number): number {
  const v = dance.sources.video;
  return v ? videoMs / v.rate + v.startMs : videoMs;
}
