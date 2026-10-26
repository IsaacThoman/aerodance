// Saved-song test helpers (songs/customSongs.ts): a song's export files, its ZIP, and a store in memory.
import { createHash } from 'node:crypto';
import { makeZip } from '../../../../packages/pose/zip.ts';
import type { CustomSongRecord, CustomSongStore } from '../../src/songs/customSongs.ts';
import { bundleFixture, choreographyBytes } from '../fixtures/songBundle.ts';
import type { BundleFixture } from '../fixtures/songBundle.ts';
import type { Performance } from '../../../../packages/pose/performance.ts';

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
export const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** A song's export files (song.json, choreography, audio, checksums.json) by bundle path. */
export function bundleFiles(fixture: BundleFixture = bundleFixture(), performance?: Performance) {
  if (performance) fixture.song.performance = { path: 'performance.json', schemaVersion: 1 };
  const files = new Map<string, Uint8Array>([
    ['song.json', encode(fixture.song)], ['choreography.adpose', choreographyBytes(fixture)], ['audio.wav', fixture.audio],
  ]);
  if (performance) files.set('performance.json', encode(performance));
  files.set('checksums.json', encode({ schema: 'aerodance.checksums', schemaVersion: 1, files: [...files].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha(bytes) })) }));
  return files;
}
/** A ZIP like Dance Studio's export: everything in one <folder>/ (none: at the top level), plus extras. */
export function exportZip(files = bundleFiles(), { folder = 'fixture', extra = {} }: { folder?: string; extra?: Record<string, Uint8Array> } = {}) {
  const prefix = folder ? `${folder}/` : '';
  const entries = new Map([...files].map(([path, bytes]) => [prefix + path, bytes]));
  for (const [path, bytes] of Object.entries(extra)) entries.set(path, bytes);
  return new Blob([makeZip(entries)]);
}
export function memoryStore(): CustomSongStore & { records: Map<string, CustomSongRecord>; files: Map<string, Map<string, Uint8Array<ArrayBuffer>>> } {
  const records = new Map<string, CustomSongRecord>(), files = new Map<string, Map<string, Uint8Array<ArrayBuffer>>>();
  return {
    records, files,
    all: async () => [...records.values()],
    get: async (id) => records.get(id),
    file: async (id, path) => files.get(id)?.get(path),
    put: async (record, contents) => { records.set(record.id, record); files.set(record.id, new Map(contents)); },
    delete: async (id, only) => {
      const saved = records.get(id);
      if (!saved || (only && (saved.entry.bundleRevision !== only.bundleRevision || saved.entry.sha256 !== only.sha256))) return false;
      records.delete(id);
      files.delete(id);
      return true;
    },
  };
}
