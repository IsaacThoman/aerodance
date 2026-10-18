import { createHash } from 'node:crypto';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { migrateLegacyMotion, validateMotionTake } from '../../packages/pose/legacy.ts';
import { decodeMotion, encodeMotion } from '../../packages/pose/motion.ts';
import { assertSongTimeline, songChoreographyFromTimeline, validateSong } from '../../packages/pose/song.ts';
import { EXTENSION, buildFrames, decodePoseFile, encodePoseFile } from '../../packages/pose/binary.ts';
import type { FrameInput } from '../../packages/pose/binary.ts';
import { finite, isObject, isPlayerCount, validatePoses } from '../../packages/pose/choreography.ts';
import { legacyCaptureFile } from '../choreography/legacyCapture.ts';

const usage = `Usage:
  node tools/pose/migrate-legacy.ts <song bundle directory>     convert choreography.json to choreography.adpose
  node tools/pose/migrate-legacy.ts input.json output.adpose     convert a dance capture (legacy or take JSON) to a take file
  node tools/pose/migrate-legacy.ts input.ndjson output.adpose   convert a Studio records.ndjson capture or a game pose recording`;
const [input, output] = process.argv.slice(2);
if (!input) throw Error(usage);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value, null, 2) + '\n');

/** Rewrites a schema 1 song bundle in place as schema 2, with a new revision and checksums. */
async function convertBundle(directory: string) {
  const songPath = path.join(directory, 'song.json');
  const song = validateSong(JSON.parse(await readFile(songPath, 'utf8')));
  if (song.choreography.schemaVersion !== 1) throw Error(`${songPath} is not a schema 1 song bundle`);
  const legacyPath = path.join(directory, song.choreography.path);
  const timeline: unknown = JSON.parse(await readFile(legacyPath, 'utf8'));
  assertSongTimeline(song, timeline);
  const extras = isObject(timeline) ? {
    markers: Array.isArray(timeline.markers) ? timeline.markers.map(({ songTimeMs, kind, label }) => ({ timeMs: songTimeMs, kind, label })) : undefined,
    provenance: timeline.provenance,
  } : {};
  const bytes = encodePoseFile(songChoreographyFromTimeline(timeline, extras));
  // A new revision keeps cached song.json files (fetched with ?revision=) from naming the deleted JSON.
  const converted = { ...song, bundleRevision: song.bundleRevision + 1, choreography: { path: 'choreography.adpose', schemaVersion: 2 } };
  const checksumsPath = path.join(directory, 'checksums.json');
  // Test fixtures keep only song.json and the choreography; exported bundles have checksums too.
  const checksums: unknown = await readFile(checksumsPath, 'utf8').then(text => JSON.parse(text), () => null);
  if (checksums !== null && (!isObject(checksums) || !Array.isArray(checksums.files))) throw Error(`${checksumsPath} is not a checksums manifest`);
  const files = new Map<string, Uint8Array>([['song.json', json(converted)], ['choreography.adpose', bytes]]);
  for (const entry of isObject(checksums) && Array.isArray(checksums.files) ? checksums.files : []) {
    if (!isObject(entry) || typeof entry.path !== 'string' || files.has(entry.path) || entry.path === song.choreography.path) continue;
    files.set(entry.path, await readFile(path.join(directory, entry.path)));
  }
  await writeFile(path.join(directory, 'choreography.adpose'), bytes);
  await writeFile(songPath, files.get('song.json')!);
  if (checksums) await writeFile(checksumsPath, json({ ...checksums, files: [...files].map(([name, data]) => ({ path: name, bytes: data.length, sha256: sha256(data) })) }));
  await rm(legacyPath);
  console.log(`Converted ${legacyPath} (${timeline.samples.length} samples) to choreography.adpose, ${bytes.length} bytes`);
}

/** A game pose recording (header line, then { songTimeMs, timing, record } lines) as a recording file. */
function convertRecording(lines: unknown[]) {
  const [header, ...entries] = lines;
  if (!isObject(header) || typeof header.songId !== 'string' || !isPlayerCount(header.playerCount) || typeof header.recordedAt !== 'string')
    throw Error('Invalid pose recording header');
  const playerCount = header.playerCount;
  let input: { width: number; height: number } | undefined, timing: string | null = null;
  const frames: FrameInput[] = [];
  for (const entry of entries) {
    if (!isObject(entry) || !finite(entry.songTimeMs) || !isObject(entry.record) || entry.record.type !== 'pose') continue;
    const record = entry.record, size = record.input;
    if (!isObject(size) || !finite(size.width) || !finite(size.height)) continue;
    input ??= { width: size.width, height: size.height };
    if (typeof entry.timing === 'string') timing ??= entry.timing;
    // Replays and webcam records name the capture time differently; old recordings may have neither.
    const capture = record.frameBrowserTimeMs ?? record.frameReceivedTimeMs;
    frames.push({ timeMs: entry.songTimeMs, poses: validatePoses(record.poses).filter(p => p.playerId < playerCount),
      extensions: finite(capture) ? { [EXTENSION.captureBrowserTimeMs]: capture } : {} });
  }
  frames.sort((a, b) => a.timeMs - b.timeMs);
  const ordered = frames.filter((f, i) => !i || f.timeMs > frames[i - 1].timeMs);
  const timed = ordered.length > 0 && ordered.every(f => f.extensions?.[EXTENSION.captureBrowserTimeMs] !== undefined);
  return encodePoseFile(buildFrames({ kind: 'recording', playerSlots: playerCount, input: input ?? { width: 640, height: 480 }, modelId: null,
    extensionIds: timed ? [EXTENSION.captureBrowserTimeMs] : [], provenance: { songId: header.songId, recordedAt: header.recordedAt, timing } }, ordered));
}
/** NDJSON from earlier versions: a Studio capture's records, or a game pose recording. */
function convertNdjson(text: string) {
  const lines: unknown[] = text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
  const first = lines[0];
  if (isObject(first) && first.schema === 'aerodance.pose-recording') return convertRecording(lines);
  // A capture's first line can be an event; its kind is the first pose record's schema.
  const record = lines.find(l => isObject(l) && isObject(l.record));
  const kind = isObject(record) && isObject(record.record) ? record.record.schema : undefined;
  if (kind === 'aerodance.webcam-record') return legacyCaptureFile(text, 'webcam');
  if (kind === 'aerodance.video-record') return legacyCaptureFile(text, 'video');
  throw Error('Unrecognized NDJSON: expected Studio webcam/video capture records or a pose recording');
}

if ((await stat(input)).isDirectory()) await convertBundle(input);
else if (input.endsWith('.ndjson')) {
  if (!output?.endsWith('.adpose')) throw Error(usage);
  const bytes = convertNdjson(await readFile(input, 'utf8')), f = decodePoseFile(bytes);
  await writeFile(output, bytes);
  console.log(`Converted ${f.times.length} frames to a ${f.kind} file ${output}, ${bytes.length} bytes`);
} else {
  if (!output?.endsWith('.adpose')) throw Error(usage);
  const data: unknown = JSON.parse(await readFile(input, 'utf8'));
  const take = isObject(data) && data.version === 1 ? migrateLegacyMotion(data) : validateMotionTake(data);
  const bytes = encodeMotion(take);
  // The file must read back as the same loop.
  if (decodeMotion(bytes).durationMs !== take.durationMs) throw Error('Converted take lost its duration');
  await writeFile(output, bytes);
  console.log(`Converted ${take.samples.length} samples to ${output}, ${bytes.length} bytes`);
}
