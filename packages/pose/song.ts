import { assertChoreography, finite, isArray, isObject, isPlayerCount, sampleSnapshot } from './choreography.ts';
import type { Choreography, ChoreographyCoordinates, ChoreographyTrack, PlayerCount, PoseSnapshot } from './choreography.ts';

export interface MediaReference { path: string; mimeType: string; }
export interface RightsStatement { license: string; attribution: string; }
/** song.json (aerodance.song v1): a published song bundle's metadata. */
export interface Song {
  schema: 'aerodance.song'; schemaVersion: 1;
  songId: string; bundleRevision: number;
  title: string; artist: string; songwriters: string[]; choreographers: string[];
  durationMs: number; playableStartMs: number; playableEndMs: number;
  /** Always both modes, [1, 2]. */
  supportedPlayerCounts: PlayerCount[];
  /** A dance stage id (packages/stages); players get openreef for a missing or unknown one. */
  stage?: string;
  coachMode: 'mirror-player'; rigProfile: 'frutiger-seven-bone-v1';
  audio: MediaReference;
  choreography: { path: string; schemaVersion: 1 };
  cover?: MediaReference | null;
  rights: { audio: RightsStatement; choreography: RightsStatement };
  createdAt: string; publishedAt: string;
  build: { compilerVersion: string; projectRevision: number };
  // Display metadata the game does not validate.
  difficulty?: unknown; tags?: unknown; bpm?: unknown; description?: unknown;
}
/** One song in the catalog (songs/index.json), pointing at its song.json. */
export interface CatalogSong {
  id: string; title: string; artist: string; durationMs: number;
  bundleRevision: number; supportedPlayerCounts: PlayerCount[];
  /** Bundle-relative path of song.json. */
  bundle: string;
  cover?: string; sha256?: string; stage?: string;
  difficulty?: unknown;
}
export interface SongCatalog { version: 1; songs: CatalogSong[]; }
/** checksums.json in a song bundle. */
export interface ChecksumEntry { path: string; bytes: number; sha256: string; }
export interface ChecksumManifest { schema: 'aerodance.checksums'; schemaVersion: 1; files: ChecksumEntry[]; }
export interface ScoreExclusion { startMs: number; endMs: number; reason: string; }
export interface SongTrack extends ChoreographyTrack { label: string; unscorableIntervals: ScoreExclusion[]; }
export interface SamplingPolicy { targetRateHz: number; maxInterpolationGapMs: number; confidenceThreshold: number; }
export interface SongCoordinates extends ChoreographyCoordinates {
  ordering: 'mediapipe-pose-33'; xAxis: 'right'; yAxis: 'down'; zAxis: 'away-from-camera'; depthUnit: 'relative-image-width';
}
/** A bundle's choreography.json, checked against its song.json. */
export interface SongChoreography extends Choreography {
  songId: string; coordinates: SongCoordinates; sampling: SamplingPolicy; tracks: SongTrack[];
}
/** A loaded, validated song: what the scorer, the sampler and the replay source consume. */
export interface SongBundle { song: Song; choreography: SongChoreography; }

function require(condition: unknown, message: string): asserts condition { if (!condition) throw Error(message); }
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const strings = (v: unknown) => isArray(v) && v.every(text);
const counts = (v: unknown) => isArray(v) && v.length === 2 && v[0] === 1 && v[1] === 2;
const revision = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const SONG_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
// A dance stage id (packages/stages). Players get openreef for a missing or unknown one.
const stageId = (v: unknown) => v === undefined || (typeof v === 'string' && /^[a-z0-9-]{1,40}$/.test(v));
export function validateBundlePath(path: unknown): string {
  require(typeof path === 'string' && /^[a-zA-Z0-9_./-]+$/.test(path) &&
    path.split('/').every(part => part && part !== '.' && part !== '..'), 'Invalid bundle asset path');
  return path;
}
export function assertCatalog(data: unknown): asserts data is SongCatalog {
  require(isObject(data) && data.version === 1 && isArray(data.songs), 'Song catalog format is unsupported.');
  const ids = new Set<string>();
  for (const song of data.songs) {
    require(isObject(song) && typeof song.id === 'string' && SONG_ID.test(song.id) && !ids.has(song.id), 'Invalid or duplicate catalog song ID');
    ids.add(song.id);
    require(text(song.title) && text(song.artist) && finite(song.durationMs) && song.durationMs > 0 &&
      revision(song.bundleRevision) && counts(song.supportedPlayerCounts), 'Invalid catalog song');
    validateBundlePath(song.bundle);
    if (song.cover !== undefined) validateBundlePath(song.cover);
    if (song.sha256 !== undefined) require(typeof song.sha256 === 'string' && /^[a-f0-9]{64}$/.test(song.sha256), 'Invalid catalog song hash');
    require(stageId(song.stage), 'Invalid catalog song stage');
  }
}
export function validateCatalog(data: unknown): SongCatalog {
  assertCatalog(data);
  return data;
}
const rights = (v: unknown) => isObject(v) && text(v.license) && typeof v.attribution === 'string';
const timestamp = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v));
export function assertSong(song: unknown): asserts song is Song {
  require(isObject(song) && song.schema === 'aerodance.song' && song.schemaVersion === 1, 'Unsupported song schema');
  require(typeof song.songId === 'string' && SONG_ID.test(song.songId) && revision(song.bundleRevision), 'Invalid song identity');
  require(text(song.title) && text(song.artist) && strings(song.songwriters) && strings(song.choreographers), 'Invalid song credits');
  const { durationMs, playableStartMs, playableEndMs } = song;
  require(finite(durationMs) && durationMs > 0 && finite(playableStartMs) && finite(playableEndMs) &&
    0 <= playableStartMs && playableStartMs < playableEndMs && playableEndMs <= durationMs, 'Invalid playable interval');
  require(counts(song.supportedPlayerCounts), 'Song must support both player modes');
  require(stageId(song.stage), 'Invalid song stage');
  require(song.coachMode === 'mirror-player' && song.rigProfile === 'frutiger-seven-bone-v1', 'Unsupported coach or rig profile');
  const { audio, choreography, cover } = song;
  require(isObject(audio) && text(audio.mimeType) && isObject(choreography) && choreography.schemaVersion === 1, 'Invalid media references');
  validateBundlePath(audio.path); validateBundlePath(choreography.path);
  if (cover) {
    const fields: Record<string, unknown> = isObject(cover) ? cover : {};
    validateBundlePath(fields.path); require(text(fields.mimeType), 'Invalid cover type');
  }
  require(isObject(song.rights) && rights(song.rights.audio) && rights(song.rights.choreography), 'Missing rights metadata');
  require(timestamp(song.createdAt) && timestamp(song.publishedAt), 'Invalid song timestamps');
  const build = song.build;
  require(isObject(build) && text(build.compilerVersion) && typeof build.projectRevision === 'number' && Number.isSafeInteger(build.projectRevision) && build.projectRevision >= 0, 'Missing build identity');
}
export function validateSong(song: unknown): Song {
  assertSong(song);
  return song;
}
export function assertSongChoreography(song: unknown, choreography: unknown): asserts choreography is SongChoreography {
  assertSong(song); assertChoreography(choreography);
  checkSongFields(song, choreography);
}
// The song-level fields beyond the base choreography format, read from the untrusted object.
function checkSongFields(song: Song, data: unknown) {
  require(isObject(data) && isArray(data.tracks), 'Both tracks are required');
  for (const key of ['songId','durationMs','playableStartMs','playableEndMs'] as const) require(song[key] === data[key], `Song/choreography ${key} mismatch`);
  const c = data.coordinates;
  require(isObject(c) && c.ordering === 'mediapipe-pose-33' && c.xAxis === 'right' && c.yAxis === 'down' &&
    c.zAxis === 'away-from-camera' && c.depthUnit === 'relative-image-width', 'Unsupported coordinate axes');
  const s = data.sampling;
  require(isObject(s) && finite(s.targetRateHz) && s.targetRateHz > 0 && finite(s.maxInterpolationGapMs) &&
    s.maxInterpolationGapMs > 0 && s.maxInterpolationGapMs <= 200 && finite(s.confidenceThreshold) &&
    s.confidenceThreshold >= 0 && s.confidenceThreshold <= 1, 'Invalid sampling policy');
  for (const track of data.tracks) {
    const calibration = isObject(track) ? track.calibration : undefined;
    require(isObject(track) && isObject(calibration) && (calibration.profileVersion===1 || calibration.profileVersion===2 && calibration.cameraScaleMode==='body-relative') && text(track.label) && isArray(track.unscorableIntervals), 'Invalid track metadata');
    for (const interval of track.unscorableIntervals) require(isObject(interval) && finite(interval.startMs) && finite(interval.endMs) &&
      interval.startMs >= song.playableStartMs && interval.startMs < interval.endMs && interval.endMs <= song.playableEndMs && text(interval.reason), 'Invalid score exclusion');
  }
}
export function validateSongChoreography(song: unknown, choreography: unknown): SongChoreography {
  assertSongChoreography(song, choreography);
  return choreography;
}
export function sampleSong(bundle: SongBundle, songTimeMs: number, playerCount: PlayerCount): PoseSnapshot {
  require(isPlayerCount(playerCount), 'Invalid player count');
  const { song, choreography } = bundle;
  if (!finite(songTimeMs) || songTimeMs < song.playableStartMs || songTimeMs >= song.playableEndMs) return { poses:[], quality:[] };
  const snapshot = sampleSnapshot(choreography.samples, songTimeMs, 'songTimeMs', choreography.sampling.maxInterpolationGapMs);
  snapshot.poses = snapshot.poses.filter(p => p.playerId < playerCount);
  snapshot.quality = snapshot.quality.filter(q => q.playerId < playerCount);
  for (const q of snapshot.quality) {
    if (choreography.tracks[q.playerId].unscorableIntervals.some(i => songTimeMs >= i.startMs && songTimeMs < i.endMs)) q.scoreEligible.fill(false);
  }
  return snapshot;
}
