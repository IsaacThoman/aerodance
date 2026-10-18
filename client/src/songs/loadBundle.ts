import { validateBundlePath, validateSong, validateSongChoreography } from '../../../packages/pose/song.ts';
import type { CatalogSong, ChecksumEntry, ChecksumManifest, SongBundle } from '../../../packages/pose/song.ts';
import { isArray, isObject } from '../../../packages/pose/choreography.ts';

/** A verified bundle, ready to play: its song, choreography and media. */
export interface LoadedSongBundle extends SongBundle { audio: Blob; cover: Blob | null; }
/** The part of fetch the loader uses; replaceable in tests. */
export type Fetcher = (url: URL, init: { signal?: AbortSignal }) => Promise<Response>;
export interface LoadBundleOptions { signal?: AbortSignal; fetcher?: Fetcher; }

const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 192 * 1024 * 1024;
const decode = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder('utf-8', { fatal:true }).decode(bytes));
function assertChecksums(checksums: unknown): asserts checksums is Omit<ChecksumManifest, 'files'> & { files: unknown[] } {
  if (!isObject(checksums) || checksums.schema !== 'aerodance.checksums' || checksums.schemaVersion !== 1 || !isArray(checksums.files)) throw Error('Unsupported checksums manifest');
}
function assertChecksumEntry(file: unknown): asserts file is ChecksumEntry {
  if (!isObject(file)) throw Error('Invalid checksums entry');
  validateBundlePath(file.path);
  if (file.path === 'checksums.json' || typeof file.bytes !== 'number' || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > MAX_FILE_BYTES || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) throw Error('Invalid checksums entry');
}
export async function sha256(bytes: Uint8Array<ArrayBuffer>) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
async function readBytes(url: URL, signal: AbortSignal | undefined, fetcher: Fetcher, limit: number) {
  const response = await fetcher(url, { signal });
  if (!response.ok) throw Error(`Song asset could not load (${response.status}).`);
  if (Number(response.headers.get('content-length')) > limit) throw Error('Song asset exceeds size limit');
  if (!response.body) throw Error('Song asset could not load (empty response).');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw Error('Song asset exceeds size limit');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel(); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
// The catalog selects a pinned revision; all runtime bytes are checked before use.
export async function loadSongBundle(entry: CatalogSong, catalogUrl: string | URL, { signal, fetcher = fetch }: LoadBundleOptions = {}): Promise<LoadedSongBundle> {
  validateBundlePath(entry.bundle);
  const songUrl = new URL(entry.bundle, catalogUrl);
  const root = new URL('.', songUrl);
  const assetUrl = (path: string) => {
    const url = new URL(validateBundlePath(path), root);
    url.searchParams.set('revision', String(entry.bundleRevision));
    return url;
  };
  songUrl.searchParams.set('revision', String(entry.bundleRevision));
  const songBytes = await readBytes(songUrl, signal, fetcher, 1024 * 1024);
  if (entry.sha256 && await sha256(songBytes) !== entry.sha256) throw Error('Catalog song hash mismatch');
  const song = validateSong(decode(songBytes));
  if (song.songId !== entry.id || song.bundleRevision !== entry.bundleRevision) throw Error('Catalog song identity/revision mismatch');
  const checksums = decode(await readBytes(assetUrl('checksums.json'), signal, fetcher, 1024 * 1024));
  assertChecksums(checksums);
  const files = new Map<string, ChecksumEntry>(); let total = 0;
  for (const file of checksums.files) {
    assertChecksumEntry(file);
    if (files.has(file.path)) throw Error('Invalid checksums entry');
    total += file.bytes; files.set(file.path, file);
  }
  if (total > MAX_BUNDLE_BYTES) throw Error('Song bundle exceeds size limit');
  const songPath = songUrl.pathname.slice(root.pathname.length);
  const required = [songPath, song.audio.path, song.choreography.path, ...(song.cover ? [song.cover.path] : [])];
  if (new Set(required).size !== required.length || required.some(p => !files.has(p))) throw Error('Missing or conflicting bundle checksums');
  async function verified(path: string, bytes?: Uint8Array<ArrayBuffer>) {
    const file = files.get(path);
    if (!file) throw Error(`Missing bundle checksum: ${path}`);
    bytes ??= await readBytes(assetUrl(path), signal, fetcher, file.bytes);
    if (bytes.byteLength !== file.bytes || await sha256(bytes) !== file.sha256) throw Error(`Song integrity check failed: ${path}`);
    return bytes;
  }
  await verified(songPath, songBytes);
  const [choreographyBytes, audioBytes, coverBytes] = await Promise.all([
    verified(song.choreography.path), verified(song.audio.path),
    song.cover ? verified(song.cover.path) : undefined,
  ]);
  const choreography = validateSongChoreography(song, choreographyBytes);
  return { song, choreography, audio: new Blob([audioBytes], { type:song.audio.mimeType }),
    cover: song.cover && coverBytes ? new Blob([coverBytes], { type:song.cover.mimeType }) : null };
}
