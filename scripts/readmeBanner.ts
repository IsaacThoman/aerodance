// Records the README's animated banner (assets/banner.gif): the title screen's flight, the
// players dial turning up to four, a song preview on its stage and a two-player ghost run.
// It drives a play.ts session (docs/interactive-testing.md), records the game canvas in the page
// with MediaRecorder, then cuts and crossfades the take with ffmpeg and encodes it with gifski.
//
//   node scripts/play.ts start --size 1280x720
//   node scripts/readmeBanner.ts [--out assets/banner.gif] [--keep take.webm]
//   node scripts/play.ts stop
//
// Needs ffmpeg and gifski on the PATH (`brew install ffmpeg gifski`).
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const out = path.resolve(arg('--out') ?? path.join(root, 'assets/banner.gif'));
const keep = arg('--keep');

const WIDTH = 640; // the buffer's 640 columns, shown at 16:9
const FPS = 15;
const FADE = 0.35;

const play = (...args: string[]) =>
  execFileSync(process.execPath, [path.join(root, 'scripts/play.ts'), ...args], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 30 });
const sleep = (s: number) => new Promise((done) => setTimeout(done, s * 1000));

const startRecording = `(() => {
  const stream = document.querySelector('canvas').captureStream(60);
  const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: 40e6 });
  const chunks = [];
  rec.ondataavailable = (e) => chunks.push(e.data);
  rec.start(250);
  window.__banner = { rec, chunks, t0: performance.now() };
})()`;
const now = () => Number(play('eval', '(performance.now() - window.__banner.t0) / 1000'));
const stopRecording = `new Promise((done) => {
  const { rec, chunks } = window.__banner;
  rec.onstop = async () => {
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    done(btoa(s));
  };
  rec.stop();
})`;

// ---- The take ----

play('goto', '/?input=ghost');
play('camera', '2');
await sleep(1);
play('eval', startRecording);
await sleep(5);
const titleEnd = now() - 1;
play('click', 'START');
play('wait', 'menuScreen=players', 'menuReady=true');
await sleep(1.2);
const dial = now();
for (const [target, pause] of [['PLUS', 1.3], ['PLUS', 1.6], ['MINUS', 0.6], ['MINUS', 1.5]] as const) {
  play('click', target);
  await sleep(pause);
}
play('click', 'PLAYERS_GO');
play('wait', 'songScreen=list', 'songReady=true');
await sleep(1.5);
play('click', 'rowRect.0');
play('wait', 'songScreen=preview', 'songReady=true', 'stageReady=true');
await sleep(5);
const dance = now();
play('click', 'DANCE');
play('wait', 'gamePhase=playing', '--timeout', '60000');
const playing = now();
await sleep(8);
const take = Buffer.from(play('eval', stopRecording).trim(), 'base64');

// ---- Cut, crossfade and encode ----

const segments: [number, number][] = [
  [1, titleEnd], // the title screen's flight
  [dial - 0.6, dial + 3.4], // 2 → 3 → 4 dancers, each arriving in a bubble
  [dance - 4.2, dance - 1.2], // the song preview on its stage
  [playing + 2, playing + 6.4], // dancing, with the scores and the mirror
];
const tmp = mkdtempSync(path.join(os.tmpdir(), 'aerodance-banner-'));
try {
  const webm = path.join(tmp, 'take.webm');
  writeFileSync(webm, take);
  if (keep) copyFileSync(webm, keep);
  const filters: string[] = [];
  let last = 's0';
  let offset = 0;
  segments.forEach(([start, end], i) => {
    filters.push(`[0:v]trim=${start.toFixed(2)}:${end.toFixed(2)},setpts=PTS-STARTPTS,fps=${FPS},` +
      `scale=${WIDTH}:${(WIDTH * 9) / 16}:flags=lanczos,format=rgb24[s${i}]`);
    if (i > 0) {
      offset -= FADE;
      filters.push(`[${last}][s${i}]xfade=transition=fade:duration=${FADE}:offset=${offset.toFixed(2)}[x${i}]`);
      last = `x${i}`;
    }
    offset += end - start;
  });
  const montage = path.join(tmp, 'montage.mkv');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', webm, '-filter_complex', filters.join(';'),
    '-map', `[${last}]`, '-c:v', 'ffv1', montage], { stdio: 'inherit' });
  execFileSync('gifski', ['--fps', String(FPS), '--quality', '65', '--lossy-quality', '20',
    '--motion-quality', '25', '-o', out, montage], { stdio: ['ignore', 'ignore', 'inherit'] });
  console.log(`${path.relative(root, out)}: ${(statSync(out).size / 1e6).toFixed(1)} MB`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
