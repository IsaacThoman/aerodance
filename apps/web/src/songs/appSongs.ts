import { catalogEntry } from '../../../../packages/pose/song.ts';
import type { CatalogSong } from '../../../../packages/pose/song.ts';
import { isArray, isObject } from '../../../../packages/pose/choreography.ts';
import { makeZip } from '../../../../packages/pose/zip.ts';
import { appSongs } from '../host.ts';
import type { AppSongs } from '../host.ts';
import { folderOf, readSongZip } from './customSongs.ts';
import type { CustomSongRecord, CustomSongStore } from './customSongs.ts';
import { MAX_BUNDLE_BYTES } from './loadBundle.ts';

/*
 * Songs imported into the iPhone/iPad app (apps/ios/): Dance Studio export ZIPs in the app's
 * Documents folder, which the Files app shows as On My iPhone › aerodance, so a ZIP saved there
 * from Files, AirDrop or a Mac is imported too. The app serves the folder to the page under
 * /app/songs/ (main.m), for requests with its key (host.ts appSongs).
 *
 *   appSongsStore({ key })   a CustomSongStore (customSongs.ts) over the folder
 *   pickAppSongs()           the ZIPs picked in the app's file picker, each to read (none if cancelled)
 *
 * The store has songs by songId, like the browser's IndexedDB store:
 * - Each ZIP is read once: what it holds (its songId, catalog entry, files' sizes, and
 *   song.json and checksums.json, which listing checks again) is kept in localStorage under its
 *   name with its size and modification time, and read again when either changes.
 * - A ZIP that isn't a playable song lists (damaged, to remove) as zip:<file name>.
 * - Two ZIPs of one song: the later revision lists (then the one changed last). Removing it
 *   removes them all; importing replaces them all.
 * - A song's other files are read by unpacking its ZIP; the last one unpacked is kept for a
 *   few seconds, for the rest of the same load.
 * - Saving writes the ZIP Dance Studio exports (stored, everything in <songId>/), named as it
 *   names them: <songId>-r<revision>.aerodance-song.zip.
 */

/** A ZIP in the app's folder, as the app lists it (modified: Unix time in milliseconds). */
interface ZipFile { name: string; size: number; modified: number; }
/** What a ZIP holds, kept until its size or modification time changes (stamp). */
interface Contents {
  stamp: string;
  /** Its song.json's songId, or '' when there's none to read. */
  songId: string;
  /** Its catalog entry when it checks out (catalogEntry). */
  entry: CatalogSong | null;
  sizes: [string, number][];
  /** song.json and checksums.json, base64. */
  meta: Record<string, string>;
}
/** A listed song: its record, the ZIP it's read from, and every ZIP of that song. */
interface Song { record: CustomSongRecord; file: ZipFile; contents: Contents; copies: string[]; }

const CACHE_KEY = 'aerodance-app-songs';
// Larger metadata is read from the ZIP each time instead of being kept.
const MAX_KEPT_META_BYTES = 256 * 1024;
const UNPACKED_KEEP_MS = 10_000;
// A listing is reused this long (loading a song reads several files, each needing the list).
const LIST_KEEP_MS = 1000;
const META = ['song.json', 'checksums.json'];
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const stampOf = (file: ZipFile) => `${file.size}:${file.modified}`;

const toBase64 = (bytes: Uint8Array) => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

const zipFile = (value: unknown): ZipFile | null =>
  isObject(value) && typeof value.name === 'string' && Number.isSafeInteger(value.size) && Number.isFinite(value.modified)
    ? { name: value.name, size: value.size as number, modified: value.modified as number } : null;
const contentsOf = (value: unknown): Contents | null =>
  isObject(value) && typeof value.stamp === 'string' && typeof value.songId === 'string' && (value.entry === null || isObject(value.entry)) &&
  isArray(value.sizes) && isObject(value.meta) ? value as unknown as Contents : null;

/** What a ZIP's files hold, checked as listing checks a saved song. */
async function describe(stamp: string, songId: string, files: ReadonlyMap<string, Uint8Array<ArrayBuffer>>): Promise<Contents> {
  let entry: CatalogSong | null = null;
  try { entry = await catalogEntry(songId, folderOf(async (path) => files.get(path))); }
  catch { /* listed as damaged */ }
  const meta: Record<string, string> = {};
  for (const path of META) {
    const bytes = files.get(path);
    if (bytes && bytes.byteLength <= MAX_KEPT_META_BYTES) meta[path] = toBase64(bytes);
  }
  return { stamp, songId, entry, sizes: [...files].map(([path, bytes]) => [path, bytes.byteLength]), meta };
}

export interface AppSongsOptions {
  key: string;
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
  /** Where what each ZIP holds is kept (localStorage). */
  cache?: Pick<Storage, 'getItem' | 'setItem'>;
  warn?: (message: string) => void;
  /** How long a listing is reused. */
  listKeepMs?: number;
}

/** Saved songs in the app's folder of ZIPs. */
export function appSongsStore({ key, fetcher = fetch, cache = globalThis.localStorage, warn = console.warn, listKeepMs = LIST_KEEP_MS }: AppSongsOptions): CustomSongStore {
  const request = async (method: string, path: string, body?: Uint8Array<ArrayBuffer>) => {
    let response: Response;
    try { response = await fetcher(`/app/${path}`, { method, body, headers: { 'X-Aerodance-Key': key } }); }
    catch (error) { throw Error(`Saved songs aren't available in this app (${errorText(error)}).`, { cause: error }); }
    if (response.status === 507) throw Error("There isn't enough storage space on this device for that song.");
    if (!response.ok && !(method === 'DELETE' && response.status === 404)) throw Error(`Saved songs aren't available in this app (${response.status}).`);
    return response;
  };
  const songPath = (name: string) => `songs/${encodeURIComponent(name)}`;

  // What each ZIP holds, by name.
  let kept: Map<string, Contents> | null = null;
  const keptContents = () => {
    if (kept) return kept;
    kept = new Map();
    try {
      const saved: unknown = JSON.parse(cache?.getItem(CACHE_KEY) ?? '{}');
      if (isObject(saved)) for (const [name, value] of Object.entries(saved)) { const c = contentsOf(value); if (c) kept.set(name, c); }
    } catch { /* read again */ }
    return kept;
  };
  const saveContents = () => {
    try { cache?.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(keptContents()))); }
    catch (error) { warn(`What the saved songs hold couldn't be kept: ${errorText(error)}`); }
  };

  // The last ZIP unpacked, by name and stamp, until it's gone unused a while.
  let unpacked: { id: string; files: Promise<Map<string, Uint8Array<ArrayBuffer>>> } | null = null;
  let unpackedTimer: ReturnType<typeof setTimeout> | undefined;
  const unpack = (file: ZipFile) => {
    const id = `${file.name}\n${stampOf(file)}`;
    if (unpacked?.id !== id) {
      const files = request('GET', songPath(file.name)).then((response) => response.blob()).then(async (blob) => (await readSongZip(blob)).files);
      files.catch(() => { if (unpacked?.id === id) unpacked = null; });
      unpacked = { id, files };
    }
    clearTimeout(unpackedTimer);
    unpackedTimer = setTimeout(() => { unpacked = null; }, UNPACKED_KEEP_MS);
    return unpacked.files;
  };

  // What a ZIP holds: kept, or read now (once, however many listings ask meanwhile).
  const reading = new Map<string, Promise<Contents>>();
  const contents = (file: ZipFile): Promise<Contents> => {
    const stamp = stampOf(file), known = keptContents().get(file.name);
    if (known?.stamp === stamp) return Promise.resolve(known);
    const id = `${file.name}\n${stamp}`;
    let read = reading.get(id);
    if (!read) {
      read = (async () => {
        if (file.size > MAX_BUNDLE_BYTES) return { stamp, songId: '', entry: null, sizes: [], meta: {} };
        const response = await request('GET', songPath(file.name));
        try {
          const { name, files } = await readSongZip(await response.blob());
          return await describe(stamp, name, files);
        } catch (error) {
          warn(`${file.name} isn't a song: ${errorText(error)}`);
          return { stamp, songId: '', entry: null, sizes: [], meta: {} };
        }
      })().then((c) => { keptContents().set(file.name, c); return c; }).finally(() => reading.delete(id));
      reading.set(id, read);
    }
    return read;
  };

  // Every ZIP in the folder, as songs by ID.
  let listing: { at: number; songs: Promise<Map<string, Song>> } | null = null;
  const forget = () => { listing = null; };
  const list = async (): Promise<Map<string, Song>> => {
    const response = await request('GET', 'songs/');
    let body: unknown;
    try { body = await response.json(); }
    catch (error) { throw Error(`Saved songs aren't available in this app (${errorText(error)}).`, { cause: error }); }
    const files = isObject(body) && isArray(body.files) ? body.files.flatMap((f) => zipFile(f) ?? []) : [];
    const read = await Promise.all(files.map(async (file) => ({ file, contents: await contents(file) })));
    // Only what's still there is kept.
    const names = new Set(files.map((file) => file.name));
    for (const name of keptContents().keys()) if (!names.has(name)) keptContents().delete(name);
    saveContents();
    const songs = new Map<string, Song>();
    const record = (id: string, file: ZipFile, c: Contents, entry: CatalogSong): CustomSongRecord =>
      ({ id, entry, sizes: new Map(c.sizes), importedAt: new Date(file.modified).toISOString() });
    // The latest revision first, then the one changed last.
    const order = [...read].sort((a, b) => (b.contents.entry?.bundleRevision ?? 0) - (a.contents.entry?.bundleRevision ?? 0) ||
      b.file.modified - a.file.modified || a.file.name.localeCompare(b.file.name));
    for (const { file, contents: c } of order) {
      if (!c.entry) {
        // Named by its file, and only this copy matches a removal (sha256: its stamp).
        const id = `zip:${file.name}`;
        const entry: CatalogSong = { id, title: file.name, artist: '', durationMs: 0, bundleRevision: 0, supportedPlayerCounts: [], bundle: '', sha256: c.stamp };
        songs.set(id, { record: record(id, file, c, entry), file, contents: c, copies: [file.name] });
        continue;
      }
      const listed = songs.get(c.entry.id);
      if (listed) listed.copies.push(file.name);
      else songs.set(c.entry.id, { record: record(c.entry.id, file, c, c.entry), file, contents: c, copies: [file.name] });
    }
    return songs;
  };
  const songs = () => {
    if (!listing || performance.now() - listing.at > listKeepMs) {
      const current = { at: performance.now(), songs: list() };
      current.songs.catch(() => { if (listing === current) listing = null; });
      listing = current;
    }
    return listing.songs;
  };
  // The ZIPs in the folder holding a song (whether or not they check out), by its songId.
  const copiesOf = async (songId: string) => {
    const present = new Set([...(await songs()).values()].flatMap((song) => song.copies));
    return [...keptContents()].filter(([name, c]) => c.songId === songId && present.has(name)).map(([name]) => name);
  };

  return {
    all: async () => [...(await songs()).values()].map((song) => song.record),
    get: async (id) => (await songs()).get(id)?.record,
    file: async (id, path) => {
      const song = (await songs()).get(id);
      if (!song) return undefined;
      const meta = song.contents.meta[path];
      if (meta !== undefined) return fromBase64(meta);
      return (await unpack(song.file)).get(path);
    },
    put: async (record, files) => {
      const name = `${record.id}-r${record.entry.bundleRevision}.aerodance-song.zip`;
      const others = (await copiesOf(record.id)).filter((other) => other !== name);
      const zip = makeZip(new Map([...files].map(([path, bytes]) => [`${record.id}/${path}`, bytes])));
      forget();
      const saved = zipFile(await (await request('PUT', songPath(name), zip)).json().catch(() => null));
      if (saved) { keptContents().set(name, await describe(stampOf(saved), record.id, files)); saveContents(); }
      for (const other of others) await request('DELETE', songPath(other));
      forget();
    },
    delete: async (id, only) => {
      const song = (await songs()).get(id);
      if (!song || (only && (song.record.entry.bundleRevision !== only.bundleRevision || song.record.entry.sha256 !== only.sha256))) return false;
      forget();
      for (const name of song.copies) await request('DELETE', songPath(name));
      forget();
      return true;
    },
  };
}

/** A song ZIP picked to import: its file name, and its bytes when they're wanted. */
export interface SongFile { name: string; read(): Promise<Blob>; }

/**
 * The ZIPs picked in the app's file picker (none if it was cancelled), each read when it's
 * imported: the app's copy is deleted once it's been read.
 */
export async function pickAppSongs(songs: AppSongs | null = appSongs(), fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch): Promise<SongFile[]> {
  if (!songs) return [];
  const headers = { 'X-Aerodance-Key': songs.key };
  return (await songs.pick()).map((picked) => ({
    name: picked.name,
    read: async () => {
      const response = await fetcher(picked.url, { headers });
      if (!response.ok) throw Error(`${picked.name} couldn't be opened.`);
      const file = new File([await response.blob()], picked.name, { type: 'application/zip' });
      // The app's copy is only for this.
      fetcher(picked.url, { method: 'DELETE', headers }).catch(() => {});
      return file;
    },
  }));
}
