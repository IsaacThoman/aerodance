import { isArray, isObject } from '../../../../packages/pose/choreography.ts';
import { validateBundlePath } from '../../../../packages/pose/song.ts';
import type { AppFiles } from '../host.ts';
import type { CustomSongRecord, CustomSongStore } from './customSongs.ts';

/*
 * Saved songs in a folder of the Apple TV app's files (host.ts appFiles: Library/Caches/aerodance/
 * on the device), which has no IndexedDB and no file picker: songs reach it from another device
 * (Settings → Songs → Transfer songs, songs/songTransfer.ts). One folder per song:
 *
 *   songs/<songId>/record.json      its catalog entry, files' sizes and when it was saved
 *   songs/<songId>/files/<path>     each of its files, by bundle-relative path
 *
 * Saving writes the song into incoming/ and then moves its folder into place, so a song is
 * there whole or not at all. tvOS may delete these files when it runs short of space (never
 * while the app runs); a song that's gone is simply no longer listed.
 */

const RECORD = 'record.json';
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
// Song IDs are folder names (packages/pose/song.ts allows only a-z, 0-9 and -; encoded all the same).
const folder = (id: string) => `songs/${encodeURIComponent(id)}`;
const decode = (bytes: ArrayBuffer): unknown => JSON.parse(new TextDecoder().decode(bytes));

function recordOf(value: unknown): CustomSongRecord | undefined {
  if (!isObject(value) || typeof value.id !== 'string' || !isObject(value.entry) || !isArray(value.sizes)) return undefined;
  const sizes = new Map<string, number>();
  for (const pair of value.sizes) if (isArray(pair) && typeof pair[0] === 'string' && Number.isSafeInteger(pair[1])) sizes.set(pair[0], pair[1] as number);
  return { id: value.id, entry: value.entry as unknown as CustomSongRecord['entry'], sizes, importedAt: typeof value.importedAt === 'string' ? value.importedAt : '' };
}

export function folderSongsStore(files: AppFiles, warn: (message: string) => void = console.warn): CustomSongStore {
  // What a save cut short (the app quit partway) left behind.
  files.remove('incoming');
  const read = (id: string) => {
    const bytes = files.read(`${folder(id)}/${RECORD}`);
    if (!bytes) return undefined;
    try { return recordOf(decode(bytes)); }
    catch (error) { warn(`Saved song ${id} can't be read: ${errorText(error)}`); return undefined; }
  };
  const unavailable = (error: unknown) => (error instanceof Error && error.name === 'QuotaExceededError'
    ? Error("There isn't enough storage space on this Apple TV for that song.")
    : Error(`Saved songs aren't available on this Apple TV (${errorText(error)}).`, { cause: error }));
  return {
    all: async () => files.list('songs').filter((entry) => entry.dir).flatMap((entry) => {
      let id: string;
      try { id = decodeURIComponent(entry.name); } catch { return []; }
      const record = read(id);
      return record && record.id === id ? [record] : [];
    }),
    get: async (id) => read(id),
    file: async (id, path) => {
      const bytes = files.read(`${folder(id)}/files/${validateBundlePath(path)}`);
      return bytes ? new Uint8Array(bytes) : undefined;
    },
    put: async (record, contents) => {
      const incoming = `incoming/${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
      try {
        for (const [path, bytes] of contents) files.write(`${incoming}/files/${validateBundlePath(path)}`, bytes);
        files.write(`${incoming}/${RECORD}`, new TextEncoder().encode(JSON.stringify({ ...record, sizes: [...record.sizes] })));
        files.move(incoming, folder(record.id));
      } catch (error) {
        files.remove(incoming);
        throw unavailable(error);
      }
    },
    delete: async (id, only) => {
      const saved = read(id);
      if (!saved || (only && (saved.entry.bundleRevision !== only.bundleRevision || saved.entry.sha256 !== only.sha256))) return false;
      files.remove(folder(id));
      return true;
    },
  };
}
