import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateCatalog, validateSong } from '../../../packages/pose/song.ts';
import { DEFAULT_STAGE, STAGE_LIST, isStageId, replaceRemovedStage, resolveStage } from '../../../packages/stages/catalog.ts';
import { discoverSongs } from '../../../scripts/songCatalog.ts';
import { bundleFixture, choreographyBytes } from './fixtures/songBundle.ts';

test('the stage catalog lists the six dance stages and defaults to openreef', () => {
  assert.deepEqual(STAGE_LIST.map((stage) => stage.id), ['sanctuary', 'openreef', 'falls', 'club', 'beach', 'atrium']);
  assert.equal(DEFAULT_STAGE, 'openreef');
  assert.equal(resolveStage('club'), 'club');
  assert.equal(resolveStage(undefined), 'openreef');
  assert.equal(resolveStage('moon'), 'openreef');
  assert.equal(resolveStage('constructor'), 'openreef');
});

test('songs and projects on the removed reef stage play on openreef', () => {
  assert.equal(isStageId('reef'), false);
  assert.equal(resolveStage('reef'), 'openreef');
  assert.equal(replaceRemovedStage('reef'), 'openreef');
  // Anything else is left for the caller to check.
  assert.equal(replaceRemovedStage('club'), 'club');
  assert.equal(replaceRemovedStage('moon'), 'moon');
  assert.equal(replaceRemovedStage('constructor'), 'constructor');
  assert.equal(replaceRemovedStage(undefined), undefined);
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

test('a bundle saved on the removed reef stage still verifies and plays on openreef', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'aerodance-reef-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { song, entry, choreography, audio } = bundleFixture();
  song.stage = 'reef';
  // Its song.json is checksummed, so it stays as it was saved; the game maps the stage when it reads it.
  assert.equal(validateSong(structuredClone(song)).stage, 'reef');
  validateCatalog({ version: 1, songs: [{ ...entry, stage: 'reef' }] });
  const folder = path.join(root, song.songId);
  await mkdir(folder);
  const files = { 'song.json': Buffer.from(JSON.stringify(song)), 'choreography.adpose': Buffer.from(choreographyBytes({ choreography })), 'audio.wav': audio };
  for (const [name, bytes] of Object.entries(files)) await writeFile(path.join(folder, name), bytes);
  await writeFile(path.join(folder, 'checksums.json'), JSON.stringify({
    schema: 'aerodance.checksums', schemaVersion: 1,
    files: Object.entries(files).map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })),
  }));
  const [discovered] = (await discoverSongs(root)).songs;
  assert.equal(discovered.stage, 'reef');
  assert.equal(resolveStage(discovered.stage), 'openreef');
});
