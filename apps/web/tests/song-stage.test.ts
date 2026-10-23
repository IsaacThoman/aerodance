import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateCatalog, validateSong } from '../../../packages/pose/song.ts';
import { DEFAULT_STAGE, STAGE_LIST, resolveStage } from '../../../packages/stages/catalog.ts';
import { coachesFor, routineCast } from '../../../packages/stages/shared/routine.ts';
import { discoverSongs } from '../../../scripts/songCatalog.ts';
import { bundleFixture, choreographyBytes } from './fixtures/songBundle.ts';

test('the stage catalog lists the six dance stages and defaults to openreef', () => {
  assert.deepEqual(STAGE_LIST.map((stage) => stage.id), ['sanctuary', 'reef', 'openreef', 'falls', 'club', 'beach']);
  assert.equal(DEFAULT_STAGE, 'openreef');
  assert.equal(resolveStage('club'), 'club');
  assert.equal(resolveStage(undefined), 'openreef');
  assert.equal(resolveStage('moon'), 'openreef');
});

test('the stage shows every dancer of a song, once per player dancing them or once for nobody', () => {
  const coach = (dancer: number, player: number | null) => ({ dancer, player });
  assert.deepEqual(coachesFor([0, 1], 2), [coach(0, 0), coach(1, 1)]);
  // One player of a duet sees the partner too; four see it danced in pairs.
  assert.deepEqual(coachesFor([0], 2), [coach(0, 0), coach(1, null)]);
  assert.deepEqual(coachesFor([0, 0, 1, 1], 2), [coach(0, 0), coach(0, 1), coach(1, 2), coach(1, 3)]);
  // Picks put each player's coach at their dancer, the rest standing by in dancer order.
  assert.deepEqual(coachesFor([2], 4), [coach(0, null), coach(1, null), coach(2, 0), coach(3, null)]);
  assert.deepEqual(coachesFor([1, 0], 2), [coach(0, 1), coach(1, 0)]);
  assert.equal(coachesFor([1, 1, 1, 1], 4).length, 7);
  // A routine without a cast is cast by where the players stand.
  const { song, choreography } = bundleFixture(3);
  const bundle = { song, choreography: { tracks: choreography.tracks } } as unknown as Parameters<typeof routineCast>[0]['bundle'];
  assert.deepEqual(routineCast({ bundle, playerCount: 4, timeMs: () => 0 }), [0, 0, 1, 2]);
  assert.deepEqual(routineCast({ bundle, playerCount: 2, cast: [2, 2], timeMs: () => 0 }), [2, 2]);
});

test('songs and catalog entries may name a stage by id', () => {
  const { song, entry } = bundleFixture();
  assert.equal(validateSong({ ...song, stage: 'club' }).stage, 'club');
  // An id this build doesn't know is still valid; the game falls back to openreef.
  validateSong({ ...song, stage: 'moon-base' });
  assert.throws(() => validateSong({ ...song, stage: 'Not A Stage' }), /stage/);
  assert.throws(() => validateSong({ ...song, stage: 4 }), /stage/);
  validateCatalog({ version: 1, songs: [{ ...entry, stage: 'beach' }] });
  assert.throws(() => validateCatalog({ version: 1, songs: [{ ...entry, stage: '' }] }), /stage/);
});

test('discovered songs carry their stage into the catalog', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'aerodance-stage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { song, choreography, audio } = bundleFixture();
  song.stage = 'falls';
  const folder = path.join(root, song.songId);
  await mkdir(folder);
  const files = { 'song.json': Buffer.from(JSON.stringify(song)), 'choreography.adpose': Buffer.from(choreographyBytes({ choreography })), 'audio.wav': audio };
  for (const [name, bytes] of Object.entries(files)) await writeFile(path.join(folder, name), bytes);
  await writeFile(path.join(folder, 'checksums.json'), JSON.stringify({
    schema: 'aerodance.checksums', schemaVersion: 1,
    files: Object.entries(files).map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })),
  }));
  assert.equal((await discoverSongs(root)).songs[0].stage, 'falls');
});
