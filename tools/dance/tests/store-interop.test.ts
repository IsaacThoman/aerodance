// The Studio's store (packages/dance/store.ts) and the `dance` CLI's project (../project.ts)
// work in the same folder: a project the store made, with a recorded take placed in it, is one
// the CLI reads, edits and bundles; the store then sees the CLI's revision and undoes it; and a
// version 1 dance.json opens in both.
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { createEvaluator } from '../../../packages/dance/evaluate.ts';
import { DANCE_VERSION, newDance } from '../../../packages/dance/format.ts';
import type { Dance, Dancer } from '../../../packages/dance/format.ts';
import { applyOps } from '../../../packages/dance/ops.ts';
import { DANCE_FILE, DanceStore, mimeOf } from '../../../packages/dance/store.ts';
import type { ProjectFiles } from '../../../packages/dance/store.ts';
import type { TrackedFrame } from '../../../packages/dance/takes.ts';
import { validateSong, validateSongChoreography } from '../../../packages/pose/song.ts';
import { bundleZip, songBundle } from '../bundle.ts';
import { DanceProject } from '../project.ts';
import { tempDir } from './helpers.ts';

/** A project's files in a folder on disk, as the Studio keeps them in a folder the author picked. */
function folderFiles(dir: string): ProjectFiles {
  const at = (file: string) => path.join(dir, ...file.split('/'));
  const read = async (file: string) => {
    try { return new Uint8Array(await readFile(at(file))); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  };
  return {
    read,
    write: async (file, data) => {
      await mkdir(path.dirname(at(file)), { recursive: true });
      await writeFile(at(file), data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data);
    },
    remove: file => rm(at(file), { recursive: true, force: true }),
    list: folder => readdir(at(folder)).catch(() => []),
    blob: async file => { const bytes = await read(file); return bytes ? new Blob([bytes], { type: mimeOf(file) }) : null; },
  };
}
/** A performer hitting a pose every second, as a camera would have tracked them (song time). */
function performance(toMs = 12_000): TrackedFrame[] {
  const poses = [[0.62, 0.3, 0.38, 0.3], [0.66, 0.5, 0.42, 0.62], [0.56, 0.62, 0.34, 0.46], [0.6, 0.2, 0.36, 0.56]];
  const source = applyOps(newDance({ dancers: 1, durationMs: toMs + 2000, frame: { width: 640, height: 480 } }),
    [{ op: 'pose', dancer: 'P1', t: 0, from: 'neutral' }, ...Array.from({ length: 12 }, (_, n) =>
      ({ op: 'key', dancer: 'P1', t: 500 + n * 1000, set: { leftWrist: poses[n % 4].slice(0, 2), rightWrist: poses[n % 4].slice(2) } }))]).dance;
  const evaluator = createEvaluator(source, source.dancers[0]), frames: TrackedFrame[] = [];
  for (let t = 0; t <= toMs; t += 1000 / 30) {
    const time = Math.round(t * 10) / 10;
    frames.push({ videoMs: time, poses: [evaluator.landmarks(time).map(l => ({ ...l, confidence: 0.95 }))] });
  }
  return frames;
}
/** The dance without what every save changes. */
const content = (dance: Dance) => ({ ...dance, revision: 0, updatedAt: '' });
const audio = new Uint8Array(4096).map((_, i) => i % 251);

test('a project the Studio\'s store made is read, edited and bundled by the dance CLI, and the store follows', async t => {
  const dir = await tempDir(t), store = new DanceStore(folderFiles(dir));
  await store.create({ title: 'Interop', artist: 'Tester', dancers: 1, durationMs: 12_000 });
  const music = await store.addSource('audio', 'song.mp3', audio);
  await store.update('add the music', dance => { dance.sources.audio = { ...music, durationMs: 12_000 }; });
  const { take } = await store.addTake(performance(), { width: 640, height: 480, slots: 1 }, { label: 'Whole song · take 1', origin: 'webcam', clock: 'song', fps: 30 });
  const placed = await store.apply({ ops: [{ op: 'clip', dancer: 'P1', take: take.id }], label: 'record the whole song' });
  assert.equal(placed.revision, 3);
  assert.equal(placed.dance.dancers[0].clips.length, 1);

  // The CLI opens the same folder: the dance validates, and its sources are where it says.
  const project = new DanceProject(dir);
  assert.ok(DanceProject.exists(dir));
  const read = await project.read();
  assert.deepEqual(read, placed.dance);
  assert.deepEqual(new Uint8Array(await readFile(project.resolve(read.sources.audio!.path))), audio);
  assert.ok((await project.takes(read))(take.id), 'the CLI decodes the take the store saved');

  // An edit through the CLI is the next revision, with the store's history kept beneath it.
  const fixed = await project.apply({ ops: [{ op: 'fix', dancer: 'P1', t: 3000, set: { leftWrist: { dy: -0.1 } } }], expectRevision: placed.revision });
  assert.deepEqual([fixed.previousRevision, fixed.revision], [3, 4]);
  const edited = await project.read();
  assert.equal(edited.revision, 4);
  assert.ok(edited.dancers[0].layers.some(layer => layer.id === 'fix' && layer.channels.leftWrist?.length), 'the touch-up is in the dance');
  assert.deepEqual((await project.log()).undo.map(entry => entry.label), ['add the music', 'add take Whole song · take 1', 'record the whole song', 'fix']);

  // The CLI bundles it as a song the game accepts.
  const bundle = await songBundle(project, edited);
  const song = validateSong(JSON.parse(new TextDecoder().decode(bundle.files.get('song.json'))));
  assert.equal(song.songId, bundle.songId);
  assert.deepEqual([song.title, song.artist, song.dancers], ['Interop', 'Tester', 1]);
  assert.ok(bundle.files.has('audio.mp3') && bundle.files.has('checksums.json'));
  assert.equal(validateSongChoreography(song, bundle.files.get('choreography.adpose')!).tracks.length, 1);
  assert.ok(bundleZip(bundle).length > audio.length);

  // Back in the Studio: the store that made the project, and one opened afresh, see the CLI's revision…
  for (const reader of [store, new DanceStore(folderFiles(dir))]) assert.deepEqual(await reader.read(), edited);
  assert.equal((await store.log()).undo.at(-1)?.label, 'fix');
  // …and undo through the store puts back the dance as it was before the CLI's edit.
  const undone = await store.step('undo');
  assert.equal(undone?.label, 'fix');
  assert.equal(undone?.dance.revision, 5);
  assert.deepEqual(content(undone!.dance), content(placed.dance));
  assert.deepEqual(content(await project.read()), content(placed.dance), 'the CLI reads the undone dance');
  // The CLI can redo what the store undid.
  assert.equal((await project.step('redo'))?.revision, 6);
  assert.deepEqual(content(await store.read()), content(edited));
});

test('a version 1 dance.json opens in the Studio\'s store and in the dance CLI', async t => {
  const dir = await tempDir(t);
  const old: Omit<Dance, 'schemaVersion' | 'sources' | 'dancers'> & { schemaVersion: number; sources: Partial<Dance['sources']>; dancers: Partial<Dancer>[] }
    = newDance({ dancers: 2, durationMs: 8000, title: 'Before takes', now: '2026-01-01T00:00:00.000Z' });
  old.schemaVersion = 1;
  delete old.sources.takes;
  for (const dancer of old.dancers) { delete dancer.clips; delete dancer.approvals; }
  await writeFile(path.join(dir, DANCE_FILE), JSON.stringify(old, null, 1) + '\n');

  const store = new DanceStore(folderFiles(dir)), project = new DanceProject(dir);
  const viaStore = await store.read(), viaCli = await project.read();
  assert.deepEqual(viaStore, viaCli);
  assert.equal(viaStore.schemaVersion, DANCE_VERSION);
  assert.deepEqual(viaStore.sources.takes, []);
  assert.deepEqual(viaStore.dancers.map(d => [d.clips, d.approvals]), [[[], []], [[], []]]);
  assert.equal(viaStore.song.title, 'Before takes');

  // Each saves it in the current version, and the other reads that.
  const first = await store.apply({ ops: [{ op: 'song', set: { artist: 'Store' } }] });
  assert.equal(first.revision, 1);
  assert.equal((await project.read()).song.artist, 'Store');
  const second = await project.apply({ ops: [{ op: 'song', set: { bpm: 120 } }], expectRevision: 1 });
  assert.equal(second.revision, 2);
  const saved = await store.read();
  assert.deepEqual([saved.schemaVersion, saved.song.artist, saved.song.bpm], [DANCE_VERSION, 'Store', 120]);
  assert.equal(JSON.parse(await readFile(path.join(dir, DANCE_FILE), 'utf8')).schemaVersion, DANCE_VERSION);
});
