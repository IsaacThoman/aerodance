import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import type { Connect } from 'vite';
import { catalogEntry, validateCatalog } from '../packages/pose/song.ts';
import type { CatalogSong, SongCatalog } from '../packages/pose/song.ts';
import { isObject } from '../packages/pose/choreography.ts';

export interface DiscoverOptions { warn?: (message: string) => void; }
const errorField = (error: unknown, key: 'code' | 'message') => isObject(error) ? error[key] : undefined;

// Discover exported directories without needing an author-maintained manifest. Each folder is
// checked like an imported song (catalogEntry); full audio/choreography validation remains in the
// game's bundle loader.
export async function discoverSongs(directory: string, { warn = console.warn }: DiscoverOptions = {}): Promise<SongCatalog> {
  let folders: Dirent[];
  try { folders = await readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if (errorField(error, 'code') === 'ENOENT') return { version: 1, songs: [] };
    throw error;
  }
  const songs: CatalogSong[] = [];
  for (const folder of folders.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!folder.isDirectory() || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(folder.name)) continue;
    try {
      const root = await realpath(path.join(directory, folder.name));
      async function file(name: string) {
        const location = await realpath(path.join(root, name));
        if (!location.startsWith(root + path.sep)) throw Error('Asset escapes song directory');
        const info = await stat(location);
        if (!info.isFile()) throw Error(`Missing file: ${name}`);
        return { location, bytes: info.size };
      }
      songs.push(await catalogEntry(folder.name, {
        size: async (name) => (await file(name)).bytes,
        read: async (name) => new Uint8Array(await readFile((await file(name)).location)),
      }));
    } catch (error) { warn(`Skipping song ${folder.name}: ${String(errorField(error, 'message'))}`); }
  }
  return validateCatalog({ version: 1, songs });
}

export function songCatalogMiddleware(directory: string): Connect.NextHandleFunction {
  return async (_req, res, next) => {
    try {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(await discoverSongs(directory)));
    } catch (error) { next(error); }
  };
}
