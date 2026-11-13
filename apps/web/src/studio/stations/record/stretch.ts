// The stretch of the song being recorded, in words ("Part A · bars 1–8"), and how takes and
// repeats line up with it.
import type { Dance, Dancer, TakeSource } from '../../../../../../packages/dance/format.ts';
import type { TakeData, TrackedFrame } from '../../../../../../packages/dance/takes.ts';
import { videoToSong } from '../../../../../../packages/dance/time.ts';
import { barMs, beatMs, clock } from '../../core/format.ts';

export type Range = readonly [number, number];
/**
 * A part reaches this far past each end of its stretch, over which it blends with the parts
 * either side: a new part fades in over the last moment of the one before, and out over the
 * first moment of the one after (the `clip` op trims what it overlaps to just that), instead of
 * both easing to the dancer standing still where they meet. It is the op's own fade length.
 */
export const HANDLE_MS = 150;
export interface Stretch {
  /** Song ms. */
  range: Range;
  /** Nothing is selected: all of what players dance. */
  whole: boolean;
  /** What to call it: the section's name, or failing that where it is. */
  name: string;
  /** Where a named section is ("bars 1–8"); empty when the name already says. */
  where: string;
}

/** "bars 1–8" for a stretch that runs from bar line to bar line, else its times. */
export function whereLabel(dance: Pick<Dance, 'song'>, [a, b]: Range): string {
  const bar = barMs(dance);
  if (bar) {
    const { beatOffsetMs, durationMs } = dance.song, first = (a - beatOffsetMs) / bar, last = (b - beatOffsetMs) / bar;
    // On a bar line to within half a beat. The song's own start and end count as bar lines too.
    const near = (v: number) => Math.abs(v - Math.round(v)) < 0.13;
    if ((near(first) || a < beatOffsetMs) && (near(last) || b > durationMs - 1)) {
      const from = Math.max(1, Math.round(first) + 1), to = Math.max(from, near(last) ? Math.round(last) : Math.ceil(last));
      return from === to ? `bar ${from}` : `bars ${from}–${to}`;
    }
  }
  return `${clock(a)}–${clock(b)}`;
}
/** The selected stretch, or the whole of what players dance. */
export function stretchOf(dance: Dance, selection: Range | null): Stretch {
  if (!selection) return { range: [dance.song.playableStartMs, dance.song.playableEndMs], whole: true, name: 'Whole song', where: '' };
  // A section, or a part of the dance picked in the timeline that was placed over one (parts overhang their sections a little).
  const section = dance.phrases.find(p => Math.abs(p.startMs - selection[0]) <= HANDLE_MS + 1 && Math.abs(p.endMs - selection[1]) <= HANDLE_MS + 1);
  const range: Range = section ? [section.startMs, section.endMs] : selection, where = whereLabel(dance, range);
  return { range, whole: false, name: section?.label ?? where.charAt(0).toUpperCase() + where.slice(1), where: section ? where : '' };
}
export const overlap = (a: Range, b: Range) => Math.min(a[1], b[1]) - Math.max(a[0], b[0]);
/** Where a take sits in the song. */
export const takeSpan = (dance: Pick<Dance, 'sources'>, take: TakeSource): Range =>
  take.clock === 'video' ? [videoToSong(dance, take.startMs), videoToSong(dance, take.endMs)] : [take.startMs, take.endMs];
/** Where a take goes when it's used: all of it, or the part of it inside a stretch and the moment either side. */
export function placement(dance: Pick<Dance, 'sources'>, take: TakeSource, within: Range | null): Range {
  const [a, b] = takeSpan(dance, take);
  return within ? [Math.max(a, within[0] - HANDLE_MS), Math.min(b, within[1] + HANDLE_MS)] : [a, b];
}
/**
 * A capture with its first and last poses held a moment beyond the stretch it was danced for
 * (where it reaches the stretch's ends, and the song goes on), for the take to blend with its
 * neighbours over. Every whole take of a stretch then covers exactly the same span.
 */
export function withHandles(frames: readonly TrackedFrame[], range: Range, songMs: number): TrackedFrame[] {
  const first = frames[0], last = frames[frames.length - 1], head: TrackedFrame[] = [], tail: TrackedFrame[] = [];
  if (first.videoMs - range[0] < 120) for (let t = Math.max(0, range[0] - HANDLE_MS); t < first.videoMs - 10; t += 50) head.push({ videoMs: t, poses: first.poses });
  if (range[1] - last.videoMs < 120) for (let t = Math.min(songMs, range[1] + HANDLE_MS); t > last.videoMs + 10; t -= 50) tail.unshift({ videoMs: t, poses: last.poses });
  return [...head, ...frames, ...tail];
}
/** The share of a take's frames in which its people were tracked. */
export function trackedShare(data: TakeData): number {
  const { present, times } = data.frames;
  let seen = 0;
  for (let i = 0; i < times.length; i++) for (let s = 0; s < data.slots; s++) if (present[i] & (1 << s)) seen++;
  return times.length ? seen / (times.length * data.slots) : 0;
}
/** Whether a dancer has any motion placed inside a stretch of the song. */
export const hasMotion = (dancer: Dancer, range: Range) =>
  dancer.clips.some(c => overlap([c.startMs + dancer.timeOffsetMs, c.endMs + dancer.timeOffsetMs], range) > HANDLE_MS * 2);
/**
 * Where to start copying from so a repeat lands in time: `source` moved by under half a bar to
 * sit on the bar as `target` does (a section that opens the song starts a pickup before its
 * first bar line; the same section later starts on one).
 */
export function alignedStart(dance: Pick<Dance, 'song'>, source: number, target: number): number {
  const bar = barMs(dance);
  if (!bar) return source;
  const phase = (t: number) => (((t - dance.song.beatOffsetMs) % bar) + bar) % bar;
  let shift = phase(target) - phase(source);
  if (shift > bar / 2) shift -= bar; else if (shift < -bar / 2) shift += bar;
  return Math.round((source + shift) * 10) / 10;
}
/** The first beat at or after a time: where a count-in lands (the time itself without a tempo). */
export function beatAtOrAfter(dance: Pick<Dance, 'song'>, ms: number): number {
  const beat = beatMs(dance);
  // Section starts are whole milliseconds, so a start on a beat can sit a fraction of one past it.
  return beat ? dance.song.beatOffsetMs + Math.ceil((ms - dance.song.beatOffsetMs - 1) / beat) * beat : ms;
}
