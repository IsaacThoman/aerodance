// Development-only song fixtures: exercise every stage through the real game flow.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { decodePoseFile, encodePoseFile } from '../packages/pose/binary.ts';
import { sha256, validateSongChoreography } from '../packages/pose/song.ts';
import { STAGE_LIST } from '../packages/stages/catalog.ts';
import { discoverSongs } from './songCatalog.ts';

export async function writeSceneBenchSongs(songs: string) {
  const source = path.join(songs, 'demo-track-1');
  const template = JSON.parse(readFileSync(path.join(source, 'song.json'), 'utf8'));
  for (const [i, { id: stage }] of STAGE_LIST.entries()) {
    const id = `bench-${i}-${stage}`;
    const dir = path.join(songs, id);
    mkdirSync(dir, { recursive: true });
    const song = { ...template, songId: id, title: `Benchmark ${i + 1}: ${stage}`, stage };
    const poses = decodePoseFile(new Uint8Array(readFileSync(path.join(source, template.choreography.path))));
    poses.song!.songId = id;
    const choreography = encodePoseFile(poses);
    validateSongChoreography(song, choreography);
    writeFileSync(path.join(dir, song.choreography.path), choreography);
    cpSync(path.join(source, song.audio.path), path.join(dir, song.audio.path));
    writeFileSync(path.join(dir, 'song.json'), JSON.stringify(song, null, 2) + '\n');
    const files = await Promise.all(['song.json', song.choreography.path, song.audio.path].map(async (file) => {
      const bytes = new Uint8Array(readFileSync(path.join(dir, file)));
      return { path: file, bytes: bytes.length, sha256: await sha256(bytes) };
    }));
    writeFileSync(path.join(dir, 'checksums.json'), JSON.stringify({ schema: 'aerodance.checksums', schemaVersion: 1, files }));
  }
  writeFileSync(path.join(songs, 'manifest.json'), JSON.stringify(await discoverSongs(songs), null, 2) + '\n');
}
