import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { makeZip, readZip } from '../../../packages/pose/zip.ts';
import { customScoreId, importSongZip, listCustomSongs, listSavedSongs, loadCustomSong, readSongZip, removeCustomSong } from '../src/songs/customSongs.ts';
import type { CustomSongRecord, CustomSongStore } from '../src/songs/customSongs.ts';
import { appSongsStore, pickAppSongs } from '../src/songs/appSongs.ts';
import type { AppSongsOptions } from '../src/songs/appSongs.ts';
import type { PickedSong } from '../src/host.ts';
import { bundleFixture, choreographyBytes } from './fixtures/songBundle.ts';
import type { BundleFixture } from './fixtures/songBundle.ts';
import { neutralCharacterPose } from '../../../packages/pose/performance.ts';
import type { Performance } from '../../../packages/pose/performance.ts';

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** A song's export files (song.json, choreography, audio, checksums.json) by bundle path. */
function bundleFiles(fixture: BundleFixture = bundleFixture(), performance?: Performance) {
  if (performance) fixture.song.performance = { path: 'performance.json', schemaVersion: 1 };
  const files = new Map<string, Uint8Array>([
    ['song.json', encode(fixture.song)], ['choreography.adpose', choreographyBytes(fixture)], ['audio.wav', fixture.audio],
  ]);
  if (performance) files.set('performance.json', encode(performance));
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

test('an imported ZIP retains authored character motion when the saved song is loaded again', async () => {
  const performance: Performance = { schema: 'aerodance.performance', schemaVersion: 1, tracks: [{ clips: [
    { id: 'reach', startMs: 100, endMs: 700, keys: [
      { t: 100, pose: neutralCharacterPose() },
      { t: 700, pose: { ...neutralCharacterPose(), leftHand: [1.2, 3.7, .6] } },
    ] },
  ] }] };
  const store = memoryStore();
  const imported = await importSongZip(exportZip(bundleFiles(bundleFixture({ dancers: 1 }), performance)), { store });
  assert.equal(imported.status, 'imported');
  assert.ok(store.files.get(imported.entry.id)?.has('performance.json'));
  const [saved] = await listCustomSongs(store);
  assert.deepEqual((await loadCustomSong(saved, { store })).performance, performance);
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

test('lists saved songs by title; Song Select leaves out damaged ones, Settings marks them', async () => {
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
  // Settings lists it still, as damaged, so it can be removed.
  const saved = await listSavedSongs(store, () => {});
  assert.deepEqual(saved.map(({ entry, damaged }) => [entry.id, damaged]), [['apple', false], ['mango', true], ['zebra', false]]);
  assert.equal(await removeCustomSong(saved[1].entry, store), true);
  assert.deepEqual((await listSavedSongs(store, () => {})).map(({ entry }) => entry.id), ['apple', 'zebra']);
  // A damaged record missing its title lists under its ID, and still removes.
  const { title: _, ...untitled } = store.records.get('zebra')!.entry;
  Object.assign(store.records.get('zebra')!, { entry: untitled });
  store.records.get('zebra')!.sizes.delete('audio.wav');
  const damaged = await listSavedSongs(store, () => {});
  assert.deepEqual(damaged.map(({ entry, damaged: broken }) => [entry.title, broken]), [['Apple pie', false], ['zebra', true]]);
  assert.deepEqual((await listCustomSongs(store, () => {})).map((song) => song.id), ['apple']);
  assert.equal(await removeCustomSong(damaged[1].entry, store), true);
  // A song replaced since it was listed doesn't load as the old revision.
  const [apple] = await listCustomSongs(store, () => {});
  const fixture = bundleFixture();
  Object.assign(fixture.song, { songId: 'apple', title: 'Apple pie', bundleRevision: 2 });
  fixture.choreography.songId = 'apple';
  await importSongZip(exportZip(bundleFiles(fixture), { folder: 'apple' }), { store });
  await assert.rejects(loadCustomSong(apple, { store }), /revision mismatch|hash mismatch/);
});

/** The iPhone/iPad app's song folder as main.m serves it under /app/songs/, and the requests it was sent. */
function appFolder(key = 'launch-key') {
  const files = new Map<string, { bytes: Uint8Array; modified: number }>();
  const requests: string[] = [];
  let clock = Date.parse('2026-10-23T00:00:00Z');
  const fetcher = async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    requests.push(`${method} ${url}`);
    if (new Headers(init.headers).get('x-aerodance-key') !== key) return new Response(null, { status: 403 });
    const listed = (name: string) => ({ name, size: files.get(name)!.bytes.length, modified: files.get(name)!.modified });
    if (url === '/app/songs/') return Response.json({ files: [...files.keys()].map(listed) });
    const name = decodeURIComponent(url.slice('/app/songs/'.length));
    if (method === 'PUT') {
      files.set(name, { bytes: new Uint8Array(await new Response(init.body).arrayBuffer()), modified: clock++ });
      return Response.json(listed(name));
    }
    if (method === 'DELETE') return new Response(null, { status: files.delete(name) ? 204 : 404 });
    const file = files.get(name);
    return file ? new Response(file.bytes as Uint8Array<ArrayBuffer>) : new Response(null, { status: 404 });
  };
  // A ZIP saved to the folder from the Files app.
  const drop = async (name: string, zip: Blob) => { files.set(name, { bytes: new Uint8Array(await zip.arrayBuffer()), modified: clock++ }); };
  const kept = new Map<string, string>();
  const cache = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => { kept.set(k, v); } };
  const store = (options: Partial<AppSongsOptions> = {}) => appSongsStore({ key, fetcher, cache, warn: () => {}, listKeepMs: 0, ...options });
  // How many times each ZIP was read whole.
  const reads = () => requests.filter((r) => r.startsWith('GET /app/songs/') && r !== 'GET /app/songs/').length;
  return { files, requests, fetcher, drop, store, reads };
}

test('in the app, an import is saved to its folder as Dance Studio exports it, and loads from there', async () => {
  const folder = appFolder(), store = folder.store();
  const result = await importSongZip(exportZip(bundleFiles(), { folder: 'fixture 2', extra: { '__MACOSX/fixture 2/._song.json': new Uint8Array([2]) } }), { store });
  assert.equal(result.status, 'imported');
  assert.deepEqual([...folder.files.keys()], ['fixture-r1.aerodance-song.zip']);
  const zip = await readZip(folder.files.get('fixture-r1.aerodance-song.zip')!.bytes);
  assert.deepEqual([...zip.keys()].sort(), ['fixture/audio.wav', 'fixture/checksums.json', 'fixture/choreography.adpose', 'fixture/song.json']);
  const [entry] = await listCustomSongs(store);
  assert.deepEqual(entry, result.entry);
  const bundle = await loadCustomSong(entry, { store });
  assert.equal(bundle.scoreId, 'custom:fixture');
  assert.equal(bundle.audio.size, bundleFixture().audio.length);
  // Saving told the store what the ZIP holds, so listing hasn't read it whole; loading did, once.
  assert.equal(folder.reads(), 1);
  // Every request carries the app's key.
  await assert.rejects(listCustomSongs(folder.store({ key: 'another app' })), /aren't available in this app \(403\)/);
});

test('in the app, ZIPs saved to its folder from Files list, each read once until it changes', async () => {
  const folder = appFolder();
  await folder.drop('My song.zip', exportZip(bundleFiles(), { folder: 'fixture 2' }));
  await folder.drop('notes.zip', new Blob([makeZip(new Map([['readme.txt', new Uint8Array([1])]]))]));
  await folder.drop('broken.zip', new Blob(['not a zip']));
  const store = folder.store();
  const listed = async (s = store) => (await listSavedSongs(s, () => {})).map(({ entry, damaged }) => [entry.id, entry.title, damaged]);
  // A ZIP that isn't a song lists by its file name, damaged, to remove.
  const all = [['zip:broken.zip', 'broken.zip', true], ['fixture', 'Fixture routine', false], ['zip:notes.zip', 'notes.zip', true]];
  assert.deepEqual(await listed(), all);
  assert.equal(folder.reads(), 3);
  assert.deepEqual(await listed(), all);
  // What each holds is kept for the next launch too.
  assert.deepEqual(await listed(folder.store()), all);
  assert.equal(folder.reads(), 3);
  // A ZIP changed in Files is read again.
  await folder.drop('My song.zip', exportZip(revised(2), { folder: 'fixture' }));
  assert.equal((await listCustomSongs(store))[0].bundleRevision, 2);
  assert.equal(folder.reads(), 4);
  // Removing a damaged one deletes its file.
  const [broken] = await listSavedSongs(store, () => {});
  assert.equal(await removeCustomSong(broken.entry, store), true);
  assert.deepEqual([...folder.files.keys()].sort(), ['My song.zip', 'notes.zip']);
});

test('in the app, two ZIPs of one song list as the later revision, and removing or importing it takes both', async () => {
  const folder = appFolder(), store = folder.store();
  await folder.drop('first.zip', exportZip(revised(1)));
  await folder.drop('second.zip', exportZip(revised(2)));
  assert.deepEqual((await listCustomSongs(store)).map((song) => song.bundleRevision), [2]);
  assert.equal((await importSongZip(exportZip(revised(3)), { store })).status, 'replaced');
  assert.deepEqual([...folder.files.keys()], ['fixture-r3.aerodance-song.zip']);
  await folder.drop('old.zip', exportZip(revised(1)));
  const [song] = await listCustomSongs(store);
  assert.equal(song.bundleRevision, 3);
  assert.equal(await removeCustomSong(song, store), true);
  assert.deepEqual([...folder.files.keys()], []);
});

test("in the app, the picker's ZIPs are read with the key when they're imported, and the app's copies deleted", async () => {
  const requests: string[] = [];
  const zip = exportZip();
  const fetcher = async (url: string, init: RequestInit = {}) => {
    requests.push(`${init.method ?? 'GET'} ${url} ${new Headers(init.headers).get('x-aerodance-key')}`);
    if (url.endsWith('/gone.zip')) return new Response(null, { status: 404 });
    return new Response(init.method === 'DELETE' ? null : zip);
  };
  const songs = (picked: PickedSong[]) => ({ key: 'k', pick: async () => picked });
  assert.deepEqual(await pickAppSongs(songs([]), fetcher), []);
  const files = await pickAppSongs(songs([
    { url: '/app/incoming/1.zip', name: 'fixture-r1.aerodance-song.zip' },
    { url: '/app/incoming/gone.zip', name: 'gone.aerodance-song.zip' },
    { url: '/app/incoming/2.zip', name: 'other-r1.aerodance-song.zip' },
  ]), fetcher);
  assert.deepEqual(files.map((file) => file.name), ['fixture-r1.aerodance-song.zip', 'gone.aerodance-song.zip', 'other-r1.aerodance-song.zip']);
  assert.deepEqual(requests, []);
  const first = await files[0].read();
  assert.equal(first.size, zip.size);
  await assert.rejects(files[1].read(), /gone\.aerodance-song\.zip couldn't be opened/);
  assert.equal((await files[2].read()).size, zip.size);
  await new Promise((resolve) => setTimeout(resolve));
  assert.deepEqual(requests.sort(), ['DELETE /app/incoming/1.zip k', 'DELETE /app/incoming/2.zip k', 'GET /app/incoming/1.zip k', 'GET /app/incoming/2.zip k', 'GET /app/incoming/gone.zip k']);
});
