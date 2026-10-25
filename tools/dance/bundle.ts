// A dance as a game song bundle: <songId>/song.json, choreography.adpose, the audio and
// checksums.json, exactly as Dance Studio exports them (tools/choreography/storage/store.ts), so
// the game installs and imports it the same way (docs/game-song-bundles.md).
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleSongId } from '../choreography/storage/store.ts';
import { encodePoseFile } from '../../packages/pose/binary.ts';
import { catalogEntry, sha256, songChoreographyFromTimeline, validateSongChoreography } from '../../packages/pose/song.ts';
import type { CatalogSong, ChecksumManifest, Song } from '../../packages/pose/song.ts';
import type { PlayerCount } from '../../packages/pose/choreography.ts';
import { makeZip } from '../../packages/pose/zip.ts';
import { DANCE_COMPILER_VERSION, choreographyOf, compileDance } from './compile.ts';
import type { CompiledDance } from './compile.ts';
import type { Dance } from './format.ts';
import type { DanceProject } from './project.ts';

export const GAME_SONGS = fileURLToPath(new URL('../../apps/web/public/songs/', import.meta.url));
const AUDIO_EXTENSIONS = ['wav', 'mp3', 'ogg', 'm4a', 'flac'];

export interface SongBundle { songId: string; song: Song; files: Map<string, Uint8Array<ArrayBuffer>>; compiled: CompiledDance; entry: CatalogSong; }
/** Why a dance can't be published yet, as fixes to make. */
export function exportBlockers(dance: Dance): string[] {
  const out: string[] = [];
  if (!dance.sources.audio) out.push('Add song audio: `dance init --audio` or import a video with sound');
  if (!dance.song.title.trim()) out.push('Set the title: {"op":"song","set":{"title":"…"}}');
  if (!dance.song.artist.trim()) out.push('Set the artist: {"op":"song","set":{"artist":"…"}}');
  const ext = dance.sources.audio?.path.split('.').pop()?.toLowerCase();
  if (ext && !AUDIO_EXTENSIONS.includes(ext)) out.push(`The game plays ${AUDIO_EXTENSIONS.join(', ')} audio, not .${ext}`);
  return out;
}
export async function songBundle(project: DanceProject, dance: Dance): Promise<SongBundle> {
  const blockers = exportBlockers(dance);
  if (blockers.length) throw Error(`Can't export yet:\n- ${blockers.join('\n- ')}`);
  const audioRef = dance.sources.audio!;
  const audio = new Uint8Array(await readFile(project.resolve(audioRef.path)));
  if (await sha256(audio) !== audioRef.sha256) throw Error(`${audioRef.path} changed since it was added (hash mismatch)`);
  const compiled = compileDance(dance);
  // The id comes from the audio and what the game plays and scores (the poses, calibration and
  // unscored intervals), not the names, markers or provenance: renaming a dancer or adding a
  // phrase keeps it, changing the dance gives a new one.
  const motion = { ...compiled.timeline, songId: '', tracks: compiled.timeline.tracks.map((t, i) => ({ ...t, label: `Dancer ${i + 1}` })) };
  const songId = await bundleSongId(audioRef.sha256, songChoreographyFromTimeline(motion));
  const extension = audioRef.path.split('.').pop()!.toLowerCase(), audioPath = `audio.${extension}`;
  const revision = Math.max(1, dance.revision);
  const now = new Date().toISOString();
  const song: Song = {
    schema: 'aerodance.song', schemaVersion: 1, songId, bundleRevision: revision,
    title: dance.song.title, artist: dance.song.artist, songwriters: dance.song.songwriters, choreographers: dance.song.choreographers,
    difficulty: dance.song.difficulty, stage: dance.song.stage, tags: dance.song.tags, description: dance.song.description,
    ...(dance.song.bpm ? { bpm: dance.song.bpm } : {}),
    durationMs: dance.song.durationMs, playableStartMs: dance.song.playableStartMs, playableEndMs: dance.song.playableEndMs,
    supportedPlayerCounts: [1, 2, 3, 4], dancers: dance.dancers.length as PlayerCount,
    coachMode: 'mirror-player', rigProfile: 'frutiger-seven-bone-v1',
    audio: { path: audioPath, mimeType: audioRef.mimeType },
    choreography: { path: 'choreography.adpose', schemaVersion: 2 },
    rights: { audio: { license: 'unknown', attribution: '' }, choreography: { license: 'unknown', attribution: '' } },
    createdAt: dance.createdAt, publishedAt: now,
    build: { compilerVersion: `dance-${DANCE_COMPILER_VERSION}`, projectRevision: dance.revision },
  };
  const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v, null, 2) + '\n');
  const files = new Map<string, Uint8Array<ArrayBuffer>>([
    ['song.json', json(song)],
    ['choreography.adpose', encodePoseFile(choreographyOf(compiled, songId))],
    [audioPath, audio],
  ]);
  const checksums: ChecksumManifest = { schema: 'aerodance.checksums', schemaVersion: 1,
    files: await Promise.all([...files].map(async ([p, bytes]) => ({ path: p, bytes: bytes.length, sha256: await sha256(bytes) }))) };
  files.set('checksums.json', json(checksums));
  // The checks the game runs before listing and playing a song.
  validateSongChoreography(song, files.get('choreography.adpose')!);
  const entry = await catalogEntry(songId, {
    size: async p => { const f = files.get(p); if (!f) throw Error(`Missing ${p}`); return f.length; },
    read: async p => { const f = files.get(p); if (!f) throw Error(`Missing ${p}`); return f; },
  });
  for (const e of checksums.files) if (await sha256(files.get(e.path)!) !== e.sha256) throw Error(`Checksum mismatch for ${e.path}`);
  return { songId, song, files, compiled, entry };
}
/** The bundle as a ZIP of one <songId>/ folder, as the game's Import song expects. */
export const bundleZip = (bundle: SongBundle) => makeZip(new Map([...bundle.files].map(([p, b]) => [`${bundle.songId}/${p}`, b])));
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
