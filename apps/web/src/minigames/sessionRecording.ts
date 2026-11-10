import { SessionLogWriter } from '../../../../packages/pose/sessionLog.ts';
import type { SessionLine } from '../../../../packages/pose/sessionLog.ts';
import type { WebcamRecord } from '../../../../packages/pose/webcamRecord.ts';
import type { CameraInput } from '../pose/CameraInput.ts';
import { isPoseRecordEvent } from '../pose/PoseSource.ts';
import type { MinigameSession } from './MinigameSession.ts';

interface RecordingDirectory {
  name: string;
  getFileHandle(name: string, options: { create: boolean }): Promise<{ createWritable(): Promise<FileSystemWritableFileStream> }>;
}
type PickerWindow = Window & { showDirectoryPicker?: (options: { mode: 'readwrite'; id: string }) => Promise<RecordingDirectory> };
let directory: Promise<RecordingDirectory | null> | undefined;
/** Called directly from Play's user gesture, before changing the camera or asking for tracking. */
export function prepareSessionRecording() {
  directory ??= (async () => {
    const picker = (window as PickerWindow).showDirectoryPicker;
    if (!picker) return null;
    try { return await picker.call(window, { mode: 'readwrite', id: 'aerodance-sessions' }); }
    catch { return null; } // A cancelled/unavailable picker uses the browser's Downloads instead.
  })();
  return directory;
}

export const recordingStatus = { active: false, startedAt: 0, notice: '', noticeUntil: 0 };
function notice(text: string) {
  recordingStatus.notice = text;
  recordingStatus.noticeUntil = performance.now() + 12000;
}
function download(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
// Two rounds started in the same second still get distinct, paired file names.
let lastNameTime = 0;
function fileName(game: string) {
  const time = Math.max(Date.now(), lastNameTime + 1000);
  lastNameTime = Math.floor(time / 1000) * 1000;
  const d = new Date(time), pad = (n: number) => String(n).padStart(2, '0');
  return `aerodance-${game}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
const ACTIVE = ['calibrating', 'howto', 'countdown', 'playing', 'paused'];

/** One capture per round. It never owns or stops the camera's tracks. */
export class SessionRecording {
  private session: MinigameSession;
  private camera: CameraInput;
  private destination: RecordingDirectory | null;
  private off: (() => void)[] = [];
  private writer?: SessionLogWriter;
  private recorder?: MediaRecorder;
  private worker?: Worker;
  private timer?: ReturnType<typeof setInterval>;
  private starting = false;
  private ended = false;
  private finishPromise?: Promise<void>;
  private videoDone?: Promise<void>;
  private videoWrites = Promise.resolve();
  private videoPendingBytes = 0;
  private failure: unknown;
  private name = '';
  private extension = '';
  private logChunks: string[] = [];
  private videoChunks: Blob[] = [];
  private videoFile?: FileSystemWritableFileStream;
  private lastStats = '';
  private custom = (type: string, data: unknown) => {
    // A game's data can be mutable; snapshot only these small, opt-in events, never the poses.
    this.append({ t: performance.now(), type, data: structuredClone(data) });
  };

  constructor(session: MinigameSession, camera: CameraInput, destination: RecordingDirectory | null) {
    this.session = session; this.camera = camera; this.destination = destination;
    const source = camera.webcam.source;
    this.off.push(session.onChange(() => {
      this.append({ t: performance.now(), type: 'phase', data: { phase: session.phase() } });
      if (['results', 'disposed', 'error'].includes(session.phase())) void this.stop(session.phase());
      else void this.start();
    }));
    this.off.push(camera.subscribe(() => {
      void this.start();
      if (!this.writer || this.ended) return;
      const stats = camera.view.stats;
      const data = { ...stats, poseHz: stats?.poseHz ?? null, inferenceMs: stats?.inferenceMs ?? null, hands: camera.view.hands ?? null };
      const key = JSON.stringify(data);
      if (key !== this.lastStats) {
        this.lastStats = key;
        this.append({ t: performance.now(), type: 'stats', data });
      }
    }));
    this.off.push(camera.subscribeRecords(event => {
      if (!isPoseRecordEvent(event)) { if (this.writer) void this.stop('source-stopped'); return; }
      if (camera.mode !== 'webcam') return;
      this.append({ t: performance.now(), type: 'pose', record: event.record as WebcamRecord,
        captureBrowserTimeMs: event.captureBrowserTimeMs, receivedBrowserTimeMs: event.receivedBrowserTimeMs,
        timing: event.timing, lined: source.tracker.lined });
    }));
    this.off.push(source.subscribeFrames(frame => {
      if (camera.mode !== 'webcam') return;
      this.append({ t: frame.t, type: 'frame', callbackTime: frame.callbackTime, metadata: { ...frame.metadata } });
    }));
    const hidden = () => { if (document.hidden) void this.stop('hidden'); };
    const pagehide = () => { void this.stop('pagehide'); };
    // Capture listeners run before the source disconnects its stream on a hidden page.
    document.addEventListener('visibilitychange', hidden, true);
    window.addEventListener('pagehide', pagehide, true);
    this.off.push(() => document.removeEventListener('visibilitychange', hidden, true), () => window.removeEventListener('pagehide', pagehide, true));
  }
  private append(line: SessionLine) { if (!this.ended) this.writer?.append(line); }
  private async start() {
    const { session, camera } = this;
    if (this.ended || this.starting || this.recorder || !ACTIVE.includes(session.phase()) || camera.mode !== 'webcam') return;
    const source = camera.webcam.source, stream = source.stream;
    if (!stream?.active) return;
    this.starting = true;
    try {
      if (typeof MediaRecorder === 'undefined') throw Error('This browser cannot record camera video');
      const mimeType = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/mp4', 'video/webm']
        .find(type => MediaRecorder.isTypeSupported(type));
      if (!mimeType) throw Error('No supported camera recording codec');
      this.extension = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
      this.name = fileName(session.game.id);
      let logFile: FileSystemWritableFileStream | undefined;
      if (this.destination) {
        logFile = await (await this.destination.getFileHandle(`${this.name}.jsonl`, { create: true })).createWritable();
        try { this.videoFile = await (await this.destination.getFileHandle(`${this.name}.${this.extension}`, { create: true })).createWritable(); }
        catch (error) { await logFile.close(); throw error; }
      }
      // Quit/hidden may happen while file handles are opening.
      if (this.ended) { await logFile?.close(); await this.videoFile?.close(); return; }
      const worker = this.worker = new Worker(new URL('./sessionLog.worker.ts', import.meta.url), { type: 'module' });
      let workerFailure: Error | undefined;
      let receive: { resolve(text: string): void; reject(error: Error): void } | undefined;
      worker.onmessage = ({ data }: MessageEvent<{ text: string; error?: string }>) => {
        if (data.error) receive?.reject(Error(data.error));
        else receive?.resolve(data.text);
        receive = undefined;
      };
      worker.onerror = event => { workerFailure = Error(event.message); receive?.reject(workerFailure); receive = undefined; };
      this.writer = new SessionLogWriter({
        write: async text => { if (logFile) await logFile.write(text); else this.logChunks.push(text); },
        close: async () => { await logFile?.close(); },
      }, lines => new Promise((resolve, reject) => {
        if (workerFailure) { reject(workerFailure); return; }
        receive = { resolve, reject };
        worker.postMessage(lines);
      }));
      const recorder = this.recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
      this.videoDone = new Promise(resolve => { recorder.onstop = () => resolve(); });
      recorder.onerror = () => { this.failure = Error('Camera video recording failed'); void this.stop('video-error'); };
      recorder.onstart = () => this.append({ t: performance.now(), type: 'video-start', data: { mimeType: recorder.mimeType } });
      recorder.ondataavailable = ({ data }) => {
        if (!data.size) return;
        if (!this.videoFile) { this.videoChunks.push(data); return; }
        this.videoPendingBytes += data.size;
        if (this.videoPendingBytes > 32 * 1024 * 1024) {
          this.failure ??= Error('Video disk writes cannot keep up');
          void this.stop('disk-slow');
        }
        this.videoWrites = this.videoWrites.then(() => this.videoFile!.write(data)).catch(error => {
          this.failure ??= error; void this.stop('disk-error');
        }).finally(() => { this.videoPendingBytes -= data.size; });
      };
      const track = stream.getVideoTracks()[0], settings = track.getSettings();
      const startedAt = performance.now();
      this.writer.append({ t: startedAt, type: 'header', format: 'aerodance.session', version: 1,
        commit: import.meta.env.VITE_APP_COMMIT || import.meta.env.VITE_COMMIT_SHA || null,
        userAgent: navigator.userAgent, game: session.game.id, playerCount: session.playerCount,
        options: { ...session.options }, detail: session.detail,
        camera: { width: settings.width, height: settings.height, frameRate: settings.frameRate, label: track.label },
        timeOrigin: performance.timeOrigin, videoStartTime: startedAt, mimeType: recorder.mimeType, rotation: source.turned });
      recorder.start(1000);
      this.append({ t: performance.now(), type: 'phase', data: { phase: session.phase() } });
      if (Object.keys(session.reported).length) this.custom('report', { ...session.reported });
      session.record = this.custom;
      Object.assign(recordingStatus, { active: true, startedAt, notice: '' });
      this.timer = setInterval(() => {
        this.writer?.flush();
        if (this.writer?.error) { this.failure = this.writer.error; void this.stop('log-error'); }
      }, 250);
    } catch (error) {
      this.failure = error;
      void this.stop('start-error');
    } finally { this.starting = false; }
  }
  stop(reason: string): Promise<void> {
    if (this.finishPromise) return this.finishPromise;
    this.append({ t: performance.now(), type: 'end', data: { reason } });
    this.ended = true;
    for (const off of this.off) off();
    this.off = [];
    if (this.session.record === this.custom) this.session.record = undefined;
    clearInterval(this.timer);
    recordingStatus.active = false;
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    this.finishPromise = this.save();
    return this.finishPromise;
  }
  private async save() {
    try {
      await this.videoDone;
      await this.videoWrites;
      await Promise.all([this.writer?.close(), this.videoFile?.close()]);
      if (this.writer && !this.destination) {
        download(`${this.name}.${this.extension}`, new Blob(this.videoChunks, { type: this.recorder?.mimeType }));
        download(`${this.name}.jsonl`, new Blob(this.logChunks, { type: 'application/x-ndjson' }));
      }
      if (this.failure) throw this.failure;
      if (this.writer) notice(`Session saved to ${this.destination?.name ?? 'Downloads'}: ${this.name}`);
    } catch (error) {
      notice(`Session recording incomplete: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.worker?.terminate();
      this.logChunks = []; this.videoChunks = [];
    }
  }
}
