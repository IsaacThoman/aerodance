// Regressions for problems an independent review found, each reproduced before it was fixed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applyOps, simplifyKeys } from '../ops.ts';
import type { AnyKey } from '../format.ts';
import { createEvaluator } from '../evaluate.ts';
import { evaluate } from '../curves.ts';
import { DanceProject, attachSources, formatJson, initProject } from '../project.ts';
import { installBundle, songBundle } from '../bundle.ts';
import { main } from '../cli.ts';
import { danceWith, dist, tempDir, trackingOf, withTracking } from './helpers.ts';
import { neutralCharacterPose } from '../../../packages/pose/performance.ts';

function wav(ms: number, rate = 8000): Uint8Array {
  const samples = Math.round(ms * rate / 1000), data = samples * 4, out = Buffer.alloc(44 + data);
  out.write('RIFF', 0); out.writeUInt32LE(36 + data, 4); out.write('WAVEfmt ', 8); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(2, 22);
  out.writeUInt32LE(rate, 24); out.writeUInt32LE(rate * 4, 28); out.writeUInt16LE(4, 32); out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(data, 40);
  return out;
}

test('saving keeps text exactly, however often it is saved', async t => {
  assert.equal(JSON.parse(formatJson({ id: 'm', label: 'Intro,' })).label, 'Intro,');
  const project = await initProject(path.join(await tempDir(t), 'p'), { dancers: 1, durationMs: 4000 });
  await project.apply({ ops: [{ op: 'phrase', label: 'Chorus "A": arms up, then', start: 0, end: 1000 }] });
  for (let i = 0; i < 3; i++) await project.apply({ ops: [{ op: 'key', t: i * 100, set: { headYaw: i } }] });
  assert.equal((await project.read()).phrases[0].label, 'Chorus "A": arms up, then');
});
test('a hand edit that keeps the revision survives undo of the next change', async t => {
  const project = await initProject(path.join(await tempDir(t), 'p'), { dancers: 1, durationMs: 4000 });
  await project.apply({ ops: [{ op: 'key', t: 0, set: { headYaw: 1 } }] });
  const text = await readFile(project.file, 'utf8');
  await writeFile(project.file, text.replace('"title": ""', '"title": "Typed by hand"'));
  await project.apply({ ops: [{ op: 'key', t: 100, set: { headYaw: 2 } }] });
  await project.step('undo');
  assert.equal((await project.read()).song.title, 'Typed by hand');
});
test('attaching sources builds on the dance as it is when it saves', async t => {
  const dir = await tempDir(t), project = await initProject(path.join(dir, 'p'), { dancers: 1, durationMs: 4000 });
  const audio = path.join(dir, 'a.wav');
  await writeFile(audio, wav(3000));
  // An edit lands while the (slow) attach is still working on its files.
  const attaching = attachSources(project, { audio });
  await project.apply({ ops: [{ op: 'song', set: { title: 'Kept' } }, { op: 'key', t: 0, set: { headYaw: 5 } }] });
  await attaching;
  const dance = await project.read();
  assert.equal(dance.song.title, 'Kept');
  assert.equal(dance.dancers[0].layers[0].channels.headYaw.length, 1);
  assert.ok(dance.sources.audio);
});
test('ops on an additive layer\'s group channel act on that channel', () => {
  const dance = danceWith([{ op: 'pose', t: 0, from: 'neutral' }, { op: 'nudge', t: 1000, fadeMs: 200, set: { body: [0.02, 0], leftWrist: [0, -0.02] } }]);
  const deleted = applyOps(dance, [{ op: 'delete', layer: 'fix', controls: ['body'], t: 1000 }]).dance.dancers[0].layers[1].channels;
  assert.deepEqual(deleted.body.map(k => k.t), [800, 1200]);
  assert.deepEqual(deleted.leftWrist.map(k => k.t), [800, 1000, 1200]);
  const eased = applyOps(dance, [{ op: 'interp', layer: 'fix', controls: ['body'], t: 1000, ease: 'stop' }]).dance.dancers[0].layers[1].channels;
  assert.equal(eased.body[1].ease, 'stop');
  assert.equal(eased.leftWrist[1].ease, undefined);
});
test('a pose mirrored from another dancer lands at this dancer\'s home', () => {
  const dance = danceWith([{ op: 'pose', dancer: 'P1', t: 0, from: 'neutral' }, { op: 'key', dancer: 'P1', t: 0, set: { leftWrist: [0.4, 0.3] } },
    { op: 'pose', dancer: 'P2', t: 0, from: { dancer: 'P1', t: 0 }, mirror: 'self' }], { dancers: 2 });
  const p2 = createEvaluator(dance, dance.dancers[1]).rig(0).points;
  const hips = (p2.leftHip[0] + p2.rightHip[0]) / 2;
  assert.ok(Math.abs(hips - dance.dancers[1].home[0]) < 1e-3, `hips at ${hips}`);
  // P1's left wrist was 0.15 to image right of its hips; mirrored, P2's right wrist is 0.15 to the left of its own.
  assert.ok(Math.abs(p2.rightWrist[0] - (hips - 0.15)) < 2e-3, `${p2.rightWrist[0]}`);
});
test('a resampled draft keeps depth', () => {
  const source = danceWith([{ op: 'pose', t: 0, from: 'neutral' }, { op: 'key', t: 1000, set: { turn: 35 } }], { durationMs: 2000 });
  const { dance, ctx } = withTracking(danceWith([], { durationMs: 2000 }), trackingOf(source));
  const drafted = applyOps(dance, [{ op: 'draft', depth: true, everyMs: 250, fitBody: false }], ctx).dance;
  const z = (drafted.dancers[0].layers[0].channels.leftShoulder as AnyKey[]).map(k => Math.abs((k.v as number[])[2] ?? 0));
  assert.ok(Math.max(...z) > 0.01, `max |z| ${Math.max(...z)}`);
});
test('mirroring a dancer mirrors what its layers add too', () => {
  const dance = danceWith([{ op: 'pose', t: 0, from: 'neutral' }, { op: 'nudge', t: 500, fadeMs: 0, set: { leftWrist: [0.08, 0] } }]);
  const before = createEvaluator(dance, dance.dancers[0]).rig(500).points;
  const about = dance.dancers[0].home[0];
  const mirrored = applyOps(dance, [{ op: 'mirror', about: 'self' }]).dance;
  const after = createEvaluator(mirrored, mirrored.dancers[0]).rig(500).points;
  assert.ok(Math.abs(after.rightWrist[0] - (2 * about - before.leftWrist[0])) < 1e-4, `${after.rightWrist[0]} vs ${2 * about - before.leftWrist[0]}`);
  assert.ok(Math.abs(after.leftWrist[0] - (2 * about - before.rightWrist[0])) < 1e-4);
});
test('simplify stays within its tolerance and handles long drafts quickly', () => {
  const keys: AnyKey[] = Array.from({ length: 2700 }, (_, i) => ({ t: i * 66.7, v: [0.5 + 0.1 * Math.sin(i / 7) + 0.03 * Math.sin(i / 2.3), 0.4 + 0.08 * Math.cos(i / 5)] } as AnyKey));
  const started = performance.now();
  const simple = simplifyKeys(keys, [-Infinity, Infinity], 0.006, 16 / 9);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 5000, `took ${elapsed.toFixed(0)} ms`);
  assert.ok(simple.length < keys.length * 0.8);
  const curve = (list: AnyKey[]) => list.map(k => ({ t: k.t, v: k.v as number[], interp: k.interp, ease: k.ease }));
  const a = curve(keys), b = curve(simple);
  let worst = 0;
  for (let t = 0; t <= keys[keys.length - 1].t; t += 7) worst = Math.max(worst, dist(evaluate(a, t), evaluate(b, t)));
  assert.ok(worst <= 0.006 * 1.02, `worst ${worst}`);
});
test('a song keeps its id when only its details change, and installing replaces the last install', async t => {
  const dir = await tempDir(t), project = await initProject(path.join(dir, 'p'), { dancers: 1, durationMs: 3000, title: 'T', artist: 'A' });
  await writeFile(path.join(dir, 'a.wav'), wav(3000));
  await attachSources(project, { audio: path.join(dir, 'a.wav') });
  await project.apply({ ops: [{ op: 'pose', t: 0, from: 'neutral' }] });
  const first = await songBundle(project, await project.read());
  await project.apply({ ops: [{ op: 'song', set: { description: 'Now with a description' } }] });
  const second = await songBundle(project, await project.read());
  assert.equal(second.songId, first.songId);
  const songs = path.join(dir, 'songs');
  await mkdir(songs);
  const a = await installBundle(first, songs, project);
  await project.apply({ ops: [{ op: 'key', t: 500, set: { leftWrist: { dy: -0.1 } } }] });
  const moved = await songBundle(project, await project.read());
  assert.notEqual(moved.songId, first.songId);
  await installBundle(moved, songs, project);
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual(await readdir(songs), [moved.songId], `${a} was replaced`);
});
test('the CLI refuses steps and sheets it can\'t make', async t => {
  const dir = await tempDir(t), project = path.join(dir, 'p');
  await initProject(project, { dancers: 1, durationMs: 4000 });
  await assert.rejects(main(['sample', project, '--range', '0:1000', '--every', '0']), /--every must be at least 1 ms/);
  await assert.rejects(main(['frames', project, '--range', '0:4000', '--every', '50']), /That's 81 frames; a sheet holds at most 48/);
  void DanceProject;
});

// ---- The second review ----

test('a linear move into a held value doesn\'t dip past it', () => {
  const keys = [{ t: 0, v: [0.5], interp: 'linear' as const }, { t: 500, v: [0.3] }, { t: 1000, v: [0.3] }];
  for (let t = 500; t <= 1000; t += 5) assert.ok(evaluate(keys, t)[0] >= 0.3 - 1e-12, `${t}: ${evaluate(keys, t)[0]}`);
});
test('smooth, simplify and retime reach an additive layer\'s group channel, and retime can keep to one layer', () => {
  const ops: unknown[] = [{ op: 'pose', t: 0, from: 'neutral' }, { op: 'layer', action: 'add', id: 'fix' }];
  for (let i = 0; i <= 20; i++) ops.push({ op: 'key', layer: 'fix', t: i * 50, set: { body: [0.01 * Math.sin(i), 0] } });
  ops.push({ op: 'key', t: 1000, set: { leftWrist: { dy: -0.1 } } }, { op: 'key', layer: 'fix', t: 1000, set: { leftWrist: [0.01, 0] } });
  const dance = danceWith(ops);
  const smoothed = applyOps(dance, [{ op: 'smooth', layer: 'fix', controls: ['body'], windowMs: 200 }]).dance;
  assert.notDeepEqual(smoothed.dancers[0].layers[1].channels.body, dance.dancers[0].layers[1].channels.body);
  const simple = applyOps(dance, [{ op: 'simplify', layer: 'fix', tolerance: 0.5 }]).dance;
  assert.ok(simple.dancers[0].layers[1].channels.body.length < 21);
  const moved = applyOps(dance, [{ op: 'retime', layer: 'base', range: '999:1001', controls: ['leftWrist'], shift: 100 }]).dance.dancers[0].layers;
  assert.ok(moved[0].channels.leftWrist.some(k => k.t === 1100));
  assert.ok(moved[1].channels.leftWrist.some(k => k.t === 1000), 'the additive key stays put');
});
test('draft refuses steps too small to make', () => {
  const { dance, ctx } = withTracking(danceWith([], { durationMs: 2000 }), trackingOf(danceWith([{ op: 'pose', t: 0, from: 'neutral' }], { durationMs: 2000 })));
  assert.throws(() => applyOps(dance, [{ op: 'draft', everyMs: -5 }], ctx), /everyMs must be at least 1 ms/);
  assert.throws(() => applyOps(dance, [{ op: 'draft', everyMs: 0.01 }], ctx), /everyMs must be at least 1 ms/);
});
test('sources are copies named by content: undoing an attach can still export', async t => {
  const dir = await tempDir(t), project = await initProject(path.join(dir, 'p'), { dancers: 1, durationMs: 3000, title: 'T', artist: 'A' });
  const a = path.join(dir, 'a.wav'), b = path.join(dir, 'b.wav');
  await writeFile(a, wav(3000)); await writeFile(b, wav(2500));
  await attachSources(project, { audio: a });
  const { stat } = await import('node:fs/promises');
  const first = (await project.read()).sources.audio!;
  assert.notEqual((await stat(a)).ino, (await stat(project.resolve(first.path))).ino, 'a copy, not a link to the original');
  await writeFile(a, wav(1000)); // the original changes afterwards; the project's copy doesn't
  await attachSources(project, { audio: b });
  await project.step('undo');
  await project.apply({ ops: [{ op: 'pose', t: 0, from: 'neutral' }] });
  const bundle = await songBundle(project, await project.read());
  assert.ok(bundle.songId);
});
test('renaming a dancer or adding a phrase keeps the song id', async t => {
  const dir = await tempDir(t), project = await initProject(path.join(dir, 'p'), { dancers: 1, durationMs: 3000, title: 'T', artist: 'A' });
  await writeFile(path.join(dir, 'a.wav'), wav(3000));
  await attachSources(project, { audio: path.join(dir, 'a.wav') });
  await project.apply({ ops: [{ op: 'pose', t: 0, from: 'neutral' }] });
  const before = (await songBundle(project, await project.read())).songId;
  await project.apply({ ops: [{ op: 'dancer', dancer: 'P1', label: 'Lead' }, { op: 'phrase', label: 'Verse', start: 0, end: 1000 }, { op: 'marker', t: 500 }] });
  assert.equal((await songBundle(project, await project.read())).songId, before);
});
test('changing only authored character motion changes song identity, and removing it restores the original identity', async t => {
  const dir = await tempDir(t), project = await initProject(path.join(dir, 'p'), { dancers: 1, durationMs: 3000, title: 'Test routine', artist: 'Test' });
  await writeFile(path.join(dir, 'a.wav'), wav(3000));
  await attachSources(project, { audio: path.join(dir, 'a.wav') });
  const original = (await songBundle(project, await project.read())).songId;
  const keys = [{ t: 0, pose: neutralCharacterPose() }, { t: 1000, pose: neutralCharacterPose() }];
  await project.apply({ ops: [{ op: 'performance', dancer: 'P1', id: 'reach', start: 0, end: 1000, keys }] });
  const first = (await songBundle(project, await project.read())).songId;
  assert.notEqual(first, original);
  assert.equal((await songBundle(project, await project.read())).songId, first);
  keys[1].pose.leftHand = [1.2, 3.7, .6];
  await project.apply({ ops: [{ op: 'performance', dancer: 'P1', id: 'reach', start: 0, end: 1000, keys }] });
  assert.notEqual((await songBundle(project, await project.read())).songId, first);
  await project.apply({ ops: [{ op: 'performance', dancer: 'P1', id: 'reach', action: 'remove' }] });
  assert.equal((await songBundle(project, await project.read())).songId, original);
});

test('the CLI\'s revision checks and range errors say what\'s wrong', async t => {
  const dir = await tempDir(t), project = path.join(dir, 'p');
  await initProject(project, { dancers: 1, durationMs: 4000 });
  await new DanceProject(project).apply({ ops: [{ op: 'key', t: 0, set: { headYaw: 1 } }] });
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    assert.equal(await main(['undo', project, '--expect-revision', '0']), 3);
    await assert.rejects(main(['apply', project, '--op', '{"op":"song","set":{"title":"x"}}', '--expect-revision', 'abc']), /takes a revision number, not "abc"/);
    await assert.rejects(main(['keys', project, '--range', 'b1:b4']), /need the song bpm/);
  } finally { process.stdout.write = write; }
});
