// How quickly and how reliably does setup calibrate, and would other rules do better?
// Replays each estimator's detections through the game's loop (tracker, line-up retry) with
// calibration rules swapped in, and measures, per scene with a shared hold:
//   - when calibration completes, relative to when every player is actually holding still (GT);
//   - completions that are wrong: before everyone holds (someone still walking/dancing), or in
//     scenes built so that it must not complete (a player's ankles out of view);
//   - how good the calibration it produced is (torso length and floor vs the same rule on GT poses).
//
//   node tools/trackbench/studies/calibration.ts [--estimators a,b] [--scenes p1,p2] [--out file] [--jobs n]
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { calibratePoses } from '../../../packages/character/calibration.ts';
import type { FrameSize, Landmark, PlayerCount, Pose, TrackCalibration } from '../../../packages/pose/choreography.ts';
import { WebcamCalibration as DevCalibration } from './devCalibration.ts';
import { WebcamCalibration } from '../../../apps/web/src/game/webcamCalibration.ts';
import type { CalibrationRecord } from '../../../apps/web/src/game/webcamCalibration.ts';
import type { Pixels } from '../../../packages/pose/browser/appearance.ts';
import { DATA, danceWindow, loadScene, parseArgs, readJsonl, runDir, writeJson } from '../harness/common.ts';
import type { DetFrame, GtFrame, Scene } from '../harness/common.ts';
import { GameLoop } from '../harness/gameloop.ts';
import { jobsOption, scenePool } from '../harness/pool.ts';
import { looksOf } from '../harness/track.ts';

/** Ablations of the shared-hold rule before this branch (dev at 61414651). */
interface Rule {
  stillMs: number; gapMs: number; missMs: number; tolerance: number;
  wrists: boolean;
  /** Compare a median of the last `filter` poses (1 = the pose itself) with the anchor. */
  filter: number;
  /** Each player holds on their own; done when every player has. */
  perPlayer: boolean;
  /** Joints a player needs in view, at confidence >= .5, to hold. */
  needs: number[];
}
const BODY = [11, 12, 23, 24, 27, 28];
const NO_ANKLES = [11, 12, 23, 24];
const SHARED_HOLD_DEV: Rule = { stillMs: 2500, gapMs: 400, missMs: 200, tolerance: 0.15, wrists: true, filter: 1, perPlayer: false, needs: BODY };
const RULES: Record<string, Rule | 'game' | 'dev'> = {
  game: 'game',
  // devCalibration.ts is copied from 61414651:apps/web/src/game/webcamCalibration.ts.
  dev: 'dev',
  'shared-hold (dev)': SHARED_HOLD_DEV,
  'no-wrists': { ...SHARED_HOLD_DEV, wrists: false },
  'median5': { ...SHARED_HOLD_DEV, filter: 5 },
  'miss-500': { ...SHARED_HOLD_DEV, missMs: 500 },
  'tol-0.25': { ...SHARED_HOLD_DEV, tolerance: 0.25 },
  'per-player': { ...SHARED_HOLD_DEV, perPlayer: true },
  'robust': { ...SHARED_HOLD_DEV, wrists: false, filter: 5, missMs: 500 },
  'robust+per-player': { ...SHARED_HOLD_DEV, wrists: false, filter: 5, missMs: 500, perPlayer: true },
  'robust+per-player+1.5s': { ...SHARED_HOLD_DEV, wrists: false, filter: 5, missMs: 500, perPlayer: true, stillMs: 1500 },
  'robust+no-ankles': { ...SHARED_HOLD_DEV, wrists: false, filter: 5, missMs: 500, needs: NO_ANKLES },
};

const reliable = (j: Landmark | undefined) => !!j && (j.confidence ?? 0) >= 0.5;
const inView = (j: Landmark | undefined) => !!j && j.x >= 0 && j.x <= 1 && j.y >= 0 && j.y <= 1;
const dist = (a: { x: number; y: number }, b: { x: number; y: number }, aspect: number) => Math.hypot((a.x - b.x) * aspect, a.y - b.y);
const mid = (p: readonly Landmark[], a: number, b: number) => ({ x: (p[a].x + p[b].x) / 2, y: (p[a].y + p[b].y) / 2 });
const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

interface Hold { start: number | null; anchor: Landmark[] | null; frames: Pose[]; seen: number; recent: Landmark[][]; done: TrackCalibration | null; }
/** The rule as a drop-in for WebcamCalibration (the parts GameLoop and GameSession use). */
class RuleCalibration {
  rule: Rule; playerCount: PlayerCount;
  lastCapture = -Infinity; seq: number | null = null;
  holds: Hold[] = [];
  anchors: Pose[] | null = null;
  progress = 0;
  players: string[] = [];
  tracks: TrackCalibration[] | null = null;
  constructor(playerCount: PlayerCount, rule: Rule) { this.rule = rule; this.playerCount = playerCount; this.reset(); }
  fresh(): Hold { return { start: null, anchor: null, frames: [], seen: -Infinity, recent: [], done: null }; }
  resetHold() { this.reset(false); }
  reset(keepDone = this.rule.perPlayer) { this.holds = Array.from({ length: this.playerCount }, (_, i) => keepDone && this.holds[i]?.done ? this.holds[i] : this.fresh()); this.sync(); }
  sync() {
    this.anchors = this.holds.some(h => h.anchor || h.done) ? [] : null;
    const prog = this.holds.map(h => h.done ? 1 : h.start === null ? 0 : Math.min(1, (this.lastCapture - h.start) / this.rule.stillMs));
    this.progress = this.rule.perPlayer ? prog.reduce((a, b) => a + b, 0) / prog.length : Math.min(...prog);
  }
  filtered(h: Hold, p: Landmark[]): Landmark[] {
    if (this.rule.filter <= 1) return p;
    h.recent.push(p);
    if (h.recent.length > this.rule.filter) h.recent.shift();
    return p.map((j, i) => ({ ...j, x: median(h.recent.map(q => q[i].x)), y: median(h.recent.map(q => q[i].y)) }));
  }
  accept(record: CalibrationRecord, captureTime: number, now: number): boolean {
    if (this.tracks) return true;
    if (!Number.isFinite(captureTime) || captureTime > now || now - captureTime > this.rule.gapMs) return false;
    if ((this.seq !== null && record.seq <= this.seq) || captureTime <= this.lastCapture) return false;
    this.seq = record.seq;
    if (captureTime - this.lastCapture > this.rule.gapMs) this.reset();
    this.lastCapture = captureTime;
    const aspect = record.input.width / record.input.height;
    const status: string[] = [];
    const resetAll = () => { if (!this.rule.perPlayer) this.holds = this.holds.map(() => this.fresh()); };
    for (let id = 0; id < this.playerCount; id++) {
      const h = this.holds[id];
      if (h.done) { status[id] = 'ready'; continue; }
      const pose = record.poses.find(p => p.playerId === id);
      const ok = pose && this.rule.needs.every(i => inView(pose.landmarks[i]) && reliable(pose.landmarks[i]));
      if (!pose) {
        if (h.anchor && captureTime - h.seen <= this.rule.missMs) { status[id] = 'holding'; continue; }
        status[id] = 'missing';
      } else if (!ok) status[id] = 'body';
      else {
        const p = this.filtered(h, pose.landmarks as Landmark[]);
        if (h.anchor) {
          const a = h.anchor;
          const tol = Math.max(0.02, dist(mid(a, 11, 12), mid(a, 23, 24), aspect)) * this.rule.tolerance;
          const joints = [...this.rule.needs, ...(this.rule.wrists ? [15, 16].filter(i => reliable(p[i]) && reliable(a[i])) : [])];
          status[id] = joints.some(i => dist(p[i], a[i], aspect) > tol) ? 'moving' : 'holding';
        } else status[id] = 'holding';
      }
      if (status[id] !== 'holding') {
        if (this.rule.perPlayer) this.holds[id] = this.fresh();
        else { resetAll(); break; }
      }
    }
    if (!this.rule.perPlayer && status.length === this.playerCount && status.some(s => s !== 'holding')) { resetAll(); this.players = status; this.sync(); return false; }
    // Start (or continue) holds.
    for (let id = 0; id < this.playerCount; id++) {
      const h = this.holds[id];
      if (h.done || status[id] !== 'holding') continue;
      const pose = record.poses.find(p => p.playerId === id);
      if (!pose) continue;
      if (!h.anchor) { h.anchor = this.filtered(h, pose.landmarks as Landmark[]); if (this.rule.filter > 1) h.recent = [pose.landmarks as Landmark[]]; h.start = captureTime; }
      h.frames.push(pose); h.seen = captureTime;
    }
    if (!this.rule.perPlayer && this.holds.some(h => !h.anchor)) { this.players = status; this.sync(); return false; }
    for (const h of this.holds) {
      if (h.done || h.start === null) continue;
      if (captureTime - h.start >= this.rule.stillMs && h.frames.length >= 6 && this.rule.perPlayer) h.done = calibratePoses(h.frames, record.input, { adaptiveDistance: true });
    }
    if (!this.rule.perPlayer) {
      const start = Math.max(...this.holds.map(h => h.start ?? Infinity));
      if (captureTime - start >= this.rule.stillMs && this.holds.every(h => h.frames.length >= 6)) for (const h of this.holds) h.done = calibratePoses(h.frames, record.input, { adaptiveDistance: true });
    }
    this.players = this.holds.map((h, i) => h.done ? 'ready' : status[i]);
    this.sync();
    if (this.holds.every(h => h.done)) { this.tracks = this.holds.map(h => h.done!); return true; }
    return false;
  }
  status() { return { players: this.players, progress: this.progress, complete: this.tracks !== null }; }
}

/** When every GT player is first in a hold together, and when that shared hold ends. */
function sharedHold(gt: readonly GtFrame[]): { start: number; end: number } | null {
  const ids = [...new Set(gt.flatMap(f => f.people.filter(p => p.role === 'player').map(p => p.id)))];
  const holding = (f: GtFrame) => ids.every(id => f.people.find(p => p.id === id)?.phase === 'hold');
  const s = gt.find(holding);
  if (!s) return null;
  const e = gt.find(f => f.t_ms > s.t_ms && !holding(f));
  return { start: s.t_ms, end: e ? e.t_ms : gt[gt.length - 1].t_ms };
}

/** Whether every GT player shows shoulders, hips and ankles in the picture (unoccluded by others) during the hold. */
function calibratable(scene: Scene, hold: { start: number; end: number }): boolean {
  const frames = scene.gt.filter(f => f.t_ms >= hold.start && f.t_ms <= hold.end);
  const ok = frames.filter(f => f.people.filter(p => p.role === 'player').every(p => BODY.every(i => p.kp[i][3] !== 3 && p.kp[i][3] !== 2)));
  return ok.length * (1000 / scene.fps) >= SHARED_HOLD_DEV.stillMs + 500;
}

/** All estimators for one scene share its frame pixels, as in the sequential study. */
export async function calibrationScene({ sid, estimators }: { sid: string; estimators: string[] }) {
  const rows: Record<string, unknown>[] = [];
  let scene: Scene;
  try { scene = loadScene(sid); } catch { return []; }
  const hold = sharedHold(scene.gt);
  if (!hold) return [];
  const expect = calibratable(scene, hold) && hold.end - hold.start >= SHARED_HOLD_DEV.stillMs + 300;
  let pixels: Map<number, Pixels> | null | undefined;
  for (const est of estimators) {
    const file = path.join(runDir(est, sid), 'detections.jsonl');
    if (!existsSync(file)) continue;
    const dets = readJsonl<DetFrame>(file).sort((a, b) => (a.received_ms ?? a.t_ms) - (b.received_ms ?? b.t_ms));
    if (scene.players > 1 && dets.some(d => !d.looks && d.people.length) && pixels === undefined) {
      const { framePixels } = await import('../harness/looks.ts');
      pixels = await framePixels(scene);
    }
    const row: Record<string, unknown> = { scene: sid, estimator: est, players: scene.players, hold_start_ms: hold.start, hold_ms: hold.end - hold.start, expect_complete: expect };
    for (const [name, rule] of Object.entries(RULES)) {
      const loop = new GameLoop(scene.players, { width: scene.width, height: scene.height }, { danceStartMs: danceWindow(scene)?.[0] ?? Infinity });
      if (rule !== 'game') (loop as unknown as { calibration: unknown }).calibration = rule === 'dev' ? new DevCalibration(scene.players as PlayerCount) : new RuleCalibration(scene.players as PlayerCount, rule);
      let complete: number | null = null, holds = 0, was = false;
      for (const line of dets) {
        const looks = line.looks ?? (pixels?.get(line.frame) ? looksOf(pixels.get(line.frame)!, line) : undefined);
        const r = loop.replay(line, looks);
        if (r.calib?.complete) { complete = r.t_ms; break; }
        if (r.calib?.hold && !was) holds++;
        was = !!r.calib?.hold;
      }
      const tracks = (loop.calibration as unknown as WebcamCalibration).tracks;
      // Calibration error vs GT poses over the same hold.
      let torsoErr: number | null = null, floorErr: number | null = null;
      if (complete !== null && tracks) {
        const gtFrames = scene.gt.filter(f => f.t_ms >= complete! - SHARED_HOLD_DEV.stillMs && f.t_ms <= complete!);
        const byX = (f: GtFrame) => f.people.filter(p => p.role === 'player').sort((a, b) => b.kp[11][0] + b.kp[12][0] - a.kp[11][0] - a.kp[12][0]);
        const gtCal = byX(gtFrames[0] ?? scene.gt[0]).map((_, k) => calibratePoses(gtFrames.map(f => ({ playerId: k, landmarks: byX(f)[k]?.kp.map(([x, y]) => ({ x, y, z: 0, confidence: 1 })) ?? [] })).filter(p => p.landmarks.length), { width: scene.width, height: scene.height } as FrameSize));
        const ts = tracks.map((t, k) => gtCal[k] ? Math.abs(t.torsoLength / gtCal[k].torsoLength - 1) : NaN).filter(Number.isFinite);
        const fs = tracks.map((t, k) => gtCal[k] ? Math.abs(t.floorY - gtCal[k].floorY) : NaN).filter(Number.isFinite);
        torsoErr = ts.length ? Math.max(...ts) : null; floorErr = fs.length ? Math.max(...fs) : null;
      }
      const before = complete !== null && complete < hold.start + SHARED_HOLD_DEV.stillMs - 300 && name !== 'robust+per-player+1.5s';
      row[name] = { complete_ms: complete, after_hold_ms: complete === null ? null : complete - hold.start, holds, early: before, torso_err: torsoErr, floor_err: floorErr };
    }
    rows.push(row);
  }
  return rows;
}

if (import.meta.main) {
  const opts = parseArgs(process.argv.slice(2), { estimators: 'string', scenes: 'string', out: 'string', jobs: 'string' }).opts;
  const estimators = opts.estimators ? String(opts.estimators).split(',') : ['mp-lite-game', 'mp-full-game', 'mp-heavy-game', 'rtmo-s', 'rtmpose-s', 'movenet-multipose', 'apple-vision'];
  const prefixes = opts.scenes ? String(opts.scenes).split(',') : [];
  const sceneIds = readdirSync(path.join(DATA, 'scenes')).filter(s => !s.startsWith('_') && existsSync(path.join(DATA, 'scenes', s, 'READY')) && (!prefixes.length || prefixes.some(p => s.startsWith(p)))).sort();
  const rows = (await scenePool<Parameters<typeof calibrationScene>[0], Awaited<ReturnType<typeof calibrationScene>>>(
    new URL(import.meta.url), calibrationScene, sceneIds.map(sid => ({ sid, estimators })), jobsOption(opts.jobs))).flat();
  for (const row of rows) {
    const g = row.game as { after_hold_ms: number | null }, r = row['robust+per-player'] as { after_hold_ms: number | null };
    console.log(`${row.scene} ${row.estimator}: expect ${row.expect_complete ? 'yes' : 'no'}; game ${g.after_hold_ms ?? 'never'}; robust+per-player ${r.after_hold_ms ?? 'never'}`);
  }
  // Summary per estimator × rule over scenes that should calibrate, and false completions in ones that shouldn't.
  const summary: Record<string, Record<string, unknown>> = {};
  for (const est of estimators) {
    const mine = rows.filter(r => r.estimator === est);
    if (!mine.length) continue;
    for (const name of Object.keys(RULES)) {
      const should = mine.filter(r => r.expect_complete), shouldnt = mine.filter(r => !r.expect_complete);
      const res = (r: Record<string, unknown>) => r[name] as { after_hold_ms: number | null; early: boolean; torso_err: number | null };
      const done = should.filter(r => res(r).after_hold_ms !== null && res(r).after_hold_ms! <= (r.hold_ms as number) + 500);
      const t = done.map(r => res(r).after_hold_ms!).sort((a, b) => a - b);
      (summary[est] ??= {})[name] = {
        should: should.length, completed_in_hold: done.length, completed_frac: should.length ? done.length / should.length : null,
        median_after_hold_ms: t.length ? t[Math.floor(t.length / 2)] : null, p90_after_hold_ms: t.length ? t[Math.floor(t.length * 0.9)] : null,
        early: mine.filter(r => res(r).early).length, false_complete: shouldnt.filter(r => res(r).after_hold_ms !== null && res(r).after_hold_ms! <= (r.hold_ms as number)).length, shouldnt: shouldnt.length,
        torso_err_median: (() => { const v = mine.map(r => res(r).torso_err).filter((x): x is number => x !== null).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; })(),
      };
    }
  }
  // Check completion times against the unmodified dev rule, not this branch's per-player rule.
  // The ablations retain the original study's behaviour: a shared reset can start a partial
  // hold in the same record. dev clears everyone's hold and waits for the next record.
  const mismatches = rows.filter(r => (r.dev as { complete_ms: number | null }).complete_ms !== (r['shared-hold (dev)'] as { complete_ms: number | null }).complete_ms).map(r => ({
    scene: r.scene, estimator: r.estimator,
    dev_ms: (r.dev as { complete_ms: number | null }).complete_ms,
    shared_hold_ms: (r['shared-hold (dev)'] as { complete_ms: number | null }).complete_ms,
  }));
  const selfCheck = { reference: '61414651:apps/web/src/game/webcamCalibration.ts', compared: rows.length, matched: rows.length - mismatches.length, mismatches };
  writeJson(String(opts.out ?? path.join(DATA, 'reports', 'calibration.json')), { rules: RULES, summary, rows, self_check: selfCheck });
  for (const [est, s] of Object.entries(summary)) {
    console.log(`\n${est}`);
    for (const [name, v] of Object.entries(s)) console.log(`  ${name.padEnd(24)} ${JSON.stringify(v)}`);
  }
  console.log(`\nshared-hold (dev) vs dev WebcamCalibration (61414651): ${selfCheck.matched}/${selfCheck.compared} same completion time` + (mismatches.length ? ` (differ: ${mismatches.map(r => `${r.scene}/${r.estimator}: ${r.shared_hold_ms} vs dev ${r.dev_ms} ms`).join(', ')})` : ''));
}
