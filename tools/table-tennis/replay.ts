/*
 * A recorded Table Tennis session (/?record=session) played again through the game's own round,
 * without a screen: each pose goes to the players' hands when it arrived, the round steps at the
 * screen's rate while the recording says it was playing, and every shot is listed with how long it
 * left the other player to get to it.
 *
 *   node tools/table-tennis/replay.ts <session.jsonl> [--fps 60] [--hands]
 *
 * The shots won't match the recording's own to the frame (the recording doesn't keep the screen's
 * frame times), but the same swings serve and hit the same balls. `--hands` lists the stretches
 * where a paddle hand went missing instead.
 */

import { readSession } from '../replay/session.ts';
import type { SessionPose } from '../../packages/pose/sessionLog.ts';
import { ASSIST_LEVELS, DEFAULT_ASSIST } from '../../apps/web/src/minigames/table-tennis/assist.ts';
import type { AssistLevel } from '../../apps/web/src/minigames/table-tennis/assist.ts';
import { TABLE } from '../../apps/web/src/minigames/table-tennis/ball.ts';
import type { V3 } from '../../apps/web/src/minigames/table-tennis/ball.ts';
import { describePass } from '../../apps/web/src/minigames/table-tennis/calibrate.ts';
import { handAgrees, handLive, newHandFilters, newRig, trackHands } from '../../apps/web/src/minigames/table-tennis/rig.ts';
import { Round } from '../../apps/web/src/minigames/table-tennis/round.ts';
import type { Play } from '../../apps/web/src/minigames/table-tennis/round.ts';
import type { RawPose } from '../../apps/web/src/minigames/pose/body.ts';

const path = process.argv[2];
if (!path) { console.error('usage: node tools/table-tennis/replay.ts <session.jsonl> [--fps 60] [--hands]'); process.exit(1); }
const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const fps = Number(arg('fps', '60'));

const { header, records } = await readSession(path);
if (header.game !== 'table-tennis') { console.error(`not a Table Tennis session: ${header.game}`); process.exit(1); }
const options = header.options as Record<string, string>;
const count = header.playerCount;
const side = (i: number) => (options[`paddleHand.${i + 1}`] === 'left' ? 'left' : 'right');
const rigs = Array.from({ length: Math.min(count, 2) }, (_, i) => newRig(i as 0 | 1, side(i)));
const filters = rigs.map(() => newHandFilters());
const play: Play = { forgiving: false, serve: false, timeScale: 1, hitLag: 'auto', assist: DEFAULT_ASSIST, botLevel: (options.botShots ?? 'easy') as Play['botLevel'], botAlways: options.botReturns !== 'fair' };
const round = new Round(rigs, play);
const two = rigs.length > 1;
const secs = (t: number) => ((t - header.t) / 1000).toFixed(2).padStart(6);
const len = (v: V3) => Math.hypot(v.x, v.y, v.z);

if (process.argv.includes('--hands')) {
  // Each player's paddle hand: found by the hand model, at its wrist, with the wrist itself seen.
  const poses = records.filter((l): l is SessionPose => l.type === 'pose');
  for (const [i, rig] of rigs.entries()) {
    let found = 0, agreed = 0, wrist = 0, present = 0;
    const gaps: { from: number; to: number; why: string }[] = [];
    let open: { from: number; why: string } | null = null;
    for (const line of poses) {
      const p = line.record.poses.find((q) => q.playerId === i);
      const hand = p?.hands?.find((h) => h.side === rig.paddle);
      const image = p?.landmarks.map((l) => ({ x: l.x, y: l.y, z: l.z, visibility: l.confidence ?? 1 }));
      const seen = image ? (image[rig.paddle === 'left' ? 15 : 16].visibility ?? 1) >= 0.4 : false;
      const ok = !!hand && !!image && handAgrees(image, hand, rig.paddle, line.record.input);
      if (p) present += 1;
      if (hand) found += 1;
      if (ok) agreed += 1;
      if (seen) wrist += 1;
      const why = !p ? 'no player' : !p.hands ? 'hand model off' : !hand ? (seen ? 'hand not found' : 'hand not found, wrist unsure') : !ok ? 'hand found elsewhere' : '';
      if (why && !open) open = { from: line.t, why };
      if (!why && open) { gaps.push({ ...open, to: line.t }); open = null; }
    }
    if (open) gaps.push({ ...open, to: poses.at(-1)!.t });
    const pct = (n: number) => `${Math.round((100 * n) / poses.length)}%`;
    console.log(`\nPlayer ${i + 1} (${rig.paddle} hand): seen ${pct(present)} of ${poses.length} poses · wrist sure ${pct(wrist)} · hand found ${pct(found)} · at its wrist ${pct(agreed)}`);
    const long = gaps.filter((g) => g.to - g.from >= 150);
    console.log(`  lost for 150 ms or more ${long.length} times, ${(long.reduce((s, g) => s + g.to - g.from, 0) / 1000).toFixed(1)} s in all; the longest:`);
    for (const g of [...long].sort((a, b) => (b.to - b.from) - (a.to - a.from)).slice(0, 12).sort((a, b) => a.from - b.from)) {
      console.log(`  ${secs(g.from)}s  ${String(Math.round(g.to - g.from)).padStart(5)} ms  ${g.why}  (video ${((g.from - header.videoStartTime) / 1000).toFixed(2)}s)`);
    }
  }
  process.exit(0);
}

// The round, frame by frame.
let playing = false, at = 0;
const step = 1000 / fps;
const end = records.at(-1)!.t;
/** A serve or a shot: whose (-1: the robot's), and how it went for whoever it was hit to. */
interface Shot { t: number; by: number; serve: boolean; speed: number; vel: V3; from: V3; swing: number; bounce: number | null; reach: number | null; answered: boolean; live: boolean;
  /** The other player's go at it: their fastest swing while it came (m/s) and when (s after the shot), and how it passed their paddle. */
  swung: number; swungAt: number | null; pass: string; }
const shots: Shot[] = [];
let open: Shot | null = null;
let watched: Shot | null = null;
const passSeen = rigs.map((): unknown => null);
const lost = rigs.map(() => 0);
let frames = 0;
for (let now = header.t; now <= end; now += step) {
  while (at < records.length && records[at].t <= now) {
    const line = records[at++];
    if (line.type === 'phase') playing = (line as unknown as { data: { phase: string } }).data.phase === 'playing';
    if (line.type === 'report') {
      const assist = (line as unknown as { data: Record<string, string> }).data.assist ?? (line as unknown as { data: Record<string, string> }).data.mgAssist;
      if (assist && (ASSIST_LEVELS as readonly string[]).includes(assist)) play.assist = assist as AssistLevel;
    }
    if (line.type === 'pose') {
      const pose = line as SessionPose;
      for (const [i, rig] of rigs.entries()) {
        const p = pose.record.poses.find((q) => q.playerId === i);
        if (!p) continue;
        const raw = { landmarks: p.landmarks, world: p.world ?? null, hands: p.hands ?? null, input: { ...pose.record.input, mirrored: false }, capturedAt: pose.captureBrowserTimeMs } as unknown as RawPose;
        trackHands(rig, raw, pose.receivedBrowserTimeMs, filters[i]);
      }
    }
  }
  const wasFlying = round.flying;
  const swings = round.players.map((p) => Math.max(0, ...p.speeds.map((s) => len(s.vel))));
  round.step(step / 1000, now, playing);
  if (playing) { frames += 1; rigs.forEach((rig, i) => { if (!handLive(rig, rig.paddle, now)) lost[i] += 1; }); }
  for (const e of round.events) {
    if (e.type === 'paddle') {
      // (Alone, the robot's paddle has no player: its serves and shots are the player's to answer, and it answers theirs.)
      const by = e.by ?? -1;
      if (open) open.answered = true;
      const other = by < 0 ? rigs[0] : rigs[by === 0 ? 1 : 0];
      open = { t: now, by, serve: !wasFlying, speed: len(round.ball.vel), vel: { ...round.ball.vel }, from: { ...round.ball.pos }, swing: by < 0 ? 0 : swings[by], bounce: null, reach: null, answered: false, live: other ? handLive(other, other.paddle, now) : true, swung: 0, swungAt: null, pass: '' };
      watched = open;
      shots.push(open);
    }
    if (e.type === 'table' && open && open.bounce === null && Math.sign(e.at.z) !== Math.sign(open.from.z)) open.bounce = (now - open.t) / 1000;
  }
  // When the ball gets to the other player's end of the table.
  if (open && open.reach === null && round.flying && Math.sign(round.ball.pos.z) !== Math.sign(open.from.z) && Math.abs(round.ball.pos.z) >= TABLE.halfLength) open.reach = (now - open.t) / 1000;
  // The other player's swing at it, and how it went by them.
  if (watched && (two || watched.by < 0)) {
    const them = watched.by === 0 ? 1 : 0;
    const vel = round.players[them].speeds.at(-1);
    if (now - watched.t < 1500 && vel && len(vel.vel) > watched.swung) { watched.swung = len(vel.vel); watched.swungAt = (now - watched.t) / 1000; }
    if (round.passes[them] !== passSeen[them] && round.passes[them]) watched.pass ||= describePass(round.passes[them]!);
  }
  rigs.forEach((_, i) => { passSeen[i] = round.passes[i]; });
  if (!round.flying) open = null;
}

const f = (n: number | null, d = 2) => (n === null ? '   –' : n.toFixed(d).padStart(5));
console.log(`${path}\n${count} player${count > 1 ? 's' : ''} · assist ${play.assist} at the end · ${shots.length} shots replayed`);
console.log('  time   by  kind    swing m/s  ball m/s  to bounce  to their end  answered  their swing');
for (const s of shots) {
  console.log(`${secs(s.t)}  ${s.by < 0 ? 'bot' : `P${s.by + 1} `} ${s.serve ? 'serve ' : 'return'}  ${f(s.by < 0 ? null : s.swing, 1)}      ${f(s.speed, 1)}     ${f(s.bounce)} s    ${f(s.reach)} s      ${s.answered ? 'yes' : 'no '}      ${two || s.by < 0 ? `${f(s.swung, 1)} m/s at ${f(s.swungAt)} s · ${s.pass || 'no pass'}` : ''}${s.live ? '' : '  (their hand lost)'}`);
}
const med = (a: number[]) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : null; };
const theirs = shots.filter((s) => s.by >= 0), robots = shots.filter((s) => s.by < 0);
for (const [name, set] of [['serves', theirs.filter((s) => s.serve)], ['returns', theirs.filter((s) => !s.serve)], ["the robot's serves", robots.filter((s) => s.serve)], ["the robot's shots", robots.filter((s) => !s.serve)]] as const) {
  if (!set.length) continue;
  console.log(`${name}: ${set.length} · median swing ${f(med(set.flatMap((s) => (s.by < 0 ? [] : [s.swing]))), 1)} m/s · ball ${f(med(set.map((s) => s.speed)), 1)} m/s · to their end ${f(med(set.flatMap((s) => (s.reach === null ? [] : [s.reach]))))} s · answered ${set.filter((s) => s.answered).length}`);
}
if (two && frames) console.log(`paddle hand lost while playing: ${rigs.map((_, i) => `P${i + 1} ${Math.round((100 * lost[i]) / frames)}%`).join(' · ')}`);
