import test from 'node:test';
import assert from 'node:assert/strict';
import { importSongZip, listSavedSongs, loadCustomSong, removeCustomSong } from '../src/songs/customSongs.ts';
import { folderSongsStore } from '../src/songs/folderSongs.ts';
import type { AppFiles } from '../src/host.ts';
import { bundleFixture } from './fixtures/songBundle.ts';
import { bundleFiles, exportZip } from './helpers/customSongs.ts';

/** The Apple TV app's files in memory (apps/tvos/runtime/web.ts appFilesShim): full after `room` bytes. */
function memoryFiles(room = Infinity): AppFiles & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  const under = (path: string) => [...files.keys()].filter((p) => p === path || p.startsWith(`${path}/`));
  const used = () => [...files.values()].reduce((n, b) => n + b.byteLength, 0);
  return {
    files,
    read: (path) => { const b = files.get(path); return b ? b.slice().buffer : null; },
    write: (path, bytes) => {
      if (used() + bytes.byteLength > room) throw Object.assign(Error('Out of space'), { name: 'QuotaExceededError' });
      files.set(path, bytes.slice());
    },
    list: (path) => {
      const names = new Map<string, { name: string; size: number; dir: boolean }>();
      for (const p of files.keys()) {
        if (!p.startsWith(`${path}/`)) continue;
        const [name, ...rest] = p.slice(path.length + 1).split('/');
        names.set(name, { name, size: rest.length ? 0 : files.get(p)!.byteLength, dir: rest.length > 0 });
      }
      return [...names.values()];
    },
    remove: (path) => { for (const p of under(path)) files.delete(p); },
    move: (from, to) => {
      for (const p of under(to)) files.delete(p);
      for (const p of under(from)) { files.set(to + p.slice(from.length), files.get(p)!); files.delete(p); }
    },
  };
}

test('the Apple TV app keeps songs in a folder each, saved whole, listed, loaded and removed', async () => {
  const disk = memoryFiles();
  const store = folderSongsStore(disk, () => {});
  const result = await importSongZip(exportZip(), { store });
  assert.equal(result.status, 'imported');
  assert.deepEqual([...disk.files.keys()].sort(), ['songs/fixture/files/audio.wav', 'songs/fixture/files/checksums.json',
    'songs/fixture/files/choreography.adpose', 'songs/fixture/files/song.json', 'songs/fixture/record.json']);
  const [saved] = await listSavedSongs(store);
  assert.equal(saved.damaged, false);
  assert.deepEqual(saved.entry, result.entry);
  const bundle = await loadCustomSong(saved.entry, { store });
  assert.equal(bundle.audio.size, bundleFixture().audio.length);
  // Another revision replaces it in place.
  const fixture = bundleFixture();
  fixture.song.bundleRevision = 2;
  assert.equal((await importSongZip(exportZip(bundleFiles(fixture)), { store })).status, 'replaced');
  assert.equal((await store.get('fixture'))!.entry.bundleRevision, 2);
  assert.equal(await removeCustomSong(saved.entry, store), false, 'not the copy listed');
  assert.equal(await removeCustomSong((await store.get('fixture'))!.entry, store), true);
  assert.deepEqual(await listSavedSongs(store), []);
  assert.equal(disk.files.size, 0);
});

test('a song the device has no room for isn’t half saved, and what tvOS deleted just isn’t listed', async () => {
  const disk = memoryFiles(20_000);
  const store = folderSongsStore(disk, () => {});
  await assert.rejects(importSongZip(exportZip(), { store }), /isn't enough storage space on this Apple TV/);
  assert.equal(disk.files.size, 0);
  const roomy = memoryFiles();
  const saved = folderSongsStore(roomy, () => {});
  await importSongZip(exportZip(), { store: saved });
  // tvOS cleared the cache (all of it, or a file).
  roomy.remove('songs/fixture/files/audio.wav');
  const [song] = await listSavedSongs(saved, () => {});
  assert.equal(song.damaged, false, 'listing checks song.json and checksums.json');
  await assert.rejects(loadCustomSong(song.entry, { store: saved }), /could not load/);
  roomy.remove('songs');
  assert.deepEqual(await listSavedSongs(saved), []);
});

test('what a save cut short left behind is cleared away', async () => {
  const disk = memoryFiles();
  disk.write('incoming/abc/files/song.json', new Uint8Array([1]));
  const store = folderSongsStore(disk, () => {});
  assert.equal(disk.files.size, 0);
  assert.deepEqual(await listSavedSongs(store), []);
});
