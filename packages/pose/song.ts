import { MAX_PLAYERS, assertChoreography, copy, finite, isArray, isObject, isPlayerCount, partOf } from './choreography.ts';
import type { Choreography, ChoreographyCoordinates, ChoreographyTrack, PlayerCount, PoseSnapshot, TrackCalibration } from './choreography.ts';
import { decodePoseFile, framesFromSamples, quantizeConfidence, sampleFrames, sparseSamples } from './binary.ts';
import type { PoseFrames, PoseMarker, SongHeader, TrackHeader } from './binary.ts';

export interface MediaReference { path: string; mimeType: string; }
export interface RightsStatement { license: string; attribution: string; }
/** song.json (aerodance.song v1): a published song bundle's metadata. */
export interface Song {
  schema: 'aerodance.song'; schemaVersion: 1;
  songId: string; bundleRevision: number;
  title: string; artist: string; songwriters: string[]; choreographers: string[];
  durationMs: number; playableStartMs: number; playableEndMs: number;
  /** Every count from 1 up: [1, 2], [1, 2, 3] or [1, 2, 3, 4] (players 3 and 4 dance the duet's parts again). */
  supportedPlayerCounts: PlayerCount[];
  /** A dance stage id (packages/stages); players get openreef for a missing or unknown one. */
  stage?: string;
  coachMode: 'mirror-player'; rigProfile: 'frutiger-seven-bone-v1';
  audio: MediaReference;
  /** Schema 2 is a binary .adpose choreography; schema 1 JSON is still read for one release. */
  choreography: { path: string; schemaVersion: 1 | 2 };
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
/** A song choreography as objects: Studio's compiled timeline, and the schema 1 choreography.json. */
export interface SongTimeline extends Choreography {
  songId: string; coordinates: SongCoordinates; sampling: SamplingPolicy; tracks: SongTrack[];
}
export interface SongTrackHeader extends TrackHeader { calibration: TrackCalibration; }
/** A bundle's decoded choreography, checked against its song.json. */
export interface SongChoreography extends PoseFrames { kind: 'choreography'; song: SongHeader; tracks: SongTrackHeader[]; }
/** A loaded, validated song: what the scorer, the sampler and the replay source consume. */
export interface SongBundle { song: Song; choreography: SongChoreography; }

function require(condition: unknown, message: string): asserts condition { if (!condition) throw Error(message); }
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const strings = (v: unknown) => isArray(v) && v.every(text);
const counts = (v: unknown) => isArray(v) && v.length >= 2 && v.length <= MAX_PLAYERS && v.every((n, i) => n === i + 1);
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
/** Lowercase hex SHA-256 (Web Crypto: browsers' secure contexts and Node). */
export async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
/** An exported song folder's files, by bundle-relative path: on disk, in a ZIP, or saved in the browser. */
export interface SongFolder {
  /** The file's size in bytes; throws if it's missing or isn't a plain file inside the folder. */
  size(path: string): Promise<number>;
  read(path: string): Promise<Uint8Array<ArrayBuffer>>;
}
const MAX_METADATA_BYTES = 1024 * 1024, MAX_ASSET_BYTES = 128 * 1024 * 1024;
/**
 * The catalog entry for an exported song folder named `name`, checking its metadata, that every
 * file it plays is listed in checksums.json at its real size, and song.json's own checksum. The
 * game's bundle loader checks the rest (every file's hash, the choreography) when it's played.
 */
export async function catalogEntry(name: string, folder: SongFolder): Promise<CatalogSong> {
  const json = async (path: string) => {
    if (await folder.size(path) > MAX_METADATA_BYTES) throw Error(`Metadata exceeds size limit: ${path}`);
    return folder.read(path);
  };
  const bytes = await json('song.json');
  const song = validateSong(JSON.parse(new TextDecoder().decode(bytes)));
  if (song.songId !== name) throw Error('Folder name must match songId');
  const checksums: unknown = JSON.parse(new TextDecoder().decode(await json('checksums.json')));
  if (!isObject(checksums) || checksums.schema !== 'aerodance.checksums' || checksums.schemaVersion !== 1 || !isArray(checksums.files) || !checksums.files.every(isObject)) throw Error('Invalid checksums manifest');
  const entries = checksums.files;
  const required = ['song.json', song.audio.path, song.choreography.path, ...(song.cover ? [song.cover.path] : [])];
  if (new Set(required).size !== required.length) throw Error('Conflicting media paths');
  const verified = new Map<string, string>();
  for (const path of required) {
    const matches = entries.filter(entry => entry.path === path);
    const match = matches[0], size = await folder.size(path);
    if (matches.length !== 1 || match.bytes !== size || !Number.isSafeInteger(match.bytes) || size > MAX_ASSET_BYTES ||
      typeof match.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(match.sha256)) throw Error(`Missing or incomplete asset: ${path}`);
    verified.set(path, match.sha256);
  }
  const hash = await sha256(bytes);
  if (verified.get('song.json') !== hash) throw Error('Song metadata checksum mismatch');
  return {
    id: song.songId, title: song.title, artist: song.artist,
    durationMs: song.durationMs, supportedPlayerCounts: song.supportedPlayerCounts,
    bundleRevision: song.bundleRevision, bundle: `${song.songId}/song.json`, sha256: hash,
    ...(song.difficulty ? { difficulty: song.difficulty } : {}),
    ...(song.stage ? { stage: song.stage } : {}),
    ...(song.cover ? { cover: `${song.songId}/${song.cover.path}` } : {}),
  };
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
  require(counts(song.supportedPlayerCounts), 'Song must support one and two players, and may add three and four');
  require(stageId(song.stage), 'Invalid song stage');
  require(song.coachMode === 'mirror-player' && song.rigProfile === 'frutiger-seven-bone-v1', 'Unsupported coach or rig profile');
  const { audio, choreography, cover } = song;
  require(isObject(audio) && text(audio.mimeType) && isObject(choreography) && (choreography.schemaVersion === 1 || choreography.schemaVersion === 2), 'Invalid media references');
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
export function assertSongTimeline(song: unknown, timeline: unknown): asserts timeline is SongTimeline {
  assertSong(song); assertChoreography(timeline);
  checkSongFields(song, timeline);
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
    require(isObject(track) && isObject(calibration) && text(track.label) && isArray(track.unscorableIntervals), 'Invalid track metadata');
    checkTrack(song, calibration, track.unscorableIntervals);
  }
}
function checkTrack(song: Song, calibration: Record<string, unknown>, exclusions: unknown[]) {
  require(calibration.profileVersion === 1 || calibration.profileVersion === 2 && calibration.cameraScaleMode === 'body-relative', 'Invalid track metadata');
  const positive = (v: unknown) => finite(v) && v > 0;
  require(positive(calibration.torsoLength) && finite(calibration.floorY) && isObject(calibration.baseHip) &&
    [calibration.baseHip.x, calibration.baseHip.y, calibration.baseHip.z].every(finite) &&
    (calibration.cameraScaleMode !== 'body-relative' || positive(calibration.bodyTorsoLength)), 'Invalid track calibration');
  for (const interval of exclusions) require(isObject(interval) && finite(interval.startMs) && finite(interval.endMs) &&
    interval.startMs >= song.playableStartMs && interval.startMs < interval.endMs && interval.endMs <= song.playableEndMs && text(interval.reason), 'Invalid score exclusion');
}
/** The binary choreography a timeline publishes: interpolated frames are dropped and rebuilt by the sampler. */
export function songChoreographyFromTimeline(timeline: SongTimeline, extras: { markers?: PoseMarker[]; provenance?: unknown } = {}): SongChoreography {
  const { inputWidth: width, inputHeight: height } = timeline.tracks[0].calibration;
  const maxInterpolationGapMs = timeline.sampling.maxInterpolationGapMs;
  return framesFromSamples({
    kind: 'choreography', playerSlots: 2, input: { width, height }, modelId: null,
    song: { songId: timeline.songId, durationMs: timeline.durationMs, playableStartMs: timeline.playableStartMs, playableEndMs: timeline.playableEndMs,
      maxInterpolationGapMs, confidenceThreshold: quantizeConfidence(timeline.sampling.confidenceThreshold) },
    tracks: timeline.tracks.map((t, slot) => ({ slot, playerId: t.playerId, label: t.label, calibration: t.calibration, exclusions: t.unscorableIntervals })),
    ...extras,
  }, sparseSamples(timeline.samples, 'songTimeMs', maxInterpolationGapMs), 'songTimeMs') as SongChoreography;
}
/** Decodes a bundle's choreography file and checks it against song.json. */
export function validateSongChoreography(song: unknown, bytes: Uint8Array): SongChoreography {
  assertSong(song);
  if (song.choreography.schemaVersion === 1) {
    const timeline: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    assertSongTimeline(song, timeline);
    return songChoreographyFromTimeline(timeline);
  }
  const data = decodePoseFile(bytes);
  require(data.kind === 'choreography' && data.song && data.tracks, 'Expected a choreography file');
  const header = data.song;
  for (const key of ['songId','durationMs','playableStartMs','playableEndMs'] as const) require(song[key] === header[key], `Song/choreography ${key} mismatch`);
  for (const track of data.tracks) {
    require(track.calibration && text(track.label), 'Invalid track metadata');
    checkTrack(song, { ...track.calibration }, track.exclusions);
  }
  return data as SongChoreography;
}
export function sampleSong(bundle: SongBundle, songTimeMs: number, playerCount: PlayerCount): PoseSnapshot {
  require(isPlayerCount(playerCount), 'Invalid player count');
  const { song, choreography } = bundle;
  if (!finite(songTimeMs) || songTimeMs < song.playableStartMs || songTimeMs >= song.playableEndMs) return { poses:[], quality:[] };
  const { poses, quality } = sampleFrames(choreography, songTimeMs, choreography.song.maxInterpolationGapMs);
  // Each player gets their part's pose; with three or four players a part is danced twice.
  const snapshot: PoseSnapshot = { poses: [], quality: [] };
  for (let playerId = 0; playerId < playerCount; playerId++) {
    const part = partOf(playerId, choreography.tracks.length);
    const pose = poses.find(p => p.playerId === part), q = quality.find(p => p.playerId === part);
    if (!pose || !q) continue;
    const own = playerId === part;
    snapshot.poses.push(own ? pose : { playerId, landmarks: copy(pose.landmarks) });
    const mask = own ? q : { ...copy(q), playerId };
    if (choreography.tracks[part].exclusions.some(i => songTimeMs >= i.startMs && songTimeMs < i.endMs)) mask.scoreEligible.fill(false);
    snapshot.quality.push(mask);
  }
  return snapshot;
}
