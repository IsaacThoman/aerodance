import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateCatalog, validateSong } from '../../../packages/pose/song.ts';
import { DEFAULT_STAGE, STAGE_LIST, resolveStage } from '../../../packages/stages/catalog.ts';
import { discoverSongs } from '../../../scripts/songCatalog.ts';
import { bundleFixture, choreographyBytes } from './fixtures/songBundle.ts';

test('the stage catalog lists the eight dance stages and defaults to openreef', () => {
  assert.deepEqual(STAGE_LIST.map((stage) => stage.id), ['sanctuary', 'reef', 'openreef', 'falls', 'club', 'beach', 'atrium', 'pond']);
  assert.equal(DEFAULT_STAGE, 'openreef');
  assert.equal(resolveStage('club'), 'club');
  assert.equal(resolveStage(undefined), 'openreef');
  assert.equal(resolveStage('moon'), 'openreef');
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
