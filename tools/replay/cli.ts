#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readSession, summarizeSession } from './session.ts';

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(`${command}: ${result.stderr}`);
  return result.stdout;
}
/** Resample variable-rate camera video to the scene contract's evenly timed, 1-based frames. */
async function frames(video: string, outdir: string) {
  const probe = JSON.parse(run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,avg_frame_rate,r_frame_rate', '-of', 'json', video]));
  const stream = probe.streams[0];
  if (!stream) throw Error('No video stream');
  const rate = (text: string) => { const [n, d = 1] = text.split('/').map(Number); return n / d; };
  const fps = rate(stream.avg_frame_rate) || rate(stream.r_frame_rate);
  if (!Number.isFinite(fps) || fps <= 0) throw Error('Cannot determine video frame rate');
  // Refuse to mix with a previous extraction or overwrite evidence.
  await mkdir(outdir, { recursive: true });
  if ((await readdir(outdir)).length) throw Error('Output directory must be empty');
  const folder = path.join(outdir, 'frames');
  await mkdir(folder);
  run('ffmpeg', ['-nostdin', '-n', '-v', 'error', '-noautorotate', '-i', video, '-map', '0:v:0',
    '-vf', `fps=${fps}`, '-q:v', '2', '-start_number', '1', path.join(folder, '%06d.jpg')]);
  const count = (await readdir(folder)).filter(name => name.endsWith('.jpg')).length;
  await writeFile(path.join(outdir, 'meta.json'), JSON.stringify({ fps, resolution: [stream.width, stream.height],
    frames: count, source: path.resolve(video), timing: 'Frame n: (n - 1) * 1000 / fps milliseconds from video start; resampled to constant fps.' }, null, 2) + '\n');
  console.log(`Extracted ${count} frames at ${fps} fps (${stream.width}×${stream.height}) to ${outdir}`);
}
try {
  const [command, file, outdir] = process.argv.slice(2);
  if (command === 'summary' && file) console.log(JSON.stringify(summarizeSession(await readSession(file)), null, 2));
  else if (command === 'frames' && file && outdir) await frames(file, outdir);
  else throw Error('Usage: node tools/replay/cli.ts summary <file.jsonl> | frames <file.mp4|webm> <outdir> (requires ffmpeg and ffprobe)');
} catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
