import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DanceProject, RevisionConflict, attachSources, formatJson, initProject } from '../project.ts';
import { main } from '../cli.ts';
import { tempDir } from './helpers.ts';
import { readZip } from '../../../packages/pose/zip.ts';
import { validateSong, validateSongChoreography } from '../../../packages/pose/song.ts';
import { neutralCharacterPose, validatePerformance } from '../../../packages/pose/performance.ts';

/** A short stereo WAV of silence. */
function wav(ms: number, rate = 8000): Uint8Array {
  const samples = Math.round(ms * rate / 1000), data = samples * 4, out = Buffer.alloc(44 + data);
  out.write('RIFF', 0); out.writeUInt32LE(36 + data, 4); out.write('WAVEfmt ', 8); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(2, 22);
  out.writeUInt32LE(rate, 24); out.writeUInt32LE(rate * 4, 28); out.writeUInt16LE(4, 32); out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(data, 40);
  return out;
}

test('formatJson keeps keys on one line and parses back to the same value', () => {
  const value = { a: [{ t: 0, v: [0.5, 0.25] }, { t: 10, v: 3, interp: 'hold' }], b: { c: 'x', d: [1, 2, 3] }, e: [] };
  const text = formatJson(value);
  assert.deepEqual(JSON.parse(text), value);
  assert.match(text, /\{"t": 0, "v": \[0.5,0.25\]\}/);
});
test('apply writes revisions, rejects stale ones, replays retries, and undo/redo restore content', async t => {
  const dir = await tempDir(t);
  const project = await initProject(dir, { dancers: 2, durationMs: 8000 });
  const first = await project.apply({ ops: [{ op: 'pose', dancer: 'P1', t: 0, from: 'neutral' }], expectRevision: 0, opId: 'a' });
  assert.equal(first.revision, 1);
  await assert.rejects(project.apply({ ops: [{ op: 'song', set: { title: 'x' } }], expectRevision: 0 }), RevisionConflict);
  const again = await project.apply({ ops: [{ op: 'pose', dancer: 'P1', t: 0, from: 'neutral' }], opId: 'a' });
  assert.equal(again.replayed, true);
  assert.equal(again.revision, 1);
  await assert.rejects(project.apply({ ops: [{ op: 'song', set: { title: 'y' } }], opId: 'a' }), /already used for different ops/);
  await project.apply({ ops: [{ op: 'song', set: { title: 'Second' } }] });
  assert.equal((await project.read()).song.title, 'Second');
  const undone = await project.step('undo');
  assert.equal(undone?.revision, 3);
  const afterUndo = await project.read();
  assert.equal(afterUndo.song.title, '');
  assert.equal(afterUndo.dancers[0].layers[0].channels.leftWrist?.length, 1, 'undo restores the revision before the change');
  await project.step('redo');
  assert.equal((await project.read()).song.title, 'Second');
  assert.equal((await project.read()).revision, 4);
  assert.equal(await project.step('redo'), null);
  // A bad edit changes nothing.
  await assert.rejects(project.apply({ ops: [{ op: 'key', dancer: 'P9', t: 0, set: { head: [0, 0] } }] }), /Unknown dancer "P9"/);
  assert.equal((await project.read()).revision, 4);
});
test('concurrent applies are serialized by the project lock', async t => {
  const dir = await tempDir(t);
  const project = await initProject(dir, { dancers: 1, durationMs: 8000 });
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => new DanceProject(dir).apply({ ops: [{ op: 'key', t: i * 100, set: { headYaw: i } }] })));
  assert.deepEqual(results.map(r => r.revision).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal((await project.read()).dancers[0].layers[0].channels.headYaw.length, 8);
});
test('the CLI edits, reads and exports a dance the game accepts', async t => {
  const dir = await tempDir(t), project = path.join(dir, 'routine');
  const out: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
  const run = async (...args: string[]) => { out.length = 0; const code = await main(args); return { code, text: out.join('') }; };
  try {
    assert.equal((await run('init', project, '--dancers', '2', '--duration', '6s', '--title', 'Test routine', '--artist', 'Tester')).code, 0);
    const patch = path.join(dir, 'patch.json');
    await writeFile(patch, JSON.stringify({ expectRevision: 0, ops: [
      { op: 'song', set: { bpm: 100, beatOffsetMs: 200 } },
      { op: 'pose', dancer: 'P1', t: 0, from: 'neutral' }, { op: 'pose', dancer: 'P2', t: 0, from: 'neutral' },
      { op: 'key', dancer: 'P1', t: 'b3', set: { leftWrist: [0.4, 0.2], leftElbow: [0.36, 0.3] } },
      { op: 'copy', from: { dancer: 'P1', range: '0:2s' }, to: { dancer: 'P2', t: 0 }, mirror: 'frame' },
      { op: 'performance', dancer: 'P1', id: 'point', start: 0, end: '2s', keys: [
        { t: 0, pose: neutralCharacterPose() }, { t: '2s', pose: { ...neutralCharacterPose(), leftHand: [1, 3.7, .5] } },
      ] },
    ] }));
    const applied = await run('apply', project, patch);
    assert.match(applied.text, /revision 0 → 1: 6 ops, keys \+\d+/);
    const stale = await run('apply', project, '--op', '{"op":"song","set":{"title":"x"}}', '--expect-revision', '0');
    assert.equal(stale.code, 3);
    const keys = JSON.parse((await run('keys', project, '--dancer', 'P2', '--controls', 'rightWrist', '--json')).text);
    assert.deepEqual(keys[0].channels.rightWrist[1], { t: 1400, v: [0.6, 0.2] });
    const pose = JSON.parse((await run('pose', project, '--at', 'b3', '--dancer', 'P1', '--json')).text);
    assert.deepEqual(pose[0].points.leftWrist.slice(0, 2), [0.4, 0.2]);
    const blocked = main(['export', project]);
    await assert.rejects(blocked, /Add song audio/);
    const audio = path.join(dir, 'song.wav');
    await writeFile(audio, wav(6000));
    await attachSources(new DanceProject(project), { audio });
    const exported = await run('export', project, '--folder', path.join(dir, 'songs'), '--json');
    const result = JSON.parse(exported.text);
    const zip = await readZip(new Uint8Array(await readFile(result.zip)));
    const song = validateSong(JSON.parse(new TextDecoder().decode(zip.get(`${result.songId}/song.json`)!)));
    assert.equal(song.dancers, 2);
    assert.equal(song.title, 'Test routine');
    assert.equal(song.performance?.path, 'performance.json');
    const performance = validatePerformance(JSON.parse(new TextDecoder().decode(zip.get(`${result.songId}/performance.json`)!)), 2);
    assert.deepEqual(performance.tracks[0].clips[0].keys[1].pose.leftHand, [1, 3.7, .5]);
    const direct = JSON.parse((await run('pose', project, '--at', '2s', '--dancer', 'P1', '--performance', '--json')).text);
    assert.deepEqual(direct[0].performance.leftHand, [1, 3.7, .5]);
    const choreography = validateSongChoreography(song, zip.get(`${result.songId}/choreography.adpose`)!);
    assert.equal(choreography.tracks.length, 2);
    assert.equal((await readFile(path.join(dir, 'songs', result.songId, 'song.json'), 'utf8')).length > 0, true);
    // Same dance, same song ID.
    const again = JSON.parse((await run('export', project, '--json')).text);
    assert.equal(again.songId, result.songId);
    const undo = await run('undo', project);
    assert.match(undo.text, /Undid "attach audio"/);
    const help = await run('help', project);
    assert.match(help.text, /Ops: key, pose/);
  } finally { process.stdout.write = write; }
});
