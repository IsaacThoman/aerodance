// An attempt's analysis over the stretch that was actually danced, and how the Studio says what
// the numbers mean: limbs, causes and timing in plain words, and the heat lane's colours.
import { INTERVAL_MS, JUDGEMENTS, MAX_SCORE, gradeFor } from '../../../../../../packages/score/scorer.ts';
import type { JudgementCounts, WindowJudgement } from '../../../../../../packages/score/scorer.ts';
import type { AttemptAnalysis, HeatCell, Trouble } from '../../../../../../packages/dance/playtest.ts';

export type Range = readonly [number, number];
/** An attempt must cover this much of the song to be kept. */
export const MIN_ATTEMPT_MS = 8000;
/** An attempt that earned this share of its points did well enough to say something about the routine. */
export const DECENT_ACCURACY = 0.6;

/**
 * The analysis narrowed to the stretch the player danced. The scorer scores the whole playable
 * song, so an attempt at one section would otherwise be drowned by everything it never tried:
 * the result here is worked out from the intervals between the first and last poses alone.
 */
export function coveredAnalysis(full: AttemptAnalysis, [first, last]: Range): AttemptAnalysis {
  const intervals = full.intervals.filter(i => i.songTimeMs >= first && i.songTimeMs <= last);
  // A judgement counts when its whole second was danced.
  const seconds = full.seconds.filter(s => s.songTimeMs - 1000 >= first - INTERVAL_MS && s.songTimeMs <= last + INTERVAL_MS);
  const tracked = intervals.filter(i => !i.lost), matched = intervals.filter(i => i.score >= JUDGEMENTS[1][1]);
  const accuracy = intervals.length ? intervals.reduce((n, i) => n + i.points, 0) / intervals.length : 0;
  const judgements: JudgementCounts = { perfect: 0, good: 0, ok: 0, miss: 0, lost: 0 };
  let combo = 0, maxCombo = 0;
  for (const s of seconds) {
    judgements[s.judgement]++;
    combo = s.judgement === 'miss' || s.judgement === 'lost' ? 0 : combo + 1;
    maxCombo = Math.max(maxCombo, combo);
  }
  const limbs = full.limbs.map((limb, l) => {
    const values = tracked.map(i => i.limbs[l]).filter((v): v is number => v !== null);
    return { id: limb.id, degrees: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null };
  });
  return {
    dancer: full.dancer, intervals, seconds, limbs,
    result: { ...full.result, score: Math.round(accuracy * MAX_SCORE), accuracy, runningAccuracy: accuracy, grade: gradeFor(accuracy), judgements, combo, maxCombo,
      coverage: intervals.length ? tracked.length / intervals.length : 0, meanOffsetMs: matched.length ? matched.reduce((n, i) => n + i.shiftMs, 0) / matched.length : 0,
      scoredIntervals: intervals.length, possibleIntervals: intervals.length },
  };
}

export const JUDGEMENT_WORDS: Record<WindowJudgement, string> = { perfect: 'Perfect', good: 'Good', ok: 'OK', miss: 'Miss', lost: 'Lost you' };
export const JUDGEMENT_ORDER: readonly WindowJudgement[] = ['perfect', 'good', 'ok', 'miss', 'lost'];
export const DIFFICULTY_WORDS = { easy: 'Easy', normal: 'Normal', hard: 'Hard' } as const;
export const percent = (share: number) => `${Math.round(share * 100)}%`;
/** "Left forearm" from the scorer's limb id ("left-forearm"). */
export const limbName = (id: string) => { const words = id.replaceAll('-', ' '); return words.charAt(0).toUpperCase() + words.slice(1); };
const roughMs = (ms: number) => Math.round(Math.abs(ms) / 5) * 5;
// The scorer's timing shift is where in the routine the player's pose matched best, relative to
// the moment they struck it: a player behind the beat matches an earlier moment, a negative shift.
const side = (shiftMs: number) => shiftMs < 0 ? 'late' : 'early';
/** "About 40 ms late on average", from the scorer's mean timing shift. */
export function timingWords(shiftMs: number): string {
  return roughMs(shiftMs) < 15 ? 'Right on the beat' : `About ${roughMs(shiftMs)} ms ${side(shiftMs)} on average`;
}

const BECAUSE = { tracking: 'the camera lost them', pose: 'the pose was off', timing: 'the timing was off' } as const;
/** A heat cell in a sentence: "Players earned 35% here, mostly because the camera lost them". */
export function cellWords(cell: HeatCell): string {
  const earned = `Players earned ${percent(cell.points)} here`;
  const cause = (['tracking', 'pose', 'timing'] as const).reduce((a, b) => cell.causes[b] > cell.causes[a] ? b : a);
  if (cell.points >= 0.9 || !cell.causes[cause]) return `${earned}.`;
  const detail = cause === 'pose' && cell.worstLimb ? ` (${limbName(cell.worstLimb).toLowerCase()} furthest out)`
    : cause === 'timing' && roughMs(cell.shiftMs) >= 15 ? ` (about ${roughMs(cell.shiftMs)} ms ${side(cell.shiftMs)})` : '';
  return `${earned}, mostly because ${BECAUSE[cause]}${detail}.`;
}
/** Why a stretch keeps losing points, as a sentence about the routine. */
export function troubleWords(trouble: Trouble): string {
  if (trouble.cause === 'tracking') return 'The camera loses players here: a move may hide the body or leave the picture.';
  const limb = trouble.worstLimb ? ` (furthest out: ${limbName(trouble.worstLimb).toLowerCase()})` : '';
  return trouble.cause === 'timing' ? `Players don't land this in time${limb}.` : `Players don't match the pose here${limb}.`;
}

const HEAT: readonly (readonly [number, number, number])[] = [[240, 82, 82], [255, 210, 74], [52, 211, 128]];
/** Red through yellow to green for 0 to 1 of the points. */
export function heatColor(points: number): string {
  const v = Math.max(0, Math.min(1, points)) * 2, i = Math.min(1, Math.floor(v)), k = v - i;
  return `rgb(${HEAT[i].map((c, n) => Math.round(c + (HEAT[i + 1][n] - c) * k)).join(' ')})`;
}
