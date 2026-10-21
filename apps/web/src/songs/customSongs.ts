import { catalogEntry, validateBundlePath } from '../../../../packages/pose/song.ts';
import type { CatalogSong, SongFolder } from '../../../../packages/pose/song.ts';
import { isArray, isObject } from '../../../../packages/pose/choreography.ts';
import { readZip } from '../../../../packages/pose/zip.ts';
import { inApp } from '../host.ts';
import { MAX_BUNDLE_BYTES, loadSongBundle } from './loadBundle.ts';
import type { Fetcher } from './loadBundle.ts';

/*
 * Songs imported into this browser: the ZIPs Dance Studio exports (<songId>-r<n>.aerodance-song.zip,
 * one <songId>/ folder of song.json, checksums.json, choreography, audio and cover), kept in
 * IndexedDB and listed in Song Select after the published songs.
 *
 *   importSongZip(file, { confirmReplace })   checks it fully (catalogEntry, then loadSongBundle),
 *                                             then saves it in one transaction
 *   listCustomSongs()                         the saved songs' catalog entries, checked again
 *   loadCustomSong(entry, { signal })         loadSongBundle over the saved files
 *   removeCustomSong(id)
 *
 * They're kept apart from published songs: an imported song can share a published song's ID,
 * and its best scores are kept under custom:<id> (customScoreId). Only the files checksums.json
 * lists are kept, as bytes rather than Blobs (WebKit won't store Blobs in a private window), one
 * record each so the list doesn't read every song's audio. The Apple TV app (no IndexedDB or
 * file picker) and the iPhone/iPad app (WebKit may clear its storage) don't offer importing
 * (customSongsSupported).
 */

/** A saved song: its catalog entry and its files' sizes by bundle-relative path. */
export interface CustomSongRecord { id: string; entry: CatalogSong; sizes: Map<string, number>; importedAt: string; }
/** Where saved songs live; IndexedDB in the browser (indexedDBStore), Maps in tests. */
export interface CustomSongStore {
  all(): Promise<CustomSongRecord[]>;
  get(id: string): Promise<CustomSongRecord | undefined>;
  file(id: string, path: string): Promise<Uint8Array<ArrayBuffer> | undefined>;
  /** Saves a song and its files, in place of any saved before under its ID, all or nothing. */
  put(record: CustomSongRecord, files: ReadonlyMap<string, Uint8Array<ArrayBuffer>>): Promise<void>;
  delete(id: string): Promise<void>;
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

/** Importing needs IndexedDB and a file picker, in a browser rather than one of the apps. */
export const customSongsSupported = () =>
  typeof indexedDB !== 'undefined' && typeof HTMLInputElement !== 'undefined' && !inApp();

const ZIP_NOISE = (path: string) => path.startsWith('__MACOSX/') || /(^|\/)(\.DS_Store|\._[^/]*)$/.test(path);
const decodeJson = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(bytes));
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

// A song folder over a file lookup by bundle-relative path (and optionally known sizes).
function folderOf(file: (path: string) => Promise<Uint8Array<ArrayBuffer> | undefined>, sizes?: ReadonlyMap<string, number>): SongFolder {
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
export async function importSongZip(file: Blob, { store = indexedDBStore(), confirmReplace = () => false }: ImportOptions = {}): Promise<ImportResult> {
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
  if (saved && saved.entry.bundleRevision >= entry.bundleRevision && !await confirmReplace(saved.entry, entry)) {
    return { status: 'kept', entry: saved.entry, previousRevision };
  }
  const sizes = new Map([...kept].map(([path, bytes]) => [path, bytes.byteLength]));
  await store.put({ id: entry.id, entry, sizes, importedAt: new Date().toISOString() }, kept);
  void keepStorage();
  return { status: saved ? 'replaced' : 'imported', entry, ...(saved ? { previousRevision } : {}) };
}

// Asks the browser not to clear saved songs to make room, unless it already won't. It may say no;
// Firefox asks the player.
async function keepStorage() {
  const storage = globalThis.navigator?.storage;
  try { if (storage?.persist && !await storage.persisted?.()) await storage.persist(); }
  catch { /* not offered */ }
}

/** The saved songs' catalog entries by title, checked again (a damaged one is left out). */
export async function listCustomSongs(store: CustomSongStore = indexedDBStore(), warn: (message: string) => void = console.warn): Promise<CatalogSong[]> {
  const songs: CatalogSong[] = [];
  for (const record of await store.all()) {
    try { songs.push(await catalogEntry(record.id, folderOf((path) => store.file(record.id, path), record.sizes))); }
    catch (error) { warn(`Skipping imported song ${record.id}: ${errorText(error)}`); }
  }
  return songs.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

/** A saved song, verified like a published one (loadSongBundle). */
export function loadCustomSong(entry: CatalogSong, { signal, store = indexedDBStore() }: { signal?: AbortSignal; store?: CustomSongStore } = {}) {
  const fetcher = folderFetcher(entry.id, (path) => store.file(entry.id, path));
  return loadSongBundle(entry, CUSTOM_CATALOG_URL, { signal, fetcher, scoreId: customScoreId(entry.id) });
}

export const removeCustomSong = (id: string, store: CustomSongStore = indexedDBStore()) => store.delete(id);

// When the browser hasn't room to save a song.
const quotaMessage = "There isn't enough storage space in this browser for that song.";

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
  const transaction = async (mode: IDBTransactionMode) => {
    try { return (await open()).transaction([SONGS, FILES], mode); }
    catch (error) {
      // A connection that closed before onclose arrived: open it again, once.
      if (!(error instanceof DOMException && error.name === 'InvalidStateError')) throw error;
      opening = connect();
      return (await opening).transaction([SONGS, FILES], mode);
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
    delete: (id) => run('readwrite', (songs, files) => {
      files.delete(songFiles(id));
      songs.delete(id);
      return () => undefined;
    }),
  };
  return shared;
}
