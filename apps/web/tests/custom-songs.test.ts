import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { makeZip, readZip } from '../../../packages/pose/zip.ts';
import { customScoreId, importSongZip, listCustomSongs, loadCustomSong, readSongZip, removeCustomSong } from '../src/songs/customSongs.ts';
import type { CustomSongRecord, CustomSongStore } from '../src/songs/customSongs.ts';
import { bundleFixture, choreographyBytes } from './fixtures/songBundle.ts';
import type { BundleFixture } from './fixtures/songBundle.ts';

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** A song's export files (song.json, choreography, audio, checksums.json) by bundle path. */
function bundleFiles(fixture: BundleFixture = bundleFixture()) {
  const files = new Map<string, Uint8Array>([
    ['song.json', encode(fixture.song)], ['choreography.adpose', choreographyBytes(fixture)], ['audio.wav', fixture.audio],
  ]);
  files.set('checksums.json', encode({ schema: 'aerodance.checksums', schemaVersion: 1, files: [...files].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha(bytes) })) }));
  return files;
}
/** A ZIP like Dance Studio's export: everything in one <folder>/ (none: at the top level), plus extras. */
function exportZip(files = bundleFiles(), { folder = 'fixture', extra = {} }: { folder?: string; extra?: Record<string, Uint8Array> } = {}) {
  const prefix = folder ? `${folder}/` : '';
  const entries = new Map([...files].map(([path, bytes]) => [prefix + path, bytes]));
  for (const [path, bytes] of Object.entries(extra)) entries.set(path, bytes);
  return new Blob([makeZip(entries)]);
}
function memoryStore(): CustomSongStore & { records: Map<string, CustomSongRecord>; files: Map<string, Map<string, Uint8Array<ArrayBuffer>>> } {
  const records = new Map<string, CustomSongRecord>(), files = new Map<string, Map<string, Uint8Array<ArrayBuffer>>>();
  return {
    records, files,
    all: async () => [...records.values()],
    get: async (id) => records.get(id),
    file: async (id, path) => files.get(id)?.get(path),
    put: async (record, contents) => { records.set(record.id, record); files.set(record.id, new Map(contents)); },
    delete: async (id, only) => {
      const saved = records.get(id);
      if (!saved || (only && (saved.entry.bundleRevision !== only.bundleRevision || saved.entry.sha256 !== only.sha256))) return false;
      records.delete(id);
      files.delete(id);
      return true;
    },
  };
}
const revised = (revision: number) => {
  const fixture = bundleFixture();
  fixture.song.bundleRevision = revision;
  return bundleFiles(fixture);
};

test('imports a Dance Studio export, lists it and loads it with its own best-score key', async () => {
  const store = memoryStore();
  const zip = exportZip(bundleFiles(), { extra: {
    'fixture/notes.txt': new Uint8Array([1]), '__MACOSX/fixture/._song.json': new Uint8Array([2]), 'fixture/.DS_Store': new Uint8Array([3]),
  } });
  const result = await importSongZip(zip, { store });
  assert.equal(result.status, 'imported');
  assert.equal(result.entry.id, 'fixture');
  // Only what checksums.json lists is kept.
  assert.deepEqual([...store.files.get('fixture')!.keys()].sort(), ['audio.wav', 'checksums.json', 'choreography.adpose', 'song.json']);
  assert.equal(store.records.get('fixture')!.sizes.get('audio.wav'), bundleFixture().audio.length);
  const [entry] = await listCustomSongs(store);
  assert.deepEqual(entry, result.entry);
  const bundle = await loadCustomSong(entry, { store });
  assert.equal(bundle.song.songId, 'fixture');
  assert.equal(bundle.scoreId, customScoreId('fixture'));
  assert.equal(bundle.scoreId, 'custom:fixture');
  assert.equal(bundle.audio.size, bundleFixture().audio.length);
  // Removing only removes the copy listed: not one another tab put in its place.
  assert.equal(await removeCustomSong({ ...entry, bundleRevision: entry.bundleRevision + 1 }, store), false);
  assert.equal(await removeCustomSong(entry, store), true);
  assert.deepEqual(await listCustomSongs(store), []);
  assert.equal(await removeCustomSong(entry, store), false);
});

test('replacing asks first unless the import is a later revision', async () => {
  const store = memoryStore();
  const asked: [number, number][] = [];
  const confirm = (answer: boolean) => (saved: { bundleRevision: number }, incoming: { bundleRevision: number }) => {
    asked.push([saved.bundleRevision, incoming.bundleRevision]);
    return answer;
  };
  assert.equal((await importSongZip(exportZip(revised(2)), { store, confirmReplace: confirm(false) })).status, 'imported');
  assert.deepEqual(asked, []);
  const kept = await importSongZip(exportZip(revised(2)), { store, confirmReplace: confirm(false) });
  assert.deepEqual([kept.status, kept.previousRevision], ['kept', 2]);
  assert.deepEqual(asked, [[2, 2]]);
  const older = await importSongZip(exportZip(revised(1)), { store, confirmReplace: confirm(false) });
  assert.equal(older.status, 'kept');
  assert.equal(store.records.get('fixture')?.entry.bundleRevision, 2);
  const forced = await importSongZip(exportZip(revised(1)), { store, confirmReplace: confirm(true) });
  assert.deepEqual([forced.status, forced.previousRevision], ['replaced', 2]);
  assert.equal(store.records.get('fixture')?.entry.bundleRevision, 1);
  asked.length = 0;
  const later = await importSongZip(exportZip(revised(3)), { store, confirmReplace: confirm(false) });
  assert.equal(later.status, 'replaced');
  assert.deepEqual(asked, []);
  // By default an import never replaces the same revision...
  assert.equal((await importSongZip(exportZip(revised(3)), { store })).status, 'kept');
  // ...unless the saved copy no longer checks out (so isn't listed): then it's replaced unasked.
  store.records.get('fixture')!.sizes.delete('checksums.json');
  asked.length = 0;
  assert.equal((await importSongZip(exportZip(revised(3)), { store, confirmReplace: confirm(false) })).status, 'replaced');
  assert.deepEqual(asked, []);
  assert.equal((await listCustomSongs(store)).length, 1);
});

test('accepts a song at the top level, in a folder of any name, and the folder entries a Finder ZIP has', async () => {
  const store = memoryStore();
  assert.equal((await importSongZip(exportZip(bundleFiles(), { folder: '' }), { store })).entry.id, 'fixture');
  // The Finder names a second copy "fixture 2"; song.json still names the song.
  assert.equal((await importSongZip(exportZip(bundleFiles(), { folder: 'fixture 2' }), { store, confirmReplace: () => true })).entry.id, 'fixture');
  assert.equal(store.records.size, 1);
  // makeZip refuses folder entries, so rename a same-length placeholder to "fixture/".
  const zip = makeZip(new Map([['fixture_', new Uint8Array()], ...[...bundleFiles()].map(([path, bytes]): [string, Uint8Array] => [`fixture/${path}`, bytes])]));
  const placeholder = new TextEncoder().encode('fixture_');
  for (let i = 0; i + placeholder.length <= zip.length; i++) {
    if (placeholder.every((byte, j) => zip[i + j] === byte)) zip[i + placeholder.length - 1] = '/'.charCodeAt(0);
  }
  assert.ok((await readZip(zip)).has('fixture/song.json'));
  assert.equal((await readSongZip(new Blob([zip]))).files.size, 4);
  assert.equal((await importSongZip(new Blob([zip]), { store, confirmReplace: () => true })).status, 'replaced');
});

test('refuses anything that is not one playable exported song, saving nothing', async () => {
  const store = memoryStore();
  const refuse = (zip: Blob, pattern: RegExp) => assert.rejects(importSongZip(zip, { store }), pattern);
  await refuse(new Blob(['not a zip']), /readable song ZIP/);
  await refuse(new Blob([makeZip(new Map([['project.json', encode({})]]))]), /project backup/);
  await refuse(new Blob([makeZip(new Map([['dance/project.json', encode({})]]))]), /project backup/);
  await refuse(new Blob([makeZip(new Map([['fixture/song.json', new TextEncoder().encode('nope')]]))]), /song\.json can't be read/);
  await refuse(new Blob([makeZip(new Map([['fixture/readme.txt', new Uint8Array([1])]]))]), /no song\.json/);
  await refuse(exportZip(bundleFiles(), { extra: { 'other/song.json': encode({}) } }), /more than one song/);
  const renamed = bundleFixture();
  renamed.song.songId = 'renamed';
  await refuse(exportZip(bundleFiles(renamed)), /can't be played: Song\/choreography songId mismatch/);
  const missing = bundleFiles();
  missing.delete('audio.wav');
  await refuse(exportZip(missing), /can't be played: Missing/);
  // Damaged audio of the right size passes the catalog check, but not the bundle loader's hashes.
  const damaged = bundleFiles();
  const audio = new Uint8Array(damaged.get('audio.wav')!);
  audio[60] ^= 1;
  damaged.set('audio.wav', audio);
  await refuse(exportZip(damaged), /can't be played: Song integrity check failed: audio\.wav/);
  // Choreography that doesn't match song.json.
  const other = bundleFixture();
  other.choreography.durationMs = 2000;
  const mismatched = bundleFiles();
  const choreography = choreographyBytes(other);
  mismatched.set('choreography.adpose', choreography);
  mismatched.set('checksums.json', encode({ schema: 'aerodance.checksums', schemaVersion: 1, files: [...mismatched].filter(([path]) => path !== 'checksums.json').map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha(bytes) })) }));
  await refuse(exportZip(mismatched), /can't be played/);
  assert.equal(store.records.size, 0);
});

test('lists saved songs by title and leaves out damaged ones', async () => {
  const store = memoryStore();
  const titled = (songId: string, title: string) => {
    const fixture = bundleFixture();
    Object.assign(fixture.song, { songId, title });
    fixture.choreography.songId = songId;
    return exportZip(bundleFiles(fixture), { folder: songId });
  };
  await importSongZip(titled('zebra', 'Zebra crossing'), { store });
  await importSongZip(titled('apple', 'Apple pie'), { store });
  await importSongZip(titled('mango', 'Mango tango'), { store });
  assert.deepEqual((await listCustomSongs(store)).map((song) => song.id), ['apple', 'mango', 'zebra']);
  store.records.get('mango')!.sizes.delete('audio.wav');
  const warnings: string[] = [];
  assert.deepEqual((await listCustomSongs(store, (message) => warnings.push(message))).map((song) => song.id), ['apple', 'zebra']);
  assert.match(warnings.join('\n'), /mango/);
  // A song replaced since it was listed doesn't load as the old revision.
  const [apple] = await listCustomSongs(store, () => {});
  const fixture = bundleFixture();
  Object.assign(fixture.song, { songId: 'apple', title: 'Apple pie', bundleRevision: 2 });
  fixture.choreography.songId = 'apple';
  await importSongZip(exportZip(bundleFiles(fixture), { folder: 'apple' }), { store });
  await assert.rejects(loadCustomSong(apple, { store }), /revision mismatch|hash mismatch/);
});
