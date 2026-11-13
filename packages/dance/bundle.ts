// A dance as a game song bundle: <songId>/song.json, choreography.adpose, the audio and
// checksums.json (docs/game-song-bundles.md). Nothing here touches a filesystem, so the browser
// app and the CLI build the same bundle from the same bytes.
import { encodePoseFile } from '../pose/binary.ts';
import { bundleSongId, catalogEntry, sha256, songChoreographyFromTimeline, validateSongChoreography } from '../pose/song.ts';
import type { CatalogSong, ChecksumManifest, Song } from '../pose/song.ts';
import type { PlayerCount } from '../pose/choreography.ts';
import { makeZip } from '../pose/zip.ts';
import { DANCE_COMPILER_VERSION, choreographyOf, compileDance } from './compile.ts';
import type { CompiledDance } from './compile.ts';
import type { TakeLookup } from './evaluate.ts';
import type { Dance } from './format.ts';
import { performanceOf } from './performance.ts';

/** The audio the game plays, by file extension. */
export const AUDIO_EXTENSIONS = ['wav', 'mp3', 'ogg', 'm4a', 'flac'];
export interface SongBundle { songId: string; song: Song; files: Map<string, Uint8Array<ArrayBuffer>>; compiled: CompiledDance; entry: CatalogSong; }
export interface Blocker { message: string; hint: string; }
/** Why a dance can't be published yet: what's missing, and (for the CLI) the op that fixes it. */
export function exportIssues(dance: Dance): Blocker[] {
  const out: Blocker[] = [];
  if (!dance.sources.audio) out.push({ message: 'Add song audio', hint: '`dance init --audio` or import a video with sound' });
  if (!dance.song.title.trim()) out.push({ message: 'Set the title', hint: '{"op":"song","set":{"title":"…"}}' });
  if (!dance.song.artist.trim()) out.push({ message: 'Set the artist', hint: '{"op":"song","set":{"artist":"…"}}' });
  const ext = dance.sources.audio?.path.split('.').pop()?.toLowerCase();
  if (ext && !AUDIO_EXTENSIONS.includes(ext)) out.push({ message: `The game plays ${AUDIO_EXTENSIONS.join(', ')} audio, not .${ext}`, hint: 'attach the music in one of those formats' });
  return out;
}
export const exportBlockers = (dance: Dance): string[] => exportIssues(dance).map(b => `${b.message}: ${b.hint}`);

/** Builds the bundle from the dance and its audio file's bytes (checked against the dance's hash). */
export async function buildSongBundle(dance: Dance, audio: Uint8Array<ArrayBuffer>, { takes, now = new Date().toISOString() }: { takes?: TakeLookup; now?: string } = {}): Promise<SongBundle> {
  const blockers = exportBlockers(dance);
  if (blockers.length) throw Error(`Can't export yet:\n- ${blockers.join('\n- ')}`);
  const audioRef = dance.sources.audio!;
  if (await sha256(audio) !== audioRef.sha256) throw Error(`${audioRef.path} changed since it was added (hash mismatch)`);
  const compiled = compileDance(dance, { takes });
  // The id comes from the audio and what the game plays and scores (the poses, calibration and
  // unscored intervals), not the names, markers or provenance: renaming a dancer or adding a
  // phrase keeps it, changing the dance gives a new one.
  const motion = { ...compiled.timeline, songId: '', tracks: compiled.timeline.tracks.map((t, i) => ({ ...t, label: `Dancer ${i + 1}` })) };
  const performance = performanceOf(dance);
  const performanceBytes = performance ? new TextEncoder().encode(JSON.stringify(performance)) : undefined;
  const songId = await bundleSongId(audioRef.sha256, songChoreographyFromTimeline(motion), performanceBytes);
  const extension = audioRef.path.split('.').pop()!.toLowerCase(), audioPath = `audio.${extension}`;
  const revision = Math.max(1, dance.revision);
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
    ...(performance ? { performance: { path: 'performance.json', schemaVersion: 1 as const } } : {}),
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
  if (performanceBytes) files.set('performance.json', performanceBytes);
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
/** The ZIP's file name, as the game's own exports are named. */
export const bundleFileName = (bundle: SongBundle) => `${bundle.songId}-r${bundle.song.bundleRevision}.aerodance-song.zip`;
