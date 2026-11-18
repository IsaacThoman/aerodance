// A stand-in performer for development and tests: a keyed routine sampled as if a camera had
// tracked it, so stations can be tried without dancing. In development the page exposes it as
// window.studio.demo(): it records a take of the whole song for a dancer and places it.
import { createEvaluator } from '../../../../../packages/dance/evaluate.ts';
import { newDance } from '../../../../../packages/dance/format.ts';
import { applyOps } from '../../../../../packages/dance/ops.ts';
import type { TrackedFrame } from '../../../../../packages/dance/takes.ts';
import type { ProjectSession } from './session.ts';

const POSES: Record<string, [number, number]>[] = [
  { leftWrist: [0.62, 0.3], rightWrist: [0.38, 0.3], leftElbow: [0.59, 0.42], rightElbow: [0.41, 0.42] },
  { leftWrist: [0.66, 0.46], rightWrist: [0.44, 0.62], leftElbow: [0.6, 0.47], rightElbow: [0.43, 0.52], leftAnkle: [0.58, 0.84] },
  { leftWrist: [0.56, 0.62], rightWrist: [0.34, 0.46], leftElbow: [0.57, 0.52], rightElbow: [0.4, 0.47], rightAnkle: [0.42, 0.84] },
  { leftWrist: [0.6, 0.2], rightWrist: [0.36, 0.56], leftElbow: [0.58, 0.34], rightElbow: [0.4, 0.5] },
];
export interface DemoOptions {
  /** Camera picture size (default 640×480, as a webcam's). */
  width?: number; height?: number; fps?: number;
  /** A stretch where the camera "lost" the performer, and one where it was unsure of the left arm (song ms). */
  lost?: readonly [number, number] | null; unsure?: readonly [number, number] | null;
  /** Moves every pose this much later, as a performer dancing behind the beat would be. */
  lateMs?: number;
  /** A different routine per seed. */
  seed?: number;
}
/** A performer's tracked poses over [fromMs, toMs] of a song at `bpm`: a pose every two beats, with a sway between. */
export function demoFrames(fromMs: number, toMs: number, bpm: number, beatOffsetMs: number,
  { width = 640, height = 480, fps = 30, lost = null, unsure = null, lateMs = 0, seed = 0 }: DemoOptions = {}): { frames: TrackedFrame[]; width: number; height: number } {
  const beat = 60000 / bpm, source = newDance({ dancers: 1, frame: { width, height }, durationMs: Math.max(toMs + 1000, 2000) });
  const ops: unknown[] = [{ op: 'pose', dancer: 'P1', t: 0, from: 'neutral' }];
  for (let n = 0, t = beatOffsetMs; t <= toMs + beat * 2; n++, t = beatOffsetMs + n * beat * 2) {
    if (t < 0) continue;
    ops.push({ op: 'key', dancer: 'P1', t: Math.round(t), set: { ...POSES[(n + seed) % POSES.length], turn: n % 2 ? 14 : -14, headRoll: n % 2 ? 8 : -8 }, ease: 'stop' });
    // Hold each pose half a beat, as dancers do, then move to the next.
    ops.push({ op: 'pose', dancer: 'P1', t: Math.round(t + beat * 0.5), from: { t: Math.round(t) } });
  }
  const dance = applyOps(source, ops).dance, evaluator = createEvaluator(dance, dance.dancers[0]);
  const frames: TrackedFrame[] = [], LEFT_ARM = [13, 15, 17, 19, 21];
  let noise = 12345 + seed;
  const jitter = () => { noise = (noise * 1664525 + 1013904223) >>> 0; return (noise / 2 ** 32 - 0.5) * 0.004; };
  for (let t = fromMs; t <= toMs; t += 1000 / fps) {
    const time = Math.round(t * 10) / 10;
    const gone = lost && time >= lost[0] && time <= lost[1], shaky = unsure && time >= unsure[0] && time <= unsure[1];
    frames.push({ videoMs: time, poses: [gone ? null : evaluator.landmarks(Math.max(0, time - lateMs)).map((l, j) =>
      ({ x: l.x + jitter(), y: l.y + jitter(), z: l.z, confidence: shaky && LEFT_ARM.includes(j) ? 0.25 : 0.93 }))] });
  }
  return { frames, width, height };
}
/** Records the demo performer over the whole playable song as a take and places it on a dancer. */
export async function addDemoTake(session: ProjectSession, dancer = 0, options: DemoOptions = {}): Promise<boolean> {
  const { song, dancers } = session.state.dance, start = song.playableStartMs, end = song.playableEndMs;
  const quarter = (end - start) / 4;
  const { frames, width, height } = demoFrames(start, end, song.bpm ?? 120, song.beatOffsetMs, {
    lost: [start + quarter * 2, start + quarter * 2 + 1200], unsure: [start + quarter, start + quarter + 1500], seed: dancer, ...options });
  const take = await session.addTake(frames, { width, height, slots: 1 }, { label: `Demo take ${session.state.dance.sources.takes.length + 1}`, origin: 'import', clock: 'song', fps: options.fps ?? 30 });
  if (!take) return false;
  return (await session.apply([{ op: 'clip', dancer: dancers[dancer].id, take: take.id }], 'place the demo take')) !== null;
}
