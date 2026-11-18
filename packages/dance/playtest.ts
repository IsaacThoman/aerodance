// Playtests: someone dancing the routine through the game's scorer, and where their points went.
//
// An attempt is the player's tracked poses stamped in song time (a take on the song's clock).
// analyzeAttempt replays it through packages/score exactly as the game scores it, and explains
// each 100 ms interval: was the player tracked, how far each limb pointed from the coach's, and
// how early or late the best match was. heatmap() folds attempts into per-second cells for the
// timeline; trouble() finds the stretches several good attempts all lost points on.
import { INTERVAL_MS, createScorer, pointsShare } from '../score/scorer.ts';
import type { JudgementEvent, PlayerResult } from '../score/scorer.ts';
import { LIMBS, angleBetween, limbDirections, liveUsable } from '../score/features.ts';
import type { LimbDirections } from '../score/features.ts';
import { sampleDancers } from '../pose/song.ts';
import type { SongBundle } from '../pose/song.ts';
import type { Landmark } from '../pose/choreography.ts';

export interface AttemptSample { songTimeMs: number; landmarks: readonly Landmark[]; }
/** Why an interval lost points, the largest cause first: not tracked, the pose, or the timing. */
export type Cause = 'tracking' | 'pose' | 'timing' | null;
export interface AttemptInterval {
  songTimeMs: number;
  /** 0 to 1, as scored, and the share of the interval's points it earned. */
  score: number; points: number;
  /** The share of the coach's limbs the tracker saw; `lost` when too few to score. */
  live: number; lost: boolean;
  /** The timing shift that matched best: negative when the player was late (they matched what the coach did earlier). */
  shiftMs: number;
  /** Degrees between each limb (packages/score LIMBS order) and the coach's, or null where either is missing. */
  limbs: (number | null)[];
  cause: Cause;
}
export interface AttemptAnalysis {
  dancer: number;
  result: PlayerResult;
  intervals: AttemptInterval[];
  /** One judgement per second. */
  seconds: { songTimeMs: number; judgement: JudgementEvent['judgement']; score: number }[];
  /** Mean degrees off per limb over the tracked intervals. */
  limbs: { id: string; degrees: number | null }[];
}
const DEG = 180 / Math.PI;
/** A limb more than this far off is "the pose", not noise. */
const POSE_OFF_DEG = 35;

/** The player's limb directions nearest a song time (within reachMs), or null. */
function liveNear(samples: readonly { t: number; dirs: LimbDirections }[], t: number, reachMs = 120): LimbDirections | null {
  let lo = 0, hi = samples.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (samples[mid].t <= t) lo = mid + 1; else hi = mid; }
  const near = [samples[lo - 1], samples[lo]].filter(s => s && Math.abs(s.t - t) <= reachMs).sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0];
  return near ? near.dirs : null;
}

/** Scores one player's attempt at `dancer` (a track index) and explains every interval. */
export function analyzeAttempt(bundle: SongBundle, dancer: number, attempt: readonly AttemptSample[], aspect: number): AttemptAnalysis {
  const scorer = createScorer(bundle, 1, [dancer]);
  const seconds: AttemptAnalysis['seconds'] = [];
  scorer.onJudgement(e => { seconds.push({ songTimeMs: e.songTimeMs, judgement: e.judgement, score: e.score }); });
  const track = bundle.choreography.tracks[dancer].calibration, refAspect = track.inputWidth / track.inputHeight;
  const sorted = [...attempt].sort((a, b) => a.songTimeMs - b.songTimeMs);
  const live = sorted.map(s => ({ t: s.songTimeMs, dirs: limbDirections(s.landmarks, aspect, liveUsable(s.landmarks)) }));
  const intervals: AttemptInterval[] = [];
  scorer.onInterval(e => {
    const snapshot = sampleDancers(bundle, e.songTimeMs + e.shiftMs);
    const pose = snapshot.poses.find(p => p.playerId === dancer), quality = snapshot.quality.find(q => q.playerId === dancer);
    const ref = pose && quality ? limbDirections(pose.landmarks, refAspect, quality.scoreEligible) : null;
    const mine = liveNear(live, e.songTimeMs);
    const limbs = LIMBS.map((_, i) => ref?.[i] && mine?.[i] ? angleBetween(mine[i]!, ref[i]!) * DEG : null);
    const points = pointsShare(e.score);
    let cause: Cause = null;
    if (points < 0.999) {
      const worst = Math.max(0, ...limbs.map(v => v ?? 0));
      cause = e.lost || e.live < 0.6 ? 'tracking' : worst >= POSE_OFF_DEG ? 'pose' : Math.abs(e.shiftMs) >= 100 ? 'timing' : 'pose';
    }
    intervals.push({ songTimeMs: e.songTimeMs, score: e.score, points, live: e.live, lost: e.lost, shiftMs: e.shiftMs, limbs, cause });
  });
  for (const s of sorted) scorer.addSample(0, s.songTimeMs, s.landmarks, aspect);
  scorer.finish();
  const tracked = intervals.filter(i => !i.lost);
  const limbs = LIMBS.map((limb, i) => {
    const values = tracked.map(t => t.limbs[i]).filter((v): v is number => v !== null);
    return { id: limb.id, degrees: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null };
  });
  return { dancer, result: scorer.result(0), intervals, seconds, limbs };
}

export interface HeatCell {
  startMs: number; endMs: number;
  /** Attempts that covered the cell, and the mean share of points they earned (0 to 1). */
  attempts: number; points: number;
  /** The share of lost points by cause, and the limb that was furthest off on average. */
  causes: Record<'tracking' | 'pose' | 'timing', number>;
  worstLimb: string | null; worstDegrees: number;
  /** Mean timing shift of the intervals that matched (negative: players were late). */
  shiftMs: number;
}
/** Attempts folded into cells of `cellMs` (default one second) over a song range. */
export function heatmap(analyses: readonly AttemptAnalysis[], startMs: number, endMs: number, cellMs = 1000): HeatCell[] {
  const count = Math.max(0, Math.ceil((endMs - startMs) / cellMs));
  const cells = Array.from({ length: count }, (_, i) => ({ startMs: startMs + i * cellMs, endMs: Math.min(endMs, startMs + (i + 1) * cellMs),
    n: 0, points: 0, lost: { tracking: 0, pose: 0, timing: 0 }, limb: LIMBS.map(() => ({ sum: 0, n: 0 })), shift: 0, shifts: 0, who: new Set<number>() }));
  analyses.forEach((a, index) => {
    for (const i of a.intervals) {
      const cell = cells[Math.floor((i.songTimeMs - startMs) / cellMs)];
      if (!cell) continue;
      cell.n++; cell.points += i.points; cell.who.add(index);
      if (i.cause) cell.lost[i.cause] += 1 - i.points;
      if (!i.lost) { cell.shift += i.shiftMs; cell.shifts++; i.limbs.forEach((v, l) => { if (v !== null) { cell.limb[l].sum += v; cell.limb[l].n++; } }); }
    }
  });
  return cells.map((c): HeatCell => {
    const total = c.lost.tracking + c.lost.pose + c.lost.timing;
    let worst = -1, worstDegrees = 0;
    c.limb.forEach((l, i) => { const mean = l.n ? l.sum / l.n : 0; if (mean > worstDegrees) { worstDegrees = mean; worst = i; } });
    return { startMs: c.startMs, endMs: c.endMs, attempts: c.who.size, points: c.n ? c.points / c.n : 0,
      causes: { tracking: total ? c.lost.tracking / total : 0, pose: total ? c.lost.pose / total : 0, timing: total ? c.lost.timing / total : 0 },
      worstLimb: worst >= 0 ? LIMBS[worst].id : null, worstDegrees, shiftMs: c.shifts ? c.shift / c.shifts : 0 };
  });
}
export interface Trouble { startMs: number; endMs: number; points: number; cause: 'tracking' | 'pose' | 'timing'; worstLimb: string | null; attempts: number; }
/**
 * Stretches the routine itself seems to lose players points on: cells where attempts that did
 * well overall (at least `goodAccuracy`) still earned under `threshold` of the points, joined
 * when adjacent. One attempt is an anecdote; `minAttempts` good ones are a pattern.
 */
export function trouble(analyses: readonly AttemptAnalysis[], startMs: number, endMs: number,
  { threshold = 0.45, goodAccuracy = 0.6, minAttempts = 2, minMs = 1500 }: { threshold?: number; goodAccuracy?: number; minAttempts?: number; minMs?: number } = {}): Trouble[] {
  const good = analyses.filter(a => a.result.accuracy >= goodAccuracy);
  if (good.length < minAttempts) return [];
  const cells = heatmap(good, startMs, endMs), out: Trouble[] = [];
  let run: HeatCell[] = [];
  const close = () => {
    if (run.length && run[run.length - 1].endMs - run[0].startMs >= minMs) {
      const sum = (f: (c: HeatCell) => number) => run.reduce((n, c) => n + f(c), 0) / run.length;
      const causes = (['tracking', 'pose', 'timing'] as const).map(k => [k, sum(c => c.causes[k])] as const).sort((a, b) => b[1] - a[1]);
      const worst = [...run].sort((a, b) => b.worstDegrees - a.worstDegrees)[0];
      out.push({ startMs: run[0].startMs, endMs: run[run.length - 1].endMs, points: sum(c => c.points), cause: causes[0][0], worstLimb: worst.worstLimb, attempts: good.length });
    }
    run = [];
  };
  for (const c of cells) { if (c.attempts >= minAttempts && c.points < threshold) run.push(c); else close(); }
  close();
  return out;
}
/** A difficulty read from how well-meaning attempts scored: the mean accuracy of all attempts. */
export function measuredDifficulty(analyses: readonly AttemptAnalysis[]): 'easy' | 'normal' | 'hard' | null {
  if (!analyses.length) return null;
  const mean = analyses.reduce((n, a) => n + a.result.accuracy, 0) / analyses.length;
  return mean >= 0.8 ? 'easy' : mean >= 0.6 ? 'normal' : 'hard';
}
export { INTERVAL_MS };
