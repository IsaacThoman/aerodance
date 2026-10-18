import { createHash } from 'node:crypto';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { migrateLegacyMotion, validateMotionTake } from '../../packages/pose/legacy.ts';
import { decodeMotion, encodeMotion } from '../../packages/pose/motion.ts';
import { assertSongTimeline, songChoreographyFromTimeline, validateSong } from '../../packages/pose/song.ts';
import { encodePoseFile } from '../../packages/pose/binary.ts';
import { isObject } from '../../packages/pose/choreography.ts';

const usage = `Usage:
  node tools/pose/migrate-legacy.ts <song bundle directory>   convert choreography.json to choreography.adpose
  node tools/pose/migrate-legacy.ts input.json output.adpose   convert a dance capture (legacy or take JSON) to a take file`;
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

if ((await stat(input)).isDirectory()) await convertBundle(input);
else {
  if (!output?.endsWith('.adpose')) throw Error(usage);
  const data: unknown = JSON.parse(await readFile(input, 'utf8'));
  const take = isObject(data) && data.version === 1 ? migrateLegacyMotion(data) : validateMotionTake(data);
  const bytes = encodeMotion(take);
  // The file must read back as the same loop.
  if (decodeMotion(bytes).durationMs !== take.durationMs) throw Error('Converted take lost its duration');
  await writeFile(output, bytes);
  console.log(`Converted ${take.samples.length} samples to ${output}, ${bytes.length} bytes`);
}
