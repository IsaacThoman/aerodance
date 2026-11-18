// The project store, song bundles and playtest analysis, on a project held in memory.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildSongBundle, bundleZip } from '../bundle.ts';
import { compileDance } from '../compile.ts';
import { createEvaluator } from '../evaluate.ts';
import { newDance } from '../format.ts';
import { danceFromSong } from '../fromSong.ts';
import { applyOps } from '../ops.ts';
import { analyzeAttempt, heatmap, measuredDifficulty, trouble } from '../playtest.ts';
import type { AttemptSample } from '../playtest.ts';
import { gameBundle } from '../score.ts';
import { DanceStore, RevisionConflict, memoryFiles } from '../store.ts';
import type { TrackedFrame } from '../takes.ts';
import { sha256, validateSong } from '../../pose/song.ts';
import { readZip } from '../../pose/zip.ts';
import type { Landmark } from '../../pose/choreography.ts';

/** A performer hitting a pose every second, as a camera would have tracked them (song time). */
function performance({ fromMs = 0, toMs = 12_000, lateMs = 0, lost = null as readonly [number, number] | null, still = false } = {}): TrackedFrame[] {
  const poses = [[0.62, 0.3, 0.38, 0.3], [0.66, 0.5, 0.42, 0.62], [0.56, 0.62, 0.34, 0.46], [0.6, 0.2, 0.36, 0.56]];
  const source = applyOps(newDance({ dancers: 1, durationMs: 14_000, frame: { width: 640, height: 480 } }),
    [{ op: 'pose', dancer: 'P1', t: 0, from: 'neutral' }, ...poses.flatMap((_, k) => Array.from({ length: 4 }, (_, n) => n * 4 + k)).sort((a, b) => a - b).map(n =>
      ({ op: 'key', dancer: 'P1', t: 500 + n * 1000, set: { leftWrist: poses[n % 4].slice(0, 2), rightWrist: poses[n % 4].slice(2) } }))]).dance;
  const e = createEvaluator(source, source.dancers[0]), frames: TrackedFrame[] = [];
  for (let t = fromMs; t <= toMs; t += 1000 / 30) {
    const time = Math.round(t * 10) / 10, gone = lost && time >= lost[0] && time <= lost[1];
    frames.push({ videoMs: time, poses: [gone ? null : e.landmarks(still ? 0 : Math.max(0, time - lateMs)).map(l => ({ ...l, confidence: 0.95 }))] });
  }
  return frames;
}
const samples = (frames: readonly TrackedFrame[]): AttemptSample[] => frames.flatMap(f => f.poses[0] ? [{ songTimeMs: f.videoMs, landmarks: f.poses[0] as Landmark[] }] : []);
const SIZE = { width: 640, height: 480, slots: 1 };
const audio = new Uint8Array(4096).map((_, i) => i % 251);
async function project() {
  const files = memoryFiles(), store = new DanceStore(files);
  await store.create({ title: 'Test', artist: 'Tester', dancers: 1, durationMs: 12_000 });
  const ref = await store.addSource('audio', 'song.mp3', audio);
  await store.update('add the music', d => { d.sources.audio = { ...ref, durationMs: 12_000 }; });
  return { files, store };
}

test('a store applies edits as revisions, undoes and redoes them, and refuses stale ones', async () => {
  const { store, files } = await project();
  const first = await store.apply({ ops: [{ op: 'song', set: { bpm: 120 } }], label: 'set the tempo' });
  assert.equal(first.revision, 2);
  assert.equal((await store.read()).song.bpm, 120);
  await assert.rejects(store.apply({ ops: [{ op: 'song', set: { bpm: 90 } }], expectRevision: 1 }), RevisionConflict);
  await assert.rejects(store.apply({ ops: [{ op: 'song', set: { bpm: -1 } }] }), /invalid/);
  assert.equal((await store.read()).revision, 2, 'a refused edit changes nothing');
  assert.equal((await store.step('undo'))?.label, 'set the tempo');
  assert.equal((await store.read()).song.bpm, null);
  assert.deepEqual([(await store.log()).undo.length, (await store.log()).redo.length], [1, 1]);
  await store.step('redo');
  assert.equal((await store.read()).song.bpm, 120);
  assert.equal(await store.step('redo'), null);
  // The files are the layout a `dance` project folder has.
  assert.ok(files.entries.has('dance.json') && files.entries.has('.dance/history.json') && [...files.entries.keys()].some(k => k.startsWith('sources/audio-')));
  // Another store on the same files sees the same dance.
  assert.equal((await new DanceStore(files).read()).song.bpm, 120);
});

test('a recorded take is saved, placed, compiled and bundled as a song the game accepts', async () => {
  const { store } = await project();
  const { take } = await store.addTake(performance(), SIZE, { label: 'Take 1', origin: 'webcam', clock: 'song', fps: 30 });
  assert.equal(take.id, 'k1');
  const placed = await store.apply({ ops: [{ op: 'clip', dancer: 'P1', take: 'k1' }] });
  assert.equal(placed.dance.dancers[0].clips.length, 1);
  const dance = await store.read(), takes = await store.takes(dance);
  const bundle = await buildSongBundle(dance, audio, { takes });
  assert.equal(bundle.song.dancers, 1);
  assert.ok(bundle.files.has('choreography.adpose') && bundle.files.has('audio.mp3') && bundle.files.has('checksums.json'));
  const zip = await readZip(bundleZip(bundle));
  assert.deepEqual(validateSong(JSON.parse(new TextDecoder().decode(zip.get(`${bundle.songId}/song.json`)))).songId, bundle.songId);
  // The same dance gives the same song; changing the motion gives another.
  assert.equal((await buildSongBundle(dance, audio, { takes })).songId, bundle.songId);
  const moved = await store.apply({ ops: [{ op: 'fix', dancer: 'P1', t: 3000, set: { leftWrist: { dy: -0.1 } } }] });
  assert.notEqual((await buildSongBundle(moved.dance, audio, { takes: await store.takes(moved.dance) })).songId, bundle.songId);
  await assert.rejects(buildSongBundle(dance, new Uint8Array(8), { takes }), /hash mismatch/);
  // Removing the take's file is reported, not played as nothing.
  assert.throws(() => compileDance(dance, { takes: () => null }), /Take k1 isn't loaded/);
});

test('attempts are kept beside the dance and explain where points went', async () => {
  const { store } = await project();
  await store.addTake(performance(), SIZE, { label: 'Take 1', origin: 'webcam', clock: 'song', fps: 30 });
  const { dance } = await store.apply({ ops: [{ op: 'clip', dancer: 'P1', take: 'k1' }] });
  const bundle = gameBundle(dance, undefined, await store.takes(dance));
  const kept = await store.addAttempt(performance(), { dancer: 'P1', revision: dance.revision, player: 'Ada', width: 640, height: 480 });
  assert.deepEqual((await store.attempts()).map(a => [a.id, a.player]), [[kept.id, 'Ada']]);
  const back = await store.attempt(kept);
  assert.equal(back?.times.length, performance().length);
  const analyze = (frames: TrackedFrame[]) => analyzeAttempt(bundle, 0, samples(frames), 640 / 480);
  const faithful = analyze(performance()), late = analyze(performance({ lateMs: 200 })), lost = analyze(performance({ lost: [4000, 7000] })), still = analyze(performance({ still: true }));
  assert.ok(faithful.result.accuracy > 0.95, `faithful ${faithful.result.accuracy}`);
  assert.ok(late.result.accuracy < faithful.result.accuracy && late.result.accuracy > 0.4, `late ${late.result.accuracy}`);
  // A late player matches what the coach did earlier: a negative shift.
  assert.ok(late.result.meanOffsetMs < -60, `offset ${late.result.meanOffsetMs}`);
  // Only the arms move in this routine, so standing still still matches the legs and torso.
  assert.ok(still.result.accuracy < faithful.result.accuracy - 0.3, `standing still ${still.result.accuracy}`);
  const gone = lost.intervals.filter(i => i.songTimeMs > 4300 && i.songTimeMs < 6700);
  assert.ok(gone.length > 15 && gone.every(i => i.lost && i.cause === 'tracking'));
  assert.ok(lost.intervals.filter(i => i.songTimeMs < 3500).every(i => i.points > 0.9));
  // Folded onto the timeline: the lost stretch is cold, the rest warm; two good attempts make it a pattern.
  const cells = heatmap([lost, analyze(performance({ lost: [4200, 6800] }))], 0, 12_000);
  assert.equal(cells.length, 12);
  assert.ok(cells[5].points < 0.2 && cells[5].causes.tracking > 0.9 && cells[1].points > 0.9, JSON.stringify(cells.map(c => Math.round(c.points * 100))));
  const spots = trouble([lost, analyze(performance({ lost: [4200, 6800] }))], 0, 12_000);
  assert.equal(spots.length, 1);
  assert.ok(spots[0].startMs >= 4000 && spots[0].endMs <= 7000 && spots[0].cause === 'tracking', JSON.stringify(spots));
  assert.deepEqual(trouble([lost], 0, 12_000), [], 'one attempt is an anecdote');
  assert.equal(measuredDifficulty([faithful]), 'easy');
  assert.equal(measuredDifficulty([]), null);
  await store.removeAttempt(kept.id);
  assert.deepEqual(await store.attempts(), []);
});

test('a finished song opens as a dance that plays the same choreography', async () => {
  const folder = fileURLToPath(new URL('../../../apps/web/public/songs/demo-track-1/', import.meta.url));
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  for (const name of await readdir(folder)) files.set(name, new Uint8Array(await readFile(path.join(folder, name))));
  const store = new DanceStore(memoryFiles());
  await danceFromSong(store, files);
  const dance = await store.read(), takes = await store.takes(dance);
  assert.equal(dance.song.title, 'Demo Track 1');
  assert.equal(dance.dancers.length, 2);
  assert.equal(dance.sources.audio?.sha256, await sha256(files.get('audio.wav') ?? files.get([...files.keys()].find(k => k.startsWith('audio.'))!)!));
  assert.deepEqual(dance.dancers.map(d => d.clips.length), [1, 1]);
  // Compiled again, the dancers are where the song had them (to the format's rounding).
  const original = gameBundle(dance, undefined, takes);
  const { validateSongChoreography } = await import('../../pose/song.ts'), { sampleDancers } = await import('../../pose/song.ts');
  const song = validateSong(JSON.parse(new TextDecoder().decode(files.get('song.json')))), source = { song, choreography: validateSongChoreography(song, files.get(song.choreography.path)!) };
  let worst = 0, compared = 0;
  for (let t = song.playableStartMs + 500; t < song.playableEndMs - 500; t += 700) {
    const a = sampleDancers(source, t), b = sampleDancers(original, t);
    for (const pose of a.poses) {
      const other = b.poses.find(p => p.playerId === pose.playerId);
      if (!other) continue;
      for (const j of [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) { worst = Math.max(worst, Math.abs(pose.landmarks[j].x - other.landmarks[j].x), Math.abs(pose.landmarks[j].y - other.landmarks[j].y)); compared++; }
    }
  }
  assert.ok(compared > 200 && worst < 0.01, `${compared} joints compared, worst ${worst}`);
});
