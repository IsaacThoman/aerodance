import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Connect } from 'vite';
import { validateCatalog, validateSong } from '../packages/pose/song.ts';
import type { CatalogSong, SongCatalog } from '../packages/pose/song.ts';
import { isArray, isObject } from '../packages/pose/choreography.ts';

export interface DiscoverOptions { warn?: (message: string) => void; }
const errorField = (error: unknown, key: 'code' | 'message') => isObject(error) ? error[key] : undefined;

// Discover exported directories without needing an author-maintained manifest.
// Full audio/choreography validation remains in the game's bundle loader.
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
      async function json(name: string) {
        const info = await file(name);
        if (info.bytes > 1024 * 1024) throw Error(`Metadata exceeds size limit: ${name}`);
        return readFile(info.location);
      }
      const bytes = await json('song.json');
      const song = validateSong(JSON.parse(bytes.toString()));
      if (song.songId !== folder.name) throw Error('Folder name must match songId');
      const checksums: unknown = JSON.parse((await json('checksums.json')).toString());
      if (!isObject(checksums) || checksums.schema !== 'aerodance.checksums' || checksums.schemaVersion !== 1 || !isArray(checksums.files) || !checksums.files.every(isObject)) throw Error('Invalid checksums manifest');
      const entries = checksums.files;
      const required = ['song.json', song.audio.path, song.choreography.path, ...(song.cover ? [song.cover.path] : [])];
      if (new Set(required).size !== required.length) throw Error('Conflicting media paths');
      const verified = new Map<string, string>();
      for (const name of required) {
        const matches = entries.filter(entry => isObject(entry) && entry.path === name);
        const match = matches[0], info = await file(name);
        if (matches.length !== 1 || !isObject(match) || match.bytes !== info.bytes || !Number.isSafeInteger(match.bytes) || info.bytes > 128 * 1024 * 1024 ||
          typeof match.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(match.sha256)) throw Error(`Missing or incomplete asset: ${name}`);
        verified.set(name, match.sha256);
      }
      const hash = createHash('sha256').update(bytes).digest('hex');
      if (verified.get('song.json') !== hash) throw Error('Song metadata checksum mismatch');
      songs.push({
        id: song.songId, title: song.title, artist: song.artist,
        durationMs: song.durationMs, supportedPlayerCounts: song.supportedPlayerCounts,
        bundleRevision: song.bundleRevision, bundle: `${song.songId}/song.json`, sha256: hash,
        ...(song.difficulty ? { difficulty: song.difficulty } : {}),
        ...(song.stage ? { stage: song.stage } : {}),
        ...(song.cover ? { cover: `${song.songId}/${song.cover.path}` } : {}),
      });
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
