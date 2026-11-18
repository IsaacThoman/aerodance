// A dance project on disk as a game song bundle (packages/dance/bundle.ts builds it), and
// installing one into the game's songs folder.
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSongBundle } from '../../packages/dance/bundle.ts';
import type { SongBundle } from '../../packages/dance/bundle.ts';
import type { Dance } from './format.ts';
import type { DanceProject } from './project.ts';

export { bundleZip, exportBlockers } from '../../packages/dance/bundle.ts';
export type { SongBundle } from '../../packages/dance/bundle.ts';
export const GAME_SONGS = fileURLToPath(new URL('../../apps/web/public/songs/', import.meta.url));

export async function songBundle(project: DanceProject, dance: Dance): Promise<SongBundle> {
  const audioRef = dance.sources.audio;
  const audio = audioRef ? new Uint8Array(await readFile(project.resolve(audioRef.path))) : new Uint8Array();
  return buildSongBundle(dance, audio, { takes: await project.takes(dance) });
}
/**
 * Writes the bundle's folder into `songsDir` (the game's apps/web/public/songs by default),
 * replacing an older copy. Changing the motion changes the song id, so the folder this project
 * installed last time (recorded under .dance) is removed rather than left as a second song.
 */
export async function installBundle(bundle: SongBundle, songsDir = GAME_SONGS, project?: DanceProject): Promise<string> {
  const folder = path.join(songsDir, bundle.songId);
  const record = project?.meta('installed.json');
  if (record) {
    const previous = await readFile(record, 'utf8').then(t => JSON.parse(t) as { folder?: string }, () => ({ folder: undefined }));
    // Only a folder this project installed, inside the songs folder, that still holds a song.
    if (previous.folder && previous.folder !== folder && path.dirname(previous.folder) === path.resolve(songsDir) && existsSync(path.join(previous.folder, 'song.json')))
      await rm(previous.folder, { recursive: true, force: true });
  }
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder, { recursive: true });
  for (const [p, bytes] of bundle.files) await writeFile(path.join(folder, p), bytes);
  if (record) { await mkdir(path.dirname(record), { recursive: true }); await writeFile(record, JSON.stringify({ folder }) + '\n'); }
  return folder;
}
