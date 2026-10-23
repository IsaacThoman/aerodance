import { catalogEntry, validateBundlePath } from '../../../../packages/pose/song.ts';
import type { CatalogSong, SongFolder } from '../../../../packages/pose/song.ts';
import { isArray, isObject } from '../../../../packages/pose/choreography.ts';
import { readZip } from '../../../../packages/pose/zip.ts';
import { appSongs, client } from '../host.ts';
import { appSongsStore } from './appSongs.ts';
import { MAX_BUNDLE_BYTES, loadSongBundle } from './loadBundle.ts';
import type { Fetcher } from './loadBundle.ts';

/*
 * Songs imported into this browser or the iPhone/iPad app: the ZIPs Dance Studio exports
 * (<songId>-r<n>.aerodance-song.zip, one <songId>/ folder of song.json, checksums.json,
 * choreography, audio and cover), kept in IndexedDB (in the app, as ZIPs in its folder in the
 * Files app: appSongs.ts), managed in Settings (menu/songsPanel.ts) and listed in Song Select
 * after the published songs.
 *
 *   importSongZip(file, { confirmReplace })   checks it fully (catalogEntry, then loadSongBundle),
 *                                             then saves it in one transaction
 *   listSavedSongs()                          every saved song, checked again (damaged or not)
 *   listCustomSongs()                         the catalog entries of those that check out
 *   loadCustomSong(entry, { signal })         loadSongBundle over the saved files
 *   removeCustomSong(entry)                   unless another tab has replaced it since
 *
 * They're kept apart from published songs: an imported song can share a published song's ID,
 * and its best scores are kept under custom:<id> (customScoreId). Only the files checksums.json
 * lists are kept, as bytes rather than Blobs (WebKit won't store Blobs in a private window), one
 * record each so the list doesn't read every song's audio. The iPhone/iPad app keeps them
 * itself (WebKit may clear the page's storage) and picks the files (its picker shows on the
 * phone while the game is on a TV). The Apple TV app (no storage or file picker for the page)
 * doesn't offer importing (customSongsSupported).
 */

/** Which copy of a song: its revision and song.json hash. */
export type SavedVersion = Pick<CatalogSong, 'bundleRevision' | 'sha256'>;
/** A saved song: its catalog entry and its files' sizes by bundle-relative path. */
export interface CustomSongRecord { id: string; entry: CatalogSong; sizes: Map<string, number>; importedAt: string; }
/** Where saved songs live: songStore(), IndexedDB in the browser (indexedDBStore) or the app's folder (appSongsStore); Maps in tests. */
export interface CustomSongStore {
  all(): Promise<CustomSongRecord[]>;
  get(id: string): Promise<CustomSongRecord | undefined>;
  file(id: string, path: string): Promise<Uint8Array<ArrayBuffer> | undefined>;
  /** Saves a song and its files, in place of any saved before under its ID, all or nothing. */
  put(record: CustomSongRecord, files: ReadonlyMap<string, Uint8Array<ArrayBuffer>>): Promise<void>;
  /** Deletes a song and its files (with only: if it's still that revision); true if it did. */
  delete(id: string, only?: SavedVersion): Promise<boolean>;
}
export interface ImportResult {
  /** imported: new; replaced: over a saved copy; kept: the saved copy stayed (confirmReplace said no). */
  status: 'imported' | 'replaced' | 'kept';
  entry: CatalogSong;
  /** The saved copy's revision, when there was one. */
  previousRevision?: number;
}
export interface ImportOptions {
  store?: CustomSongStore;
  /** Asked before an import replaces a saved copy of the same or a later revision. */
  confirmReplace?: (saved: CatalogSong, incoming: CatalogSong) => boolean | Promise<boolean>;
}

/** Saved songs load through this made-up origin (folderFetcher answers it). */
export const CUSTOM_CATALOG_URL = 'https://custom-songs.invalid/songs/manifest.json';
export const customScoreId = (songId: string) => `custom:${songId}`;

/** Importing needs somewhere to keep songs and a file picker: a browser's, or the iPhone/iPad app's. */
export const customSongsSupported = () => appSongs() !== null ||
  (client() === 'web' && typeof indexedDB !== 'undefined' && typeof HTMLInputElement !== 'undefined');
/** Where songs are imported to, for messages: "in this browser" or "in this app". */
export const savedIn = () => (appSongs() ? 'in this app' : 'in this browser');

const ZIP_NOISE = (path: string) => path.startsWith('__MACOSX/') || /(^|\/)(\.DS_Store|\._[^/]*)$/.test(path);
const decodeJson = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(bytes));
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A song folder over a file lookup by bundle-relative path (and optionally known sizes). */
export function folderOf(file: (path: string) => Promise<Uint8Array<ArrayBuffer> | undefined>, sizes?: ReadonlyMap<string, number>): SongFolder {
  const read = async (path: string) => {
    const bytes = await file(validateBundlePath(path));
    if (!bytes) throw Error(`Missing file: ${path}`);
    return bytes;
  };
  return {
    size: async (path) => {
      const size = sizes?.get(validateBundlePath(path));
      if (sizes && size === undefined) throw Error(`Missing file: ${path}`);
      return size ?? (await read(path)).byteLength;
    },
    read,
  };
}

// A fetch over one song's files, served under CUSTOM_CATALOG_URL's songs/<id>/.
function folderFetcher(id: string, file: (path: string) => Promise<Uint8Array<ArrayBuffer> | undefined>): Fetcher {
  const root = new URL(`${id}/`, CUSTOM_CATALOG_URL);
  return async (url, { signal }) => {
    signal?.throwIfAborted();
    const path = url.origin === root.origin && url.pathname.startsWith(root.pathname) ? decodeURIComponent(url.pathname.slice(root.pathname.length)) : '';
    const body = path ? await file(path) : undefined;
    signal?.throwIfAborted();
    return body ? new Response(body) : new Response(null, { status: 404 });
  };
}

/**
 * An exported song's files from a ZIP: the one folder (or the archive's top level) holding
 * song.json, without the Finder's __MACOSX/ and .DS_Store extras, and its songId.
 */
export async function readSongZip(file: Blob): Promise<{ name: string; files: Map<string, Uint8Array<ArrayBuffer>> }> {
  if (file.size > MAX_BUNDLE_BYTES) throw Error('That file is too big to be a song.');
  let entries: Map<string, Uint8Array>;
  try { entries = await readZip(new Uint8Array(await file.arrayBuffer()), MAX_BUNDLE_BYTES); }
  catch (error) { throw Error(`That isn't a readable song ZIP (${errorText(error)}).`, { cause: error }); }
  const paths = [...entries.keys()].filter((path) => !ZIP_NOISE(path));
  if (paths.some((path) => /^([^/]+\/)?project\.json$/.test(path))) throw Error("That's a Dance Studio project backup. Import the ZIP that Export song makes.");
  const songs = paths.filter((path) => /^([^/]+\/)?song\.json$/.test(path));
  if (!songs.length) throw Error("That ZIP has no song.json. Import the ZIP that Dance Studio's Export song makes.");
  if (songs.length > 1) throw Error('That ZIP holds more than one song. Import them one at a time.');
  const prefix = songs[0].slice(0, -'song.json'.length);
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  for (const path of paths) {
    const bytes = entries.get(path);
    // Stored entries are views of the whole archive: copy them, so saving one doesn't save it all.
    if (path.startsWith(prefix) && bytes) files.set(path.slice(prefix.length), bytes.byteLength === bytes.buffer.byteLength ? bytes as Uint8Array<ArrayBuffer> : new Uint8Array(bytes));
  }
  // The folder's name means nothing here (the Finder may have made it "<songId> 2"): song.json names it.
  let song: unknown;
  try { song = decodeJson(files.get('song.json') ?? new Uint8Array()); }
  catch (error) { throw Error("That song's song.json can't be read.", { cause: error }); }
  return { name: isObject(song) && typeof song.songId === 'string' ? song.songId : '', files };
}

/** Checks a Dance Studio export (ZIP) as fully as playing it would, then saves it. */
export async function importSongZip(file: Blob, { store = songStore(), confirmReplace = () => false }: ImportOptions = {}): Promise<ImportResult> {
  const { name, files } = await readSongZip(file);
  const lookup = async (path: string) => files.get(path);
  let entry: CatalogSong;
  try {
    entry = await catalogEntry(name, folderOf(lookup));
    await loadSongBundle(entry, CUSTOM_CATALOG_URL, { fetcher: folderFetcher(entry.id, lookup) });
  } catch (error) { throw Error(`That song can't be played: ${errorText(error)}`, { cause: error }); }
  // Keep what checksums.json lists (everything the bundle plays, checked above), and itself.
  const checksums = decodeJson(files.get('checksums.json') ?? new Uint8Array());
  const listed = isObject(checksums) && isArray(checksums.files) ? checksums.files.flatMap((f) => (isObject(f) && typeof f.path === 'string' ? [f.path] : [])) : [];
  const kept = new Map<string, Uint8Array<ArrayBuffer>>();
  for (const path of ['checksums.json', ...listed]) {
    const bytes = files.get(path);
    if (bytes) kept.set(path, bytes);
  }
  const saved = await store.get(entry.id);
  const previousRevision = saved?.entry.bundleRevision;
  // A saved copy that no longer checks out isn't listed, so it's replaced without asking.
  const intact = saved ? await catalogEntry(saved.id, savedFolder(store, saved)).then(() => true, () => false) : false;
  if (saved && intact && saved.entry.bundleRevision >= entry.bundleRevision && !await confirmReplace(saved.entry, entry)) {
    return { status: 'kept', entry: saved.entry, previousRevision };
  }
  const sizes = new Map([...kept].map(([path, bytes]) => [path, bytes.byteLength]));
  await store.put({ id: entry.id, entry, sizes, importedAt: new Date().toISOString() }, kept);
  if (store === shared) void keepStorage();
  return { status: saved ? 'replaced' : 'imported', entry, ...(saved ? { previousRevision } : {}) };
}

// Asks the browser not to clear saved songs to make room, unless it already won't. It may say no;
// Firefox asks the player.
async function keepStorage() {
  const storage = globalThis.navigator?.storage;
  try { if (storage?.persist && !await storage.persisted?.()) await storage.persist(); }
  catch { /* not offered */ }
}

const savedFolder = (store: CustomSongStore, record: CustomSongRecord) => folderOf((path) => store.file(record.id, path), record.sizes);

/** A saved song for Settings: damaged when it no longer checks out (so Song Select leaves it out). */
export interface SavedSong { entry: CatalogSong; damaged: boolean; }
const text = (value: unknown) => (typeof value === 'string' ? value : '');
/** Every saved song by title, checked again. */
export async function listSavedSongs(store: CustomSongStore = songStore(), warn: (message: string) => void = console.warn): Promise<SavedSong[]> {
  const songs: SavedSong[] = [];
  for (const record of await store.all()) {
    try { songs.push({ entry: await catalogEntry(record.id, savedFolder(store, record)), damaged: false }); }
    catch (error) {
      warn(`Imported song ${record.id} is damaged: ${errorText(error)}`);
      // Named as best it can be; its revision and hash stay as saved, so removing it matches.
      const { entry } = record;
      songs.push({ entry: { ...entry, id: record.id, title: text(entry.title) || record.id, artist: text(entry.artist) }, damaged: true });
    }
  }
  return songs.sort((a, b) => a.entry.title.localeCompare(b.entry.title) || a.entry.id.localeCompare(b.entry.id));
}
/** The catalog entries of the saved songs that check out, by title. */
export const listCustomSongs = async (store: CustomSongStore = songStore(), warn: (message: string) => void = console.warn) =>
  (await listSavedSongs(store, warn)).filter((song) => !song.damaged).map((song) => song.entry);

/** A saved song, verified like a published one (loadSongBundle). */
export function loadCustomSong(entry: CatalogSong, { signal, store = songStore() }: { signal?: AbortSignal; store?: CustomSongStore } = {}) {
  const fetcher = folderFetcher(entry.id, (path) => store.file(entry.id, path));
  return loadSongBundle(entry, CUSTOM_CATALOG_URL, { signal, fetcher, scoreId: customScoreId(entry.id) });
}

/** Deletes a saved song if it's still the copy given (another tab may have replaced it); true if it did. */
export const removeCustomSong = (song: SavedVersion & { id: string }, store: CustomSongStore = songStore()) =>
  store.delete(song.id, { bundleRevision: song.bundleRevision, sha256: song.sha256 });

/** The saved copy's catalog entry as imported (it may have changed since it was listed). */
export const savedCustomSong = async (id: string, store: CustomSongStore = songStore()) => (await store.get(id))?.entry;

// When the browser hasn't room to save a song.
const quotaMessage = "There isn't enough storage space in this browser for that song.";

let app: CustomSongStore | null = null;
/** Where this page keeps imported songs: the app's folder in the iPhone/iPad app, else IndexedDB. */
export function songStore(): CustomSongStore {
  const songs = appSongs();
  return songs ? (app ??= appSongsStore({ key: songs.key })) : indexedDBStore();
}

const DB_NAME = 'aerodance-custom-songs', SONGS = 'songs', FILES = 'files';
// Every file of a song: [id, path] keys, where any path sorts below an array.
const songFiles = (id: string) => IDBKeyRange.bound([id], [id, []]);
let shared: CustomSongStore | null = null;
/** Saved songs in IndexedDB: a record per song (songs) and per file (files, keyed [id, path]). */
export function indexedDBStore(): CustomSongStore {
  if (shared) return shared;
  let opening: Promise<IDBDatabase> | null = null;
  const connect = () => {
    // Each connection forgets only itself, so a late event from an old one leaves a new one be.
    const forget = () => { if (opening === connection) opening = null; };
    let blocked = false;
    const connection = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(SONGS, { keyPath: 'id' });
        request.result.createObjectStore(FILES, { keyPath: ['id', 'path'] });
      };
      request.onsuccess = () => {
        const db = request.result;
        // Opened after giving up on it (blocked): nothing will use it.
        if (blocked) { db.close(); return; }
        // Another tab upgrading later, or the browser (clearing site data, or WebKit's storage
        // restarting), closes the connection; the next use opens it again.
        db.onversionchange = () => { db.close(); forget(); };
        db.onclose = forget;
        resolve(db);
      };
      request.onerror = () => { forget(); reject(request.error ?? Error('Saved songs could not open.')); };
      request.onblocked = () => {
        blocked = true;
        forget();
        reject(Error('Saved songs are open in another tab; close it and try again.'));
      };
    });
    return connection;
  };
  const open = () => opening ??= connect();
  // Our own messages (already about saved songs) stand as they are.
  const unavailable = (error: unknown) => errorText(error).startsWith('Saved songs') ? error
    : Error(`Saved songs aren't available in this browser (${errorText(error)}).`, { cause: error });
  const transaction = async (mode: IDBTransactionMode) => {
    const current = open();
    try { return (await current).transaction([SONGS, FILES], mode); }
    catch (error) {
      // A connection that closed before onclose arrived: open it again, once (callers finding
      // the same closed connection share the new one).
      if (!(error instanceof DOMException && error.name === 'InvalidStateError')) throw unavailable(error);
      if (opening === current) opening = null;
      try { return (await open()).transaction([SONGS, FILES], mode); }
      catch (retry) { throw unavailable(retry); }
    }
  };
  // Runs fn in one transaction over both stores; resolves with its result once it commits.
  const run = async <T>(mode: IDBTransactionMode, fn: (songs: IDBObjectStore, files: IDBObjectStore) => () => T) => {
    const tx = await transaction(mode);
    return new Promise<T>((resolve, reject) => {
      const failed = (error: DOMException | null) => error?.name === 'QuotaExceededError' ? Error(quotaMessage)
        : Error(`Saved songs could not be ${mode === 'readonly' ? 'read' : 'saved'}${error?.message ? ` (${error.message})` : ''}.`, { cause: error });
      let result: () => T;
      // A value the browser won't store (Chromium's limit is about 127 MiB) throws here.
      try { result = fn(tx.objectStore(SONGS), tx.objectStore(FILES)); }
      catch (error) {
        try { tx.abort(); } catch { /* already finished */ }
        reject(failed(error instanceof DOMException ? error : null));
        return;
      }
      tx.oncomplete = () => resolve(result());
      // A failed request aborts the transaction, which then has the error.
      tx.onabort = () => reject(failed(tx.error));
    });
  };
  const record = (value: unknown): CustomSongRecord | undefined =>
    isObject(value) && typeof value.id === 'string' && isObject(value.entry) && value.sizes instanceof Map ? value as unknown as CustomSongRecord : undefined;
  shared = {
    all: () => run('readonly', (songs) => {
      const request = songs.getAll();
      return () => request.result.flatMap((value: unknown) => record(value) ?? []);
    }),
    get: (id) => run('readonly', (songs) => {
      const request = songs.get(id);
      return () => record(request.result);
    }),
    file: (id, path) => run('readonly', (_, files) => {
      const request = files.get([id, path]);
      return () => {
        const value: unknown = request.result;
        return isObject(value) && value.bytes instanceof Uint8Array ? value.bytes as Uint8Array<ArrayBuffer> : undefined;
      };
    }),
    put: (song, contents) => run('readwrite', (songs, files) => {
      files.delete(songFiles(song.id));
      for (const [path, bytes] of contents) files.put({ id: song.id, path, bytes });
      songs.put(song);
      return () => undefined;
    }),
    delete: (id, only) => run('readwrite', (songs, files) => {
      let deleted = false;
      const request = songs.get(id);
      request.onsuccess = () => {
        const saved = record(request.result);
        if (!saved || (only && (saved.entry.bundleRevision !== only.bundleRevision || saved.entry.sha256 !== only.sha256))) return;
        files.delete(songFiles(id));
        songs.delete(id);
        deleted = true;
      };
      return () => deleted;
    }),
  };
  return shared;
}
