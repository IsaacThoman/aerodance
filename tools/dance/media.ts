// Video and audio through FFmpeg (ffprobe/ffmpeg on PATH, or FFMPEG_PATH / FFPROBE_PATH):
// probing, exact frame grabs, audio extraction, browser-playable proxies and preview clips.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

export interface ProcessResult { stdout: Buffer; stderr: string; }
/** Runs a command; rejects with its stderr's tail when it fails. */
export function run(command: string, args: readonly string[], { input }: { input?: Buffer } = {}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => { err = (err + d.toString()).slice(-20000); });
    child.on('error', (e: NodeJS.ErrnoException) => reject(e.code === 'ENOENT'
      ? Error(`${command} not found: install FFmpeg (https://ffmpeg.org) or set ${command === FFPROBE ? 'FFPROBE_PATH' : 'FFMPEG_PATH'}`) : e));
    child.on('close', code => code === 0 ? resolve({ stdout: Buffer.concat(out), stderr: err })
      : reject(Error(`${path.basename(command)} failed (exit ${code}): ${err.trim().split('\n').slice(-4).join(' | ')}`)));
    if (input) child.stdin.end(input); else child.stdin.end();
  });
}
export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export interface VideoInfo {
  /** Display size, after any rotation the file asks for. */
  width: number; height: number;
  fps: number; durationMs: number; codec: string; hasAudio: boolean;
}
const fraction = (v: unknown) => {
  if (typeof v !== 'string') return NaN;
  const [a, b] = v.split('/').map(Number);
  return b ? a / b : a;
};
export async function probeVideo(file: string): Promise<VideoInfo> {
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]);
  const info = JSON.parse(stdout.toString()) as { streams?: Record<string, unknown>[]; format?: Record<string, unknown> };
  const video = info.streams?.find(s => s.codec_type === 'video');
  if (!video) throw Error(`${file} has no video stream`);
  let width = Number(video.width), height = Number(video.height);
  const tags = (video.tags ?? {}) as Record<string, unknown>;
  const sideData = (video.side_data_list ?? []) as Record<string, unknown>[];
  const rotation = Number(tags.rotate ?? sideData.find(s => s.rotation !== undefined)?.rotation ?? 0);
  if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
  const fps = fraction(video.avg_frame_rate) || fraction(video.r_frame_rate) || 30;
  const durationMs = Math.round(Number(video.duration ?? info.format?.duration) * 1000);
  if (!(width > 0 && height > 0 && durationMs > 0)) throw Error(`Can't read the size and length of ${file}`);
  return { width, height, fps: Math.round(fps * 1000) / 1000, durationMs, codec: String(video.codec_name ?? ''),
    hasAudio: Boolean(info.streams?.some(s => s.codec_type === 'audio')) };
}
/** A PCM WAV's length from its header, or null if it isn't one. */
export function wavDurationMs(bytes: Uint8Array): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), text = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 12 || text(0) !== 'RIFF' || text(8) !== 'WAVE') return null;
  let byteRate = 0;
  for (let at = 12; at + 8 <= bytes.length;) {
    const id = text(at), size = view.getUint32(at + 4, true);
    if (id === 'fmt ' && at + 16 <= bytes.length) byteRate = view.getUint32(at + 16, true);
    if (id === 'data' && byteRate > 0) return Math.round(Math.min(size, bytes.length - at - 8) / byteRate * 1000);
    at += 8 + size + (size % 2);
  }
  return null;
}
export async function probeAudioMs(file: string): Promise<number> {
  // WAV (what audio extraction writes) needs no FFmpeg.
  if (path.extname(file).toLowerCase() === '.wav') {
    const ms = wavDurationMs(new Uint8Array(await readFile(file)));
    if (ms && ms > 0) return ms;
  }
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
  const ms = Math.round(Number(stdout.toString().trim()) * 1000);
  if (!(ms > 0)) throw Error(`Can't read the length of ${file}`);
  return ms;
}
/** The video's audio as 16-bit stereo WAV at 48 kHz, the format every browser decodes. */
export async function extractAudio(video: string, out: string): Promise<void> {
  await mkdir(path.dirname(out), { recursive: true });
  await run(FFMPEG, ['-v', 'error', '-y', '-i', video, '-vn', '-map', '0:a:0', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', out]);
}
/** A JPEG of the frame shown at `ms`, `width` pixels wide (default: full size). */
export async function grabFrame(video: string, ms: number, { width, quality = 3 }: { width?: number; quality?: number } = {}): Promise<Buffer> {
  // Seeking before the input is frame-accurate when decoding, and much faster than after it.
  const args = ['-v', 'error', '-ss', (Math.max(0, ms) / 1000).toFixed(4), '-i', video, '-frames:v', '1'];
  if (width) args.push('-vf', `scale=${Math.round(width)}:-2`);
  args.push('-q:v', String(quality), '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1');
  const { stdout } = await run(FFMPEG, args);
  if (!stdout.length) throw Error(`No frame at ${ms} ms in ${video}`);
  return stdout;
}
/**
 * Every frame from startMs to endMs at `fps`, as raw RGBA in one pass, each `width` pixels wide;
 * for tracking. Calls onFrame in order.
 */
export async function decodeFrames(video: string, { startMs, endMs, fps, width, height }: { startMs: number; endMs: number; fps: number; width: number; height: number },
  onFrame: (index: number, rgba: Buffer) => Promise<void>): Promise<number> {
  const size = width * height * 4;
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ['-v', 'error', '-ss', (startMs / 1000).toFixed(4), '-i', video, '-t', ((endMs - startMs) / 1000).toFixed(4),
      '-vf', `fps=${fps},scale=${width}:${height}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let pending = Buffer.alloc(0), index = 0, err = '', chain = Promise.resolve();
    child.stderr.on('data', (d: Buffer) => { err = (err + d.toString()).slice(-4000); });
    child.stdout.on('data', (d: Buffer) => {
      pending = Buffer.concat([pending, d]);
      while (pending.length >= size) {
        const frame = pending.subarray(0, size), i = index++;
        pending = pending.subarray(size);
        const copy = Buffer.from(frame);
        child.stdout.pause();
        chain = chain.then(() => onFrame(i, copy)).finally(() => child.stdout.resume());
      }
    });
    child.on('error', reject);
    child.on('close', code => chain.then(() => code === 0 ? resolve(index) : reject(Error(`ffmpeg failed: ${err.trim()}`)), reject));
  });
}
/** A browser-playable copy for Studio: VP9 WebM, at most 720 pixels tall, keyframes every half second. */
export async function makeProxy(video: string, out: string, fps: number): Promise<void> {
  await mkdir(path.dirname(out), { recursive: true });
  await run(FFMPEG, ['-v', 'error', '-y', '-i', video, '-an', '-vf', 'scale=-2:min(720\\,ih)', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8',
    '-row-mt', '1', '-b:v', '0', '-crf', '34', '-g', String(Math.max(1, Math.round(fps / 2))), '-pix_fmt', 'yuv420p', out]);
}
/**
 * A browser recording (MediaRecorder's WebM, which has no length and a variable frame rate) as
 * VP9 WebM at a constant `fps`, so it probes, seeks and tracks like any other video.
 */
export async function normalizeRecording(video: string, out: string, fps: number): Promise<void> {
  await mkdir(path.dirname(out), { recursive: true });
  await run(FFMPEG, ['-v', 'error', '-y', '-i', video, '-an', '-vf', `fps=${fps}`, '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8',
    '-row-mt', '1', '-b:v', '0', '-crf', '30', '-g', String(Math.max(1, Math.round(fps / 2))), '-pix_fmt', 'yuv420p', out]);
}
/** Encodes PNG frames into an H.264 MP4 (with optional audio from `audio`, starting at audioStartMs). */
export async function encodeClip(frames: AsyncIterable<Buffer>, out: string, { fps, audio, audioStartMs = 0, durationMs }:
  { fps: number; audio?: string | null; audioStartMs?: number; durationMs: number }): Promise<void> {
  await mkdir(path.dirname(out), { recursive: true });
  const args = ['-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', 'pipe:0'];
  if (audio) args.push('-ss', (audioStartMs / 1000).toFixed(4), '-i', audio);
  args.push('-map', '0:v');
  if (audio) args.push('-map', '1:a', '-c:a', 'aac', '-b:a', '160k');
  // H.264 in 4:2:0 needs even dimensions.
  args.push('-t', (durationMs / 1000).toFixed(4), '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', out);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(FFMPEG, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d: Buffer) => { err = (err + d.toString()).slice(-4000); });
    child.on('error', reject);
    // If ffmpeg stops early, its exit status says why; the broken pipe doesn't.
    child.stdin.on('error', () => {});
    child.on('close', code => code === 0 ? resolve() : reject(Error(`ffmpeg failed: ${err.trim()}`)));
    (async () => {
      for await (const frame of frames) {
        if (child.exitCode !== null || child.stdin.destroyed) return;
        if (!child.stdin.write(frame)) await new Promise(r => child.stdin.once('drain', r));
      }
      child.stdin.end();
    })().catch(e => { child.kill(); reject(e); });
  });
}
export const MIME: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.adpose': 'application/octet-stream',
};
export const mimeOf = (file: string) => MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
