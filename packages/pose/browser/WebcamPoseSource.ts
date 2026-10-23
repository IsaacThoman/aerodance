import { MEDIAPIPE_VERSION, ASSET_PATH, isPoseModelId, poseModel } from './models.ts';
import type { PoseModelId } from './models.ts';
import { PlayerTracker } from './tracker.ts';
import { evenTiles } from './tiles.ts';
import { validateWebcamRecord } from '../webcamRecord.ts';
import type { WebcamRecord } from '../webcamRecord.ts';
import { isPlayerCount } from '../choreography.ts';
import type { CaptureInput, PlayerCount } from '../choreography.ts';
import type { PoseDelegate, PoseWorkerRequest, PoseWorkerResponse } from './pose.worker.ts';
import type { PreviewPicture } from './preview.ts';

export type WebcamStatus = 'disconnected' | 'connecting' | 'initializing' | 'connected' | 'error';
/** Which way the camera faces when no camera is chosen: towards the screen (user) or away. */
export type CameraFacing = 'user' | 'environment';
export interface CameraInfo { deviceId: string; label: string; }
/** The latest tracked frame, as the view shows it. */
export interface WebcamSnapshot extends WebcamRecord { sourceKind: 'webcam'; frameId: number; }
export interface WebcamModelConfig {
  modelId: PoseModelId; modelHash: string; packageVersion: string;
  thresholds: { detection: number; presence: number; tracking: number };
  timingMethod: 'browser-frame-observation';
  delegate?: PoseDelegate;
}
export interface WebcamStats { poseHz: number; inferenceMs: number; frameAgeMs: number; droppedFrames: number; }
/** Everything the camera UI shows; published on every change. */
export interface WebcamView {
  status: WebcamStatus; sourceKind: 'webcam';
  snapshot: WebcamSnapshot | null;
  configuring: boolean; message: string;
  /**
   * The browser has muted the camera: WebKit does while iOS has taken it away (a phone call),
   * and Chrome while it sends no pictures. Its pictures stop, so nobody is tracked, but it may
   * come back by itself (status 'initializing' meanwhile, until interruptedTimeoutMs).
   */
  interrupted?: boolean;
  model: PoseModelId; cameraId: string; cameras: CameraInfo[];
  /** Asked of the browser when no camera is chosen (phones: front or back camera). */
  facing?: CameraFacing;
  stats: WebcamStats | null;
  modelConfig?: WebcamModelConfig;
  delegate?: PoseDelegate;
}
export interface RecordTiming { method: string; uncertaintyMs?: number | null; }
/** A tracked pose record as delivered to record listeners (captures, scoring). */
export interface PoseRecordEvent<R = WebcamRecord> {
  record: R; receivedBrowserTimeMs: number; captureBrowserTimeMs: number; timing: RecordTiming;
}
export interface SourceStoppedEvent { event: { type: 'source-stopped'; reason: string }; receivedBrowserTimeMs: number; }
export type WebcamRecordEvent = PoseRecordEvent | SourceStoppedEvent;
export type Listener<T> = (value: T) => void;

/** The part of a Worker the source uses; replaceable in tests. */
export interface PoseWorker {
  onmessage: ((event: MessageEvent<PoseWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: PoseWorkerRequest, transfer?: Transferable[]): void;
  terminate(): void;
}
export interface WebcamPoseSourceOptions {
  mediaDevices?: Pick<MediaDevices, 'getUserMedia' | 'enumerateDevices'>;
  createWorker?: () => PoseWorker;
  createVideo?: () => HTMLVideoElement;
  createCanvas?: () => HTMLCanvasElement;
  bitmap?: (picture: HTMLVideoElement | HTMLCanvasElement) => Promise<ImageBitmap>;
  now?: () => number;
  assetUrl?: () => string;
  /** Prefix of the saved model and camera settings (a phone camera keeps its own). */
  settingsKey?: string;
  /** A camera that changes size (a phone turned sideways) carries on at the new size instead of failing. */
  adaptToResize?: boolean;
  /**
   * How long the camera may stay muted before it fails like a stalled one (default 10 s, the
   * watchdog's). Infinity waits for it: in the iPhone/iPad app, iOS gives it back after a call.
   */
  interruptedTimeoutMs?: number;
  /** Looks for each of three or four players in a strip of the picture (tiles.ts; default true). */
  tiles?: boolean;
  /**
   * How far to turn the camera's picture so it's upright, clockwise in degrees (0, 90, 180 or
   * 270), asked on every frame with the picture's size, which way its camera faces and which
   * start of the camera it's from. Tracking and the preview (picture) get the turned picture. The
   * iPhone/iPad app's WebKit turns it upright for the screen, not the way the device is held
   * (cameraTurner in apps/web/src/host.ts).
   */
  turn?: (frame: { width: number; height: number; facing?: string; capture: number }) => number;
}
export interface WebcamConfigureOptions { modelId?: string; cameraId?: string; facing?: CameraFacing; }
interface PendingFrame { seq: number; mediaTimeMs: number; frameBrowserTimeMs: number; }
/** A picture of the camera, turned upright, and its size then. */
interface Picture { bitmap: Promise<ImageBitmap>; size: { width: number; height: number }; }

const ACTIVE: readonly WebcamStatus[] = ['connecting', 'initializing', 'connected'];
const saved = (key: string, fallback: string) => { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } };
const save = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* Private browsing. */ } };
function aborted<T>(promise: Promise<T>, signal: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(Error('Camera start cancelled'));
    signal.addEventListener('abort', cancel, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
    if (signal.aborted) cancel();
  });
}
const INTERRUPTED = 'The camera was interrupted. Tracking carries on when it comes back.';
const STALLED = 'The camera stopped sending pictures. Start camera to retry.';
const STALL_MS = 10000;
const CAMERA_ERRORS: Partial<Record<string, string>> = { NotAllowedError: 'Camera permission was denied. Allow camera access for this site, then start again.',
  NotFoundError: 'No camera was found. Connect a camera, then start again.',
  NotReadableError: 'The camera is busy or unavailable. Close other camera applications, then start again.',
  OverconstrainedError: 'The selected camera is unavailable. Choose another camera.' };
function cameraMessage(error: unknown) {
  const known = typeof error === 'object' && error !== null;
  const name = known && 'name' in error && typeof error.name === 'string' ? error.name : '';
  const message = known && 'message' in error && typeof error.message === 'string' ? error.message : '';
  return CAMERA_ERRORS[name] || message || 'Could not start webcam tracking';
}

// iOS also lists its multi-lens cameras ("Back Dual Wide Camera", "Back Triple Camera"), which switch lenses as the
// subject moves; only the real lenses are offered. Other languages' names aren't matched, so those phones list them all.
const VIRTUAL_CAMERA = /^back (dual|dual wide|triple) camera$/i;

export class WebcamPoseSource {
  mediaDevices: Pick<MediaDevices, 'getUserMedia' | 'enumerateDevices'> | undefined;
  createWorker: () => PoseWorker;
  createVideo: () => HTMLVideoElement;
  createCanvas: () => HTMLCanvasElement;
  bitmap: (picture: HTMLVideoElement | HTMLCanvasElement) => Promise<ImageBitmap>;
  now: () => number;
  assetUrl: () => string;
  settingsKey: string;
  adaptToResize: boolean;
  interruptedTimeoutMs: number;
  tiling: boolean;
  turn: (frame: { width: number; height: number; facing?: string; capture: number }) => number;
  listeners = new Set<Listener<WebcamView>>();
  recordListeners = new Set<Listener<WebcamRecordEvent>>();
  generation = 0;
  playerCount: PlayerCount = 1;
  view: WebcamView;
  controller: AbortController | null = null;
  startupTimeout: ReturnType<typeof setTimeout> | undefined;
  watchdog: ReturnType<typeof setInterval> | undefined;
  video: HTMLVideoElement | null = null;
  /** The camera's picture turned upright, while it's turned (turned isn't 0). */
  canvas: HTMLCanvasElement | null = null;
  turned = 0;
  /** Which way the running camera faces ('user', 'environment'; unknown for some). */
  facing: string | undefined;
  stream: MediaStream | null = null;
  worker: PoseWorker | null = null;
  frameCallback: number | null = null;
  animationFrame: number | null = null;
  hidden: (() => void) | null = null;
  pagehide: (() => void) | null = null;
  pending: PendingFrame | null = null;
  busy = false;
  /** The newest frame that came while one was in flight (and its picture, taken then): sent as soon as its result is in. */
  waiting: { mediaTimeMs: number; frameBrowserTimeMs: number; picture: Picture } | null = null;
  // Per-session state, reset by connect().
  input: CaptureInput | null = null;
  sessionId = '';
  seq = 0;
  lastMediaTime = -Infinity;
  /** When the camera last delivered a new frame (tracked or not). */
  lastFrame = 0;
  tracker = new PlayerTracker(1);
  /** How many players the last result found, for the worker's strips. */
  players = 0;
  resultTimes: number[] = [];
  startedAt = 0;
  completed = 0;
  dropped = 0;
  lastResult = 0;
  /** When the camera was last muted. */
  interruptedAt = 0;
  constructor({ mediaDevices = globalThis.navigator?.mediaDevices,
    createWorker = () => new Worker(new URL('./pose.worker.ts', import.meta.url), { type: 'module' }),
    createVideo = () => document.createElement('video'), createCanvas = () => document.createElement('canvas'),
    bitmap = picture => createImageBitmap(picture), now = () => performance.now(),
    assetUrl = () => new URL(`${import.meta.env?.BASE_URL || '/'}${ASSET_PATH}/`, location.origin).href,
    settingsKey = 'aerodance-webcam', adaptToResize = false, interruptedTimeoutMs = STALL_MS, tiles = true, turn = () => 0,
  }: WebcamPoseSourceOptions = {}) {
    this.mediaDevices = mediaDevices; this.createWorker = createWorker; this.createVideo = createVideo; this.createCanvas = createCanvas;
    this.bitmap = bitmap; this.now = now; this.assetUrl = assetUrl; this.settingsKey = settingsKey; this.adaptToResize = adaptToResize;
    this.interruptedTimeoutMs = interruptedTimeoutMs; this.tiling = tiles; this.turn = turn;
    const savedModel = saved(`${settingsKey}-model`, 'lite');
    const modelId: PoseModelId = isPoseModelId(savedModel) ? savedModel : 'lite';
    const facing = saved(`${settingsKey}-facing`, '');
    this.view = { status: 'disconnected', sourceKind: 'webcam', snapshot: null, configuring: false,
      message: 'Choose a camera and model, then Start camera.', interrupted: false, model: modelId,
      cameraId: saved(`${settingsKey}-camera`, ''), cameras: [], stats: null,
      ...(facing === 'user' || facing === 'environment' ? { facing } : {}) };
  }
  /** What a preview shows: the camera's video, or its picture turned upright while it's turned. */
  get picture(): PreviewPicture | null {
    if (!this.video) return null;
    return this.turned && this.canvas ? { image: this.canvas, width: this.canvas.width, height: this.canvas.height } : this.video;
  }
  /** Turns the video's current picture upright into canvas (turned must not be 0). */
  drawTurned(video: HTMLVideoElement) {
    const canvas = this.canvas ??= this.createCanvas();
    const w = video.videoWidth, h = video.videoHeight, sideways = this.turned % 180 !== 0;
    const cw = sideways ? h : w, ch = sideways ? w : h;
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
    const g = canvas.getContext('2d');
    if (!g) return;
    g.setTransform(1, 0, 0, 1, cw / 2, ch / 2);
    g.rotate(this.turned * Math.PI / 180);
    g.drawImage(video, -w / 2, -h / 2, w, h);
  }
  /** The picture's size once turned upright. */
  uprightSize(video: HTMLVideoElement) {
    return this.turned % 180 ? { width: video.videoHeight, height: video.videoWidth } : { width: video.videoWidth, height: video.videoHeight };
  }
  /** Asks how far to turn the video's picture, and turns its current one. */
  updateTurn(video: HTMLVideoElement) {
    this.turned = this.turn({ width: video.videoWidth, height: video.videoHeight, facing: this.facing, capture: this.generation });
    if (this.turned) this.drawTurned(video);
  }
  subscribe(listener: Listener<WebcamView>) { this.listeners.add(listener); listener(this.view); return () => this.listeners.delete(listener); }
  subscribeRecords(listener: Listener<WebcamRecordEvent>) { this.recordListeners.add(listener); return () => this.recordListeners.delete(listener); }
  publish(patch: Partial<WebcamView>) { this.view = { ...this.view, ...patch }; for (const listener of this.listeners) listener(this.view); }
  emit(event: WebcamRecordEvent) { for (const listener of this.recordListeners) listener(event); }
  async refreshCameras() {
    if (!this.mediaDevices?.enumerateDevices) return;
    // Until camera permission is granted, browsers list a camera without an id, which can't be picked.
    const cameras = (await this.mediaDevices.enumerateDevices()).filter(device => device.kind === 'videoinput' && device.deviceId && !VIRTUAL_CAMERA.test(device.label))
      .map((device, i) => ({ deviceId: device.deviceId, label: device.label || `Camera ${i + 1}` }));
    this.publish({ cameras });
  }
  async configure({ modelId = this.view.model, cameraId = this.view.cameraId, facing = this.view.facing }: WebcamConfigureOptions = {}) {
    const model = poseModel(modelId).id;
    if (model === this.view.model && cameraId === this.view.cameraId && facing === this.view.facing) return;
    const active = ACTIVE.includes(this.view.status);
    this.disconnect();
    this.publish({ model, cameraId, facing });
    save(`${this.settingsKey}-model`, model); save(`${this.settingsKey}-camera`, cameraId);
    if (facing) save(`${this.settingsKey}-facing`, facing);
    if (active) await this.connect();
  }
  async setPlayerCount(count: PlayerCount) {
    if (!isPlayerCount(count)) throw Error('Choose one to four players');
    if (count === this.playerCount) return;
    const active = ACTIVE.includes(this.view.status);
    this.disconnect(); this.playerCount = count;
    if (active) await this.connect();
  }
  disconnect(message = 'Camera stopped. Start camera to resume.') {
    this.generation++;
    this.controller?.abort();
    clearTimeout(this.startupTimeout); clearInterval(this.watchdog);
    if (this.video) {
      if (this.frameCallback != null) this.video.cancelVideoFrameCallback?.(this.frameCallback);
      if (this.animationFrame != null) cancelAnimationFrame(this.animationFrame);
      this.video.pause(); this.video.srcObject = null; this.video.remove?.();
    }
    for (const track of this.stream?.getTracks() || []) track.stop();
    this.stream = null; this.video = null; this.turned = 0; this.facing = undefined;
    // Ask the worker to close; termination releases it even during a hung inference.
    if (this.worker) {
      const worker = this.worker;
      worker.postMessage({ type: 'close' });
      worker.terminate(); this.worker = null;
    }
    if (this.hidden) globalThis.document?.removeEventListener('visibilitychange', this.hidden);
    if (this.pagehide) globalThis.window?.removeEventListener('pagehide', this.pagehide);
    this.pending = null; this.busy = false; this.dropWaiting();
    this.emit({ event: { type: 'source-stopped', reason: message }, receivedBrowserTimeMs: this.now() });
    this.publish({ status: 'disconnected', snapshot: null, configuring: false, stats: null, interrupted: false, message });
  }
  fail(error: unknown) {
    const message = cameraMessage(error);
    this.disconnect(message);
    this.publish({ status: 'error', message });
  }
  async connect() {
    this.disconnect();
    const generation = this.generation;
    const controller = this.controller = new AbortController();
    const current = () => generation === this.generation && !controller.signal.aborted;
    this.completed = 0;
    this.publish({ status: 'connecting', snapshot: null, message: 'Waiting for camera permission…' });
    try {
      if (!this.mediaDevices?.getUserMedia) throw Error('Camera access requires HTTPS or localhost and a browser with webcam support.');
      const stream = await this.mediaDevices.getUserMedia({ audio: false, video: {
        width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 },
        ...(this.view.cameraId ? { deviceId: { exact: this.view.cameraId } } : this.view.facing ? { facingMode: { ideal: this.view.facing } } : {}),
      } });
      if (!current()) { for (const track of stream.getTracks()) track.stop(); return; }
      this.stream = stream;
      for (const track of stream.getVideoTracks()) {
        track.addEventListener('ended', () => { if (current()) this.fail(Error('Camera disconnected. Choose a camera and start again.')); });
        track.addEventListener('mute', () => { if (current()) this.interrupt(); });
        track.addEventListener('unmute', () => { if (current()) this.uninterrupt(); });
      }
      this.hidden = () => { if (document.hidden) this.disconnect('Tab was hidden. Start camera to resume.'); };
      this.pagehide = () => this.disconnect();
      globalThis.document?.addEventListener('visibilitychange', this.hidden);
      globalThis.window?.addEventListener('pagehide', this.pagehide);
      if (globalThis.document?.hidden) { this.disconnect('Tab was hidden. Start camera to resume.'); return; }
      this.watchdog = setInterval(() => {
        if (!current()) return;
        const now = this.now();
        if (this.view.snapshot && now - this.view.snapshot.frameBrowserTimeMs >= 500) this.publish({ snapshot: null });
        // A browser mutes a camera that stops sending pictures (Chrome), so a long mute is a stall.
        if (this.view.interrupted) {
          if (now - this.interruptedAt > this.interruptedTimeoutMs) this.fail(Error(STALLED));
          return;
        }
        // Say which half stopped: the camera's pictures, or the model on them. A camera that has
        // tracked before is only 'initializing' again after a mute, and it should be back by now.
        const resumed = this.view.status === 'initializing' && this.completed > 0;
        if ((this.view.status === 'connected' || resumed) && now - this.lastResult > STALL_MS) {
          this.fail(Error(now - this.lastFrame > 5000 ? STALLED : 'Camera tracking stopped responding. Start camera to retry.'));
        }
      }, 100);
      // Started while the camera is muted (iOS has it for a call): wait for it to come back.
      const muted = stream.getVideoTracks().find(track => track.muted);
      if (muted) {
        this.interrupt();
        await aborted(new Promise(resolve => muted.addEventListener('unmute', resolve, { once: true })), controller.signal);
        if (!current()) return;
      }
      await this.refreshCameras();
      if (!current()) return;
      const settings = stream.getVideoTracks()[0]?.getSettings(), deviceId = settings?.deviceId;
      this.facing = settings?.facingMode;
      const actualCamera = deviceId !== undefined && this.view.cameras.some(camera => camera.deviceId === deviceId) ? deviceId : this.view.cameraId;
      // A camera picked by facing stays unchosen, so turning the phone round picks again.
      if (!this.view.facing || this.view.cameraId) { this.publish({ cameraId: actualCamera }); save(`${this.settingsKey}-camera`, actualCamera); }
      const video = this.video = this.createVideo();
      video.muted = true; video.playsInline = true; video.srcObject = stream;
      if (video.style) {
        Object.assign(video.style, { position: 'fixed', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none' });
        video.setAttribute('aria-hidden', 'true'); document.body.append(video);
      }
      // Browsers may pause a muted video they think nobody sees (Safari does); keep it playing.
      video.addEventListener?.('pause', () => { if (current()) void video.play().catch(() => {}); });
      this.armStartup();
      await aborted(video.play(), controller.signal);
      if (!current()) return;
      if (!video.videoWidth || !video.videoHeight) throw Error('Camera produced no video frames. Start again.');
      this.updateTurn(video);
      this.input = { ...this.uprightSize(video), mirrored: false };
      const model = poseModel(this.view.model);
      this.sessionId = crypto.randomUUID(); this.seq = 0; this.lastMediaTime = -Infinity;
      this.tracker = new PlayerTracker(this.playerCount); this.players = 0; this.resultTimes = [];
      this.startedAt = this.now(); this.completed = 0; this.dropped = 0; this.lastResult = this.lastFrame = this.startedAt;
      const worker = this.worker = this.createWorker();
      worker.onmessage = ({ data }) => { if (current() && data.sessionId === this.sessionId) this.handleWorker(data); };
      worker.onerror = event => { if (current()) this.fail(Error(event.message || 'Pose worker failed. Try another model or browser.')); };
      const base = this.assetUrl();
      this.publish({ status: 'initializing', message: `Loading ${model.label} model…`,
        modelConfig: { modelId: model.id, modelHash: model.sha256, packageVersion: MEDIAPIPE_VERSION,
          thresholds: { detection: 0.5, presence: 0.5, tracking: 0.5 }, timingMethod: 'browser-frame-observation' } });
      // One or two players: ask for exactly that many people. Asking for an extra person keeps
      // the detector searching every frame while only the players are present; those searches
      // can repeatedly lose somebody it was already following. Three or four players use strips
      // (tiles.ts), with room for one extra person in their whole-picture fallback. Looks tell
      // players apart, so one player doesn't need them.
      const tiles = this.tiling && evenTiles(this.playerCount);
      worker.postMessage({ type: 'initialize', sessionId: this.sessionId, playerCount: this.playerCount <= 2 ? this.playerCount : this.playerCount + 1, looks: this.playerCount > 1,
        ...(tiles ? { tiles } : {}),
        modelUrl: new URL(model.file, base).href, modelHash: model.sha256, wasmUrl: new URL('wasm', base).href });
    } catch (error) { if (current()) this.fail(error); }
  }
  /** Fails a start that hasn't tracked a frame within a minute (the camera's silence doesn't count). */
  armStartup() {
    const generation = this.generation;
    clearTimeout(this.startupTimeout);
    this.startupTimeout = setTimeout(() => {
      if (generation === this.generation && !this.view.interrupted) this.fail(Error('Camera/model startup timed out. Try again or choose Lite.'));
    }, 60000);
  }
  /** The camera was muted: say so, rather than look like nobody is in view. */
  interrupt() {
    if (this.view.interrupted) return;
    this.interruptedAt = this.now();
    // Only a camera that is waited for comes back for sure.
    const message = Number.isFinite(this.interruptedTimeoutMs) ? 'The camera stopped sending pictures.' : INTERRUPTED;
    this.publish({ interrupted: true, status: this.view.status === 'connected' ? 'initializing' : this.view.status, snapshot: null, stats: null, message });
  }
  /**
   * The camera is back: tracking carries on (connected again with the next result). If nothing
   * comes, the watchdog fails a camera that had tracked, and the startup timeout one that hadn't.
   */
  uninterrupt() {
    if (!this.view.interrupted) return;
    // The watchdog counts the silence from now.
    this.lastResult = this.lastFrame = this.now();
    if (this.video && !this.completed) this.armStartup();
    this.publish({ interrupted: false, message: this.worker ? 'Camera is back. Waiting for the first pose result…' : 'Starting camera…' });
  }
  handleWorker(data: PoseWorkerResponse) {
    try { this.handleResult(data); } finally { this.sendWaiting(); }
  }
  handleResult(data: PoseWorkerResponse) {
    if (data.type === 'error') { this.fail(Error(data.message)); return; }
    if (data.type === 'ready') {
      this.publish({ delegate: data.delegate, modelConfig: this.view.modelConfig && { ...this.view.modelConfig, delegate: data.delegate },
        ...(this.view.interrupted ? {} : { message: data.fallback ? 'GPU unavailable; using CPU. Waiting for the first pose result…' : 'Waiting for the first pose result…' }) });
      this.schedule(); return;
    }
    if (data.type !== 'result' || !this.pending || data.seq !== this.pending.seq) return;
    const pending = this.pending;
    this.pending = null; this.busy = false;
    // A frame from before the camera was muted mustn't mark it connected again.
    if (this.view.interrupted) return;
    const receivedBrowserTimeMs = this.now();
    this.lastResult = receivedBrowserTimeMs;
    const frameAgeMs = receivedBrowserTimeMs - pending.frameBrowserTimeMs;
    // Never let a slow result revive expired player readiness or contaminate a take.
    if (frameAgeMs >= 500) { this.dropped++; this.publish({ snapshot: null, message: 'Tracking is too slow. Try Lite or another camera.' }); return; }
    try {
      const record = validateWebcamRecord({ schema: 'aerodance.webcam-record', schemaVersion: 1, type: 'pose',
        sessionId: this.sessionId, seq: pending.seq, playerCount: this.playerCount, input: this.input,
        modelId: this.view.model, mediaTimeMs: pending.mediaTimeMs, frameBrowserTimeMs: pending.frameBrowserTimeMs, resultBrowserTimeMs: receivedBrowserTimeMs,
        timingMethod: 'browser-frame-observation', poses: this.input ? this.tracker.update(data.landmarks, this.input, pending.frameBrowserTimeMs, data.looks) : [] });
      this.players = record.poses.length;
      clearTimeout(this.startupTimeout);
      this.completed++;
      this.emit({ record, receivedBrowserTimeMs, captureBrowserTimeMs: record.frameBrowserTimeMs,
        timing: { method: record.timingMethod } });
      this.resultTimes.push(receivedBrowserTimeMs);
      this.resultTimes = this.resultTimes.filter(time => receivedBrowserTimeMs - time <= 2000);
      const poseHz = this.resultTimes.length > 1 ? (this.resultTimes.length - 1) * 1000 / Math.max(1, receivedBrowserTimeMs - this.resultTimes[0]) : 0;
      this.publish({ status: 'connected', snapshot: { ...record, sourceKind: 'webcam', frameId: record.seq },
        stats: { poseHz, inferenceMs: data.inferenceMs, frameAgeMs, droppedFrames: this.dropped },
        message: `${poseModel(this.view.model).label} · ${this.view.delegate} · ${this.resultTimes.length > 1 ? `${poseHz.toFixed(1)} poses/s` : 'Measuring tracking speed…'}${poseHz < 15 && this.completed > 30 ? this.view.model === 'lite' ? ' · Slow tracking; close other apps.' : ' · Slow tracking; try Lite.' : ' · Step into view.'}` });
    } catch (error) { this.fail(error); }
  }
  /** Sends the frame that waited for the last result, if any. */
  sendWaiting() {
    const waiting = this.waiting;
    if (!waiting || this.busy || !this.video) return;
    this.waiting = null;
    this.sendFrame(waiting.mediaTimeMs, waiting.frameBrowserTimeMs, waiting.picture);
  }
  /** Forgets the waiting frame (closing its picture). */
  dropWaiting() {
    void this.waiting?.picture.bitmap.then(bitmap => bitmap.close(), () => {});
    this.waiting = null;
  }
  /** The camera's current picture, turned upright (createImageBitmap copies a turned one now, before the next is drawn over it). */
  take(video: HTMLVideoElement): Picture {
    const bitmap = this.bitmap(this.turned && this.canvas ? this.canvas : video);
    bitmap.catch(() => {});
    return { bitmap, size: this.uprightSize(video) };
  }
  /** Sends a frame: the picture that waited for the last result, or the camera's current one. */
  sendFrame(mediaTimeMs: number, frameBrowserTimeMs: number, picture?: Picture) {
    const video = this.video;
    const generation = this.generation;
    if (!video) return;
    const { bitmap, size } = picture ?? this.take(video);
    if (size.width !== this.input?.width || size.height !== this.input.height) {
      if (!this.adaptToResize || !size.width || !size.height) {
        void bitmap.then(b => b.close(), () => {});
        this.fail(Error('Camera dimensions changed. Start again to recalibrate.')); return;
      }
      // No frame is in flight (one is only sent once the last result is in), so no result mixes
      // the two sizes. Calibration and the live characters start afresh when a record's input size changes.
      this.input = { ...size, mirrored: false };
      this.tracker = new PlayerTracker(this.playerCount); this.players = 0;
    }
    this.busy = true;
    const pending = this.pending = { seq: ++this.seq, mediaTimeMs, frameBrowserTimeMs };
    void bitmap.then(bitmap => {
      const worker = this.worker;
      if (generation !== this.generation || !worker) { bitmap.close(); return; }
      worker.postMessage({ type: 'frame', bitmap, seq: pending.seq, timestampMs: mediaTimeMs, players: this.players }, [bitmap]);
    }).catch(error => { if (generation === this.generation) this.fail(error); });
  }
  schedule() {
    const video = this.video;
    const generation = this.generation;
    if (!video) return;
    const callback = (_time: number, metadata?: VideoFrameCallbackMetadata) => {
      if (generation !== this.generation) return;
      this.schedule();
      // Safari reports mediaTime 0 for every frame of a live camera (its currentTime advances),
      // which would make each frame after the first look like a repeat.
      const reported = (metadata?.mediaTime ?? 0) * 1000;
      const mediaTimeMs = reported > this.lastMediaTime ? reported : video.currentTime * 1000;
      if (!Number.isFinite(mediaTimeMs) || mediaTimeMs <= this.lastMediaTime) return;
      this.lastMediaTime = mediaTimeMs;
      this.lastFrame = this.now();
      // Every new picture is turned, for the preview, even when it isn't tracked.
      if (video.videoWidth && video.videoHeight) this.updateTurn(video);
      // One frame in flight; the newest one that comes meanwhile waits for it (and replaces an older one).
      if (this.busy) {
        if (this.waiting) { this.dropped++; this.dropWaiting(); }
        this.waiting = { mediaTimeMs, frameBrowserTimeMs: this.now(), picture: this.take(video) };
        return;
      }
      this.sendFrame(mediaTimeMs, this.now());
    };
    if (video.requestVideoFrameCallback) this.frameCallback = video.requestVideoFrameCallback(callback);
    else this.animationFrame = requestAnimationFrame(callback);
  }
}
