// The tracker stage for any estimator: detections.jsonl → the game's PlayerTracker (and setup) → tracked.jsonl.
//   node tools/trackbench/harness/track.ts <estimator-id> <scene-id> [--no-session] [--no-looks]
// With two or more players the tracker uses looks; detections without them get them from the
// frames with the game's appearance.ts, sampled from a 128-pixel-wide copy drawn in Chromium as
// the worker draws it (looks.ts).
import path from 'node:path';
import { describeLooks } from '../../../packages/pose/browser/appearance.ts';
import { danceWindow, loadScene, mean, parseArgs, readJsonl, runDir, writeJson, writeJsonl } from './common.ts';
import type { DetFrame, Scene, TrackedFrame } from './common.ts';
import { GameLoop, toDetected } from './gameloop.ts';
import type { Pixels } from '../../../packages/pose/browser/appearance.ts';

export interface TrackOptions {
  session?: boolean;
  /** Per frame, the 128-wide picture the looks are sampled from (when detections have none). */
  pixels?: Map<number, Pixels> | null;
  /** At most this many people per result (capPeople). */
  cap?: number;
}

/** Looks the game's worker would give these detections, from the frame's 128-wide copy. */
export const looksOf = (pixels: Pixels, line: DetFrame) => line.people.map(p => describeLooks(pixels, toDetected(p.kp)));

/** Every detection line through the game's loop in time order. */
/**
 * At most `cap` people per result, the most confident first: the game asks MediaPipe for exactly
 * the players' number of people (or one per strip), so a candidate that reports everyone it sees
 * is cut to that many too. (Without it, a poster or reflection becomes somebody's player.)
 */
export function capPeople(line: DetFrame, cap: number): DetFrame {
  if (line.people.length <= cap) return line;
  const order = line.people.map((p, i) => ({ i, s: p.score ?? mean(p.kp.flatMap(j => j && j[3] !== null ? [j[3]] : [])) ?? 0 })).sort((a, b) => b.s - a.s).slice(0, cap).map(o => o.i).sort((a, b) => a - b);
  return { ...line, people: order.map(i => line.people[i]), ...(line.looks ? { looks: order.map(i => line.looks![i]) } : {}) };
}

export function trackDetections(scene: Scene, dets: readonly DetFrame[], { session = true, pixels = null, cap = Infinity }: TrackOptions = {}): TrackedFrame[] {
  const loop = new GameLoop(scene.players, { width: scene.width, height: scene.height }, { session, danceStartMs: danceWindow(scene)?.[0] ?? Infinity });
  const lines = [...dets].sort((a, b) => (a.received_ms ?? a.t_ms) - (b.received_ms ?? b.t_ms)).map(l => capPeople(l, cap));
  return lines.map(line => {
    let looks = line.looks;
    if (!looks && scene.players > 1 && pixels) {
      const px = pixels.get(line.frame);
      if (px) looks = looksOf(px, line);
    }
    return loop.replay(line, looks);
  });
}

if (import.meta.main) {
  const { positional: [estimator, sceneId], opts } = parseArgs(process.argv.slice(2), { 'no-session': 'bool', 'no-looks': 'bool', 'no-cap': 'bool' });
  if (!estimator || !sceneId) { console.error('usage: node tools/trackbench/harness/track.ts <estimator-id> <scene-id> [--no-session] [--no-looks]'); process.exit(2); }
  const scene = loadScene(sceneId);
  const dir = runDir(estimator, sceneId);
  const dets = readJsonl<DetFrame>(path.join(dir, 'detections.jsonl'));
  let pixels: Map<number, Pixels> | null = null;
  const needLooks = scene.players > 1 && !opts['no-looks'] && dets.some(d => !d.looks && d.people.length);
  if (needLooks) {
    const { framePixels } = await import('./looks.ts');
    pixels = await framePixels(scene);
  }
  // The game's own worker already asks for the players' number; anything else is cut to it.
  const cap = opts['no-cap'] || /-game(-|$)/.test(estimator) ? Infinity : scene.players;
  const tracked = trackDetections(scene, dets, { session: !opts['no-session'], pixels, cap });
  writeJsonl(path.join(dir, 'tracked.jsonl'), tracked);
  writeJson(path.join(dir, 'track.json'), { estimator, scene: sceneId, session: !opts['no-session'], cap: Number.isFinite(cap) ? cap : null, looks: scene.players > 1 ? (needLooks ? 'appearance.ts on 128-wide Chromium copies' : opts['no-looks'] ? 'none' : 'from detections') : 'not used (one player)', at: new Date().toISOString() });
  console.log(`${estimator}/${sceneId}: ${tracked.length} records, ${tracked.filter(r => r.poses.length === scene.players).length} with every player`);
}
