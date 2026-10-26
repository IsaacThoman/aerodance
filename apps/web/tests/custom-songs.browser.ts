// Browser flow for songs imported into the browser (songs/customSongs.ts): Settings → Songs →
// Import song takes a ZIP (deflated, with a folder entry and __MACOSX extras, as the Finder makes)
// through the real file picker; Song Select lists it as a custom song beside a published song with
// the same ID, it's still there after a reload (IndexedDB), previews, dances with the autoplay ghost
// and keeps its best score apart from the published song's. Importing it again asks before
// replacing, and Settings removes it, damaged or not. Several ZIPs import at once, picked together
// or dragged onto the Songs panel. Run after `npm run build`;
// CUSTOM_SONGS_BROWSER=webkit runs it in WebKit.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import express from 'express';
import { chromium, webkit } from 'playwright';
import type { FileChooser } from 'playwright';
import { silentWav } from './fixtures/songBundle.ts';
import { menuLayout } from '../src/menu/layout.ts';
import { gameLayout, resultsSongs } from '../src/game/layout.ts';
import { DISPLAY_MODES } from '../src/display.ts';
import type { Circle, Rect } from '../src/ui/draw.ts';
import { validateSong } from '../../../packages/pose/song.ts';
import { decodePoseFile, encodePoseFile } from '../../../packages/pose/binary.ts';

// UI_ASPECT=standard runs it in a 4:3 window.
const mode = process.env.UI_ASPECT === 'standard' ? 'standard' : 'widescreen';
const design = DISPLAY_MODES[mode];
const { BACK: MENU_BACK, PLAYERS_GO, SETTINGS, SONGS, SONG_IMPORT, SONG_TRASH, SOUND, START } = menuLayout(design.w);
const { BACK, DANCE, rowRect } = gameLayout(design.w);
type Expected = Record<string, string | RegExp>;
type Match = { re: string } | { is: string };

// The test routine, with silent audio: published under its ID and exported as a ZIP.
const routine = new URL('./fixtures/song-70c63c8e/', import.meta.url);
const song = validateSong(JSON.parse(await readFile(new URL('song.json', routine), 'utf8')));
song.audio = { path: 'audio.wav', mimeType: 'audio/wav' };
const files = new Map<string, Buffer>([
  ['song.json', Buffer.from(JSON.stringify(song))],
  ['choreography.adpose', await readFile(new URL('choreography.adpose', routine))],
  ['audio.wav', Buffer.from(silentWav(song.durationMs))],
]);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
files.set('checksums.json', Buffer.from(JSON.stringify({ schema: 'aerodance.checksums', schemaVersion: 1, files: [...files].map(([name, body]) => ({ path: name, bytes: body.length, sha256: sha(body) })) })));
// A ZIP as the Finder makes one of the exported folder: a folder entry, deflated files and a
// __MACOSX/ resource fork.
function finderZip(folder: string, entries: Map<string, Buffer>) {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  const add = (name: string, data: Buffer) => {
    const method = data.length ? 8 : 0, packed = method ? deflateRawSync(data) : data, crc = crc32(data), bytes = Buffer.from(name);
    const head = Buffer.alloc(30), dir = Buffer.alloc(46);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(method, 8); head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(bytes.length, 26);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(method, 10); dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(packed.length, 20); dir.writeUInt32LE(data.length, 24); dir.writeUInt16LE(bytes.length, 28); dir.writeUInt32LE(offset, 42);
    local.push(head, bytes, packed);
    central.push(dir, bytes);
    offset += head.length + bytes.length + packed.length;
  };
  add(`${folder}/`, Buffer.alloc(0));
  for (const [name, data] of entries) add(`${folder}/${name}`, data);
  add(`__MACOSX/${folder}/._song.json`, Buffer.from('resource fork'));
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.size + 2, 8); end.writeUInt16LE(entries.size + 2, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
const work = await mkdtemp(path.join(tmpdir(), 'aerodance-custom-songs-'));
const zipPath = path.join(work, `${song.songId}.zip`);
await writeFile(zipPath, finderZip(song.songId, files));
// Another song, to import beside it: the same routine under another ID.
const other = { ...song, songId: 'other-routine', title: 'Other routine' };
const otherFiles = new Map(files);
const pose = decodePoseFile(files.get('choreography.adpose')!);
otherFiles.set('choreography.adpose', Buffer.from(encodePoseFile({ ...pose, song: { ...pose.song!, songId: other.songId } })));
otherFiles.set('song.json', Buffer.from(JSON.stringify(other)));
otherFiles.delete('checksums.json');
otherFiles.set('checksums.json', Buffer.from(JSON.stringify({ schema: 'aerodance.checksums', schemaVersion: 1, files: [...otherFiles].map(([name, body]) => ({ path: name, bytes: body.length, sha256: sha(body) })) })));
const otherZipPath = path.join(work, `${other.songId}.zip`);
await writeFile(otherZipPath, finderZip(other.songId, otherFiles));
const published = {
  id: song.songId, title: song.title, artist: song.artist, durationMs: song.durationMs, supportedPlayerCounts: song.supportedPlayerCounts,
  bundleRevision: song.bundleRevision, bundle: `${song.songId}/song.json`, sha256: sha(files.get('song.json')!),
};

const app = express();
app.use(express.static('dist'));
const server = app.listen(4174, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const engine = process.env.CUSTOM_SONGS_BROWSER === 'webkit' ? webkit : chromium;
const graphics = process.env.UI_GPU === '1'
  ? ['--enable-gpu', '--use-gl=angle', `--use-angle=${process.env.UI_ANGLE || 'gl'}`, '--disable-gpu-sandbox', '--ignore-gpu-blocklist']
  : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const browser = await engine.launch(engine === webkit ? {} : {
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', ...graphics],
});
let testPage;
try {
  const context = await browser.newContext({ viewport: mode === 'standard' ? { width: 1024, height: 768 } : { width: 1280, height: 800 } });
  const page = await context.newPage();
  testPage = page;
  page.setDefaultTimeout(90000);
  // Flow assertions only: skip GPU rasterization (see ui-flow.browser.ts).
  if (process.env.UI_RENDER !== '1') await page.addInitScript(() => {
    for (const Type of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
      if (!Type) continue;
      for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
        if (Reflect.get(Type.prototype, name)) Reflect.set(Type.prototype, name, () => {});
      }
    }
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // Listening from the start turns file chooser interception on before any click: a listener
  // added just before the click can lose that race on a slow machine, and the page opens a
  // native picker no one sees.
  let chosen: ((chooser: FileChooser) => void) | null = null;
  page.on('filechooser', (chooser) => chosen?.(chooser));
  await page.route('**/songs/**', async (route) => {
    const name = new URL(route.request().url()).pathname.split('/').at(-1) ?? '';
    const body = name === 'manifest.json' ? Buffer.from(JSON.stringify({ version: 1, songs: [published] })) : files.get(name);
    await route.fulfill({ status: body ? 200 : 404, contentType: name === 'audio.wav' ? 'audio/wav' : 'application/octet-stream', body: body ?? 'missing' });
  });

  let frame = { x: 0, y: 0, width: 1, height: 1 };
  const click = async (shape: Rect | Circle) => {
    const p = 'w' in shape ? { x: shape.x + shape.w / 2, y: shape.y + shape.h / 2 } : shape;
    await page.mouse.click(frame.x + (p.x / design.w) * frame.width, frame.y + (p.y / design.h) * frame.height);
  };
  const until = async (expected: Expected, timeout?: number) => {
    const entries = Object.entries(expected).map(([k, v]): [string, Match] => [k, v instanceof RegExp ? { re: v.source } : { is: v }]);
    await page.waitForFunction((list) => {
      const d = document.querySelector('canvas')?.dataset;
      return d && list.every(([k, m]) => ('re' in m ? new RegExp(m.re).test(d[k] ?? '') : d[k] === m.is));
    }, entries, timeout ? { timeout } : undefined);
  };
  // The ghost dances (?input=ghost), so every player reads as detected.
  const load = async () => {
    await page.goto('http://127.0.0.1:4174/?input=ghost');
    await page.waitForFunction(() => document.querySelector('canvas')?.style.opacity === '1', null, { timeout: 90000 });
    const box = await page.locator('.canvas-frame').boundingBox();
    assert.ok(box);
    frame = box;
    await until({ menuScreen: 'main', menuReady: 'true', displayMode: mode });
  };
  const toSettings = async () => {
    await load();
    await click(SETTINGS);
    await until({ menuScreen: 'settings', menuReady: 'true', savedSongs: /^\d+$/ });
  };
  // Start opens the dial on 2.
  const toSongSelect = async () => {
    await load();
    await click(START);
    await until({ menuScreen: 'players', menuReady: 'true' });
    await click(PLAYERS_GO);
    await until({ songScreen: 'list', songReady: 'true', catalog: 'ready' });
  };
  const shot = async (name: string) => { if (process.env.UI_ARTIFACTS) await page.screenshot({ path: `${process.env.UI_ARTIFACTS}/${name}.png` }); };
  const importZip = async (paths = [zipPath]) => {
    const chooser = new Promise<FileChooser>((resolve) => { chosen = resolve; });
    await click(SONG_IMPORT);
    await (await chooser).setFiles(paths);
    chosen = null;
  };
  // Drags files from outside the page to a place in the layout, and drops them there if asked.
  const dragFiles = async (shape: Rect, list: { name: string; body: Buffer }[], drop: boolean) => {
    const x = frame.x + ((shape.x + shape.w / 2) / design.w) * frame.width, y = frame.y + ((shape.y + shape.h / 2) / design.h) * frame.height;
    await page.evaluate(({ x, y, list, drop }) => {
      const data = new DataTransfer();
      for (const { name, body } of list) data.items.add(new File([Uint8Array.from(atob(body), (c) => c.charCodeAt(0))], name, { type: 'application/zip' }));
      const canvas = document.querySelector('canvas');
      for (const type of drop ? ['dragover', 'drop'] : ['dragenter', 'dragover']) {
        canvas?.dispatchEvent(new DragEvent(type, { dataTransfer: data, clientX: x, clientY: y, bubbles: true, cancelable: true }));
      }
    }, { x, y, list: list.map(({ name, body }) => ({ name, body: body.toString('base64') })), drop });
  };
  // Answers the next confirm() and gives its message. It's answered in the handler: a click that
  // opens one doesn't finish until it's answered.
  const answerDialog = (accept: boolean) => new Promise<string>((resolve) => page.once('dialog', async (dialog) => {
    resolve(dialog.message());
    await (accept ? dialog.accept() : dialog.dismiss());
  }));

  // The notice says which player counts Song Select lists it for.
  const imported = `Imported “${song.title}”. It's for up to ${Math.max(...song.supportedPlayerCounts)} players.`;
  assert.ok(Math.max(...song.supportedPlayerCounts) < 4);
  await toSettings();
  await until({ savedSongs: '0', songImport: 'idle' });
  await shot('custom-settings');
  await importZip();
  await until({ songImport: 'done', songNotice: imported, savedSongs: '1', damagedSongs: '0' });
  await shot('custom-imported');

  // Listed after the published song, and still there after a reload.
  await toSongSelect();
  await until({ songCount: '2', customSongCount: '1' });
  await shot('custom-list');
  await toSettings();
  await until({ savedSongs: '1' });

  // The same revision again asks first; No keeps the saved copy.
  const replace = answerDialog(false);
  await importZip();
  assert.equal(await replace, `“${song.title}” revision ${song.bundleRevision} is already imported. Replace it?`);
  await until({ songImport: 'done', songNotice: /^Kept the/, savedSongs: '1' });
  // Leaving Settings clears what the last import did.
  await click(MENU_BACK);
  await until({ menuScreen: 'main', menuReady: 'true', songImport: 'idle', songNotice: '' });

  // The custom song (after the published one) previews and dances; its best score is its own.
  await click(START);
  await until({ menuScreen: 'players', menuReady: 'true' });
  await click(PLAYERS_GO);
  await until({ songScreen: 'list', songReady: 'true', catalog: 'ready', customSongCount: '1' });
  await click(rowRect(1));
  await until({ songScreen: 'preview', songReady: 'true', previewState: 'playing' });
  await shot('custom-preview');
  await click(DANCE);
  await until({ gamePhase: 'playing' }, 30000);
  await until({ gamePhase: 'results' }, 90000);
  const bests = Object.keys(JSON.parse(await page.evaluate(() => localStorage.getItem('aerodance-best-scores') ?? '{}')));
  assert.ok(bests.some((key) => key.startsWith(`custom:${song.songId}|2p|`)), `custom best score saved: ${bests.join(', ')}`);
  assert.ok(!bests.some((key) => key.startsWith(`${song.songId}|`)), 'the published song has no best score');
  await click(resultsSongs(2));
  await until({ songScreen: 'list', songReady: 'true', catalog: 'ready', customSongCount: '1' });

  // Settings removes it, asking first.
  await toSettings();
  const confirm = answerDialog(true);
  await click(SONG_TRASH(0));
  assert.equal(await confirm, `Remove “${song.title}” from this browser?`);
  await until({ savedSongs: '0', songNotice: `Removed “${song.title}”.` });
  await toSongSelect();
  await until({ songCount: '1', customSongCount: '0' });

  // Clearing site data closes the page's database connection; the next import opens it again.
  await toSettings();
  if (engine === chromium) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Storage.clearDataForOrigin', { origin: 'http://127.0.0.1:4174', storageTypes: 'indexeddb' });
  }
  await importZip();
  await until({ songImport: 'done', songNotice: imported, savedSongs: '1' });
  await toSongSelect();
  await until({ customSongCount: '1' });

  // Another tab replacing the song (its next revision, saved as an import saves it) leaves this
  // list stale: opening it says so and lists the new one.
  const next = { ...song, bundleRevision: song.bundleRevision + 1 };
  const nextSong = Buffer.from(JSON.stringify(next));
  const nextFiles = new Map(files);
  nextFiles.set('song.json', nextSong);
  nextFiles.delete('checksums.json');
  const nextChecksums = Buffer.from(JSON.stringify({ schema: 'aerodance.checksums', schemaVersion: 1, files: [...nextFiles].map(([name, body]) => ({ path: name, bytes: body.length, sha256: sha(body) })) }));
  const nextEntry = { ...published, bundleRevision: next.bundleRevision, sha256: sha(nextSong), ...(next.difficulty ? { difficulty: next.difficulty } : {}), ...(next.stage ? { stage: next.stage } : {}) };
  await page.evaluate(({ id, entry, songJson, checksums, sizes }) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('aerodance-custom-songs');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const tx = request.result.transaction(['songs', 'files'], 'readwrite');
      tx.objectStore('songs').put({ id, entry, sizes: new Map(sizes), importedAt: new Date().toISOString() });
      tx.objectStore('files').put({ id, path: 'song.json', bytes: new Uint8Array(songJson) });
      tx.objectStore('files').put({ id, path: 'checksums.json', bytes: new Uint8Array(checksums) });
      tx.oncomplete = () => { request.result.close(); resolve(); };
      tx.onabort = () => reject(tx.error);
    };
  }), { id: song.songId, entry: nextEntry, songJson: [...nextSong], checksums: [...nextChecksums],
    sizes: [...nextFiles, ['checksums.json', nextChecksums] as const].map(([name, body]): [string, number] => [name, body.length]) });
  await click(rowRect(1));
  await until({ songScreen: 'list', catalog: 'ready', customSongCount: '1', songLoadError: /has changed since the list loaded/ });
  await click(rowRect(1));
  await until({ songScreen: 'preview', songReady: 'true' });
  await click(BACK);
  await until({ songScreen: 'list', songReady: 'true', catalog: 'ready' });

  // A saved song that can't be opened (its audio is gone) says where to remove it.
  const idb = (id: string, change: 'audio' | 'sizes') => page.evaluate(({ id, change }) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('aerodance-custom-songs');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const tx = request.result.transaction(['songs', 'files'], 'readwrite');
      if (change === 'audio') tx.objectStore('files').delete([id, 'audio.wav']);
      else {
        const songs = tx.objectStore('songs');
        const get = songs.get(id);
        get.onsuccess = () => { get.result.sizes.delete('checksums.json'); songs.put(get.result); };
      }
      tx.oncomplete = () => { request.result.close(); resolve(); };
      tx.onabort = () => reject(tx.error);
    };
  }), { id, change });
  await idb(song.songId, 'audio');
  await click(rowRect(1));
  await until({ songScreen: 'list', songLoadError: /can't be played: Song asset could not load \(404\)\. You can remove it in Settings\.$/ });
  // One that no longer checks out at all is left out of Song Select, and shows in Settings as
  // damaged, to remove.
  await idb(song.songId, 'sizes');
  await toSongSelect();
  await until({ songCount: '1', customSongCount: '0' });
  await toSettings();
  await until({ savedSongs: '1', damagedSongs: '1' });
  await shot('custom-damaged');
  const removeDamaged = answerDialog(true);
  await click(SONG_TRASH(0));
  await removeDamaged;
  await until({ savedSongs: '0', songNotice: /^Removed/ });

  // Two ZIPs picked together import one after the other.
  await importZip([zipPath, otherZipPath]);
  await until({ songImport: 'done', songNotice: 'Imported 2 songs.', savedSongs: '2', damagedSongs: '0' });
  await shot('custom-imported-two');

  // Files dragged over Settings: the Songs panel takes them, the rest of the page doesn't.
  const dropped = [{ name: path.basename(zipPath), body: await readFile(zipPath) }, { name: 'notes.zip', body: Buffer.from('not a zip') }];
  await dragFiles(SOUND, dropped, false);
  await until({ songDrop: 'near' });
  await dragFiles(SONGS, dropped, false);
  await until({ songDrop: 'over' });
  await shot('custom-drop');
  await dragFiles(SOUND, dropped, true);
  await until({ songDrop: '' });
  assert.equal(await page.evaluate(() => document.querySelector('canvas')?.dataset.songImport), 'done', 'a drop beside the panel imported');
  // Dropped on it, they import (the same revision asking first), and a file that isn't a song says so.
  const replaceDropped = answerDialog(true);
  await dragFiles(SONGS, dropped, true);
  assert.equal(await replaceDropped, `“${song.title}” revision ${song.bundleRevision} is already imported. Replace it?`);
  await until({ songImport: 'error', songNotice: /^Updated 1 song\. notes\.zip: That isn't a readable song ZIP/, savedSongs: '2', songDrop: '' });
  await shot('custom-dropped');
  assert.deepEqual(errors, []);
  console.log(`Custom songs passed in ${engine.name()}: Settings → Songs importing through the file picker, listing beside a published song in Song Select, persistence across a reload, asking before replacing, preview, a scored song with its own best score, removing, a song replaced in another tab, a damaged song removed in Settings, and several ZIPs picked together or dropped on the Songs panel.`);
} catch (error) {
  console.error(error);
  if (testPage) console.error(await testPage.locator('canvas').evaluate((c) => JSON.stringify(c.dataset)).catch(() => ''));
  throw error;
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(work, { recursive: true, force: true });
}
