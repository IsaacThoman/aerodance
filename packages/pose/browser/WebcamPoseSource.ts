import { MEDIAPIPE_VERSION, ASSET_PATH, isPoseModelId, poseModel } from './models.ts';
import type { PoseModelId } from './models.ts';
import { PlayerSlotMapper } from './slots.ts';
import { validateWebcamRecord } from '../webcamRecord.ts';
import type { WebcamRecord } from '../webcamRecord.ts';
import { isPlayerCount } from '../choreography.ts';
import type { CaptureInput, PlayerCount } from '../choreography.ts';
import type { PoseDelegate, PoseWorkerRequest, PoseWorkerResponse } from './pose.worker.ts';

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
  bitmap?: (video: HTMLVideoElement) => Promise<ImageBitmap>;
  now?: () => number;
  assetUrl?: () => string;
  /** Prefix of the saved model and camera settings (a phone camera keeps its own). */
  settingsKey?: string;
  /** A camera that changes size (a phone turned sideways) carries on at the new size instead of failing. */
  adaptToResize?: boolean;
}
export interface WebcamConfigureOptions { modelId?: string; cameraId?: string; facing?: CameraFacing; }
interface PendingFrame { seq: number; mediaTimeMs: number; frameBrowserTimeMs: number; }

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
  bitmap: (video: HTMLVideoElement) => Promise<ImageBitmap>;
  now: () => number;
  assetUrl: () => string;
  settingsKey: string;
  adaptToResize: boolean;
  listeners = new Set<Listener<WebcamView>>();
  recordListeners = new Set<Listener<WebcamRecordEvent>>();
  generation = 0;
  playerCount: PlayerCount = 1;
  view: WebcamView;
  controller: AbortController | null = null;
  startupTimeout: ReturnType<typeof setTimeout> | undefined;
  watchdog: ReturnType<typeof setInterval> | undefined;
  video: HTMLVideoElement | null = null;
  stream: MediaStream | null = null;
  worker: PoseWorker | null = null;
  frameCallback: number | null = null;
  animationFrame: number | null = null;
  hidden: (() => void) | null = null;
  pagehide: (() => void) | null = null;
  pending: PendingFrame | null = null;
  busy = false;
  // Per-session state, reset by connect().
  input: CaptureInput | null = null;
  sessionId = '';
  seq = 0;
  lastMediaTime = -Infinity;
  /** When the camera last delivered a new frame (tracked or not). */
  lastFrame = 0;
  slots = new PlayerSlotMapper();
  resultTimes: number[] = [];
  startedAt = 0;
  completed = 0;
  dropped = 0;
  lastResult = 0;
  constructor({ mediaDevices = globalThis.navigator?.mediaDevices,
    createWorker = () => new Worker(new URL('./pose.worker.ts', import.meta.url), { type: 'module' }),
    createVideo = () => document.createElement('video'),
    bitmap = video => createImageBitmap(video), now = () => performance.now(),
    assetUrl = () => new URL(`${import.meta.env?.BASE_URL || '/'}${ASSET_PATH}/`, location.origin).href,
    settingsKey = 'aerodance-webcam', adaptToResize = false,
  }: WebcamPoseSourceOptions = {}) {
    this.mediaDevices = mediaDevices; this.createWorker = createWorker; this.createVideo = createVideo;
    this.bitmap = bitmap; this.now = now; this.assetUrl = assetUrl; this.settingsKey = settingsKey; this.adaptToResize = adaptToResize;
    const savedModel = saved(`${settingsKey}-model`, 'lite');
    const modelId: PoseModelId = isPoseModelId(savedModel) ? savedModel : 'lite';
    const facing = saved(`${settingsKey}-facing`, '');
    this.view = { status: 'disconnected', sourceKind: 'webcam', snapshot: null, configuring: false,
      message: 'Choose a camera and model, then Start camera.', model: modelId,
      cameraId: saved(`${settingsKey}-camera`, ''), cameras: [], stats: null,
      ...(facing === 'user' || facing === 'environment' ? { facing } : {}) };
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
    this.stream = null; this.video = null;
    // Ask the worker to close; termination releases it even during a hung inference.
    if (this.worker) {
      const worker = this.worker;
      worker.postMessage({ type: 'close' });
      worker.terminate(); this.worker = null;
    }
    if (this.hidden) globalThis.document?.removeEventListener('visibilitychange', this.hidden);
    if (this.pagehide) globalThis.window?.removeEventListener('pagehide', this.pagehide);
    this.pending = null; this.busy = false;
    this.emit({ event: { type: 'source-stopped', reason: message }, receivedBrowserTimeMs: this.now() });
    this.publish({ status: 'disconnected', snapshot: null, configuring: false, stats: null, message });
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
    this.publish({ status: 'connecting', snapshot: null, message: 'Waiting for camera permission…' });
    try {
      if (!this.mediaDevices?.getUserMedia) throw Error('Camera access requires HTTPS or localhost and a browser with webcam support.');
      const stream = await this.mediaDevices.getUserMedia({ audio: false, video: {
        width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 },
        ...(this.view.cameraId ? { deviceId: { exact: this.view.cameraId } } : this.view.facing ? { facingMode: { ideal: this.view.facing } } : {}),
      } });
      if (!current()) { for (const track of stream.getTracks()) track.stop(); return; }
      this.stream = stream;
      for (const track of stream.getVideoTracks()) track.addEventListener('ended', () => { if (current()) this.fail(Error('Camera disconnected. Choose a camera and start again.')); });
      this.hidden = () => { if (document.hidden) this.disconnect('Tab was hidden. Start camera to resume.'); };
      this.pagehide = () => this.disconnect();
      globalThis.document?.addEventListener('visibilitychange', this.hidden);
      globalThis.window?.addEventListener('pagehide', this.pagehide);
      if (globalThis.document?.hidden) { this.disconnect('Tab was hidden. Start camera to resume.'); return; }
      await this.refreshCameras();
      if (!current()) return;
      const deviceId = stream.getVideoTracks()[0]?.getSettings().deviceId;
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
      this.startupTimeout = setTimeout(() => { if (current()) this.fail(Error('Camera/model startup timed out. Try again or choose Lite.')); }, 60000);
      await aborted(video.play(), controller.signal);
      if (!current()) return;
      if (!video.videoWidth || !video.videoHeight) throw Error('Camera produced no video frames. Start again.');
      this.input = { width: video.videoWidth, height: video.videoHeight, mirrored: false };
      const model = poseModel(this.view.model);
      this.sessionId = crypto.randomUUID(); this.seq = 0; this.lastMediaTime = -Infinity;
      this.slots = new PlayerSlotMapper(); this.resultTimes = [];
      this.startedAt = this.now(); this.completed = 0; this.dropped = 0; this.lastResult = this.lastFrame = this.startedAt;
      const worker = this.worker = this.createWorker();
      worker.onmessage = ({ data }) => { if (current() && data.sessionId === this.sessionId) this.handleWorker(data); };
      worker.onerror = event => { if (current()) this.fail(Error(event.message || 'Pose worker failed. Try another model or browser.')); };
      const base = this.assetUrl();
      this.publish({ status: 'initializing', message: `Loading ${model.label} model…`,
        modelConfig: { modelId: model.id, modelHash: model.sha256, packageVersion: MEDIAPIPE_VERSION,
          thresholds: { detection: 0.5, presence: 0.5, tracking: 0.5 }, timingMethod: 'browser-frame-observation' } });
      worker.postMessage({ type: 'initialize', sessionId: this.sessionId, playerCount: this.playerCount,
        modelUrl: new URL(model.file, base).href, modelHash: model.sha256, wasmUrl: new URL('wasm', base).href });
      this.watchdog = setInterval(() => {
        if (!current()) return;
        if (this.view.snapshot && this.now() - this.view.snapshot.frameBrowserTimeMs >= 500) this.publish({ snapshot: null });
        // Say which half stopped: the camera's pictures, or the model on them.
        if (this.view.status === 'connected' && this.now() - this.lastResult > 10000) {
          this.fail(Error(this.now() - this.lastFrame > 5000 ? 'The camera stopped sending pictures. Start camera to retry.' : 'Camera tracking stopped responding. Start camera to retry.'));
        }
      }, 100);
    } catch (error) { if (current()) this.fail(error); }
  }
  handleWorker(data: PoseWorkerResponse) {
    if (data.type === 'error') { this.fail(Error(data.message)); return; }
    if (data.type === 'ready') {
      this.publish({ delegate: data.delegate, modelConfig: this.view.modelConfig && { ...this.view.modelConfig, delegate: data.delegate },
        message: data.fallback ? 'GPU unavailable; using CPU. Waiting for the first pose result…' : 'Waiting for the first pose result…' });
      this.schedule(); return;
    }
    if (data.type !== 'result' || !this.pending || data.seq !== this.pending.seq) return;
    const pending = this.pending;
    this.pending = null; this.busy = false;
    const receivedBrowserTimeMs = this.now();
    this.lastResult = receivedBrowserTimeMs;
    const frameAgeMs = receivedBrowserTimeMs - pending.frameBrowserTimeMs;
    // Never let a slow result revive expired player readiness or contaminate a take.
    if (frameAgeMs >= 500) { this.dropped++; this.publish({ snapshot: null, message: 'Tracking is too slow. Try Lite or another camera.' }); return; }
    try {
      const record = validateWebcamRecord({ schema: 'aerodance.webcam-record', schemaVersion: 1, type: 'pose',
        sessionId: this.sessionId, seq: pending.seq, playerCount: this.playerCount, input: this.input,
        modelId: this.view.model, mediaTimeMs: pending.mediaTimeMs, frameBrowserTimeMs: pending.frameBrowserTimeMs, resultBrowserTimeMs: receivedBrowserTimeMs,
        timingMethod: 'browser-frame-observation', poses: this.slots.map(data.landmarks, this.playerCount) });
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
      if (this.busy) { this.dropped++; return; }
      if (video.videoWidth !== this.input?.width || video.videoHeight !== this.input.height) {
        if (!this.adaptToResize || !video.videoWidth || !video.videoHeight) { this.fail(Error('Camera dimensions changed. Start again to recalibrate.')); return; }
        // No frame is in flight (busy returned above), so no result mixes the two sizes.
        // Calibration and the live characters start afresh when a record's input size changes.
        this.input = { width: video.videoWidth, height: video.videoHeight, mirrored: false };
        this.slots = new PlayerSlotMapper();
      }
      this.busy = true;
      const pending = this.pending = { seq: ++this.seq, mediaTimeMs, frameBrowserTimeMs: this.now() };
      void this.bitmap(video).then(bitmap => {
        const worker = this.worker;
        if (generation !== this.generation || !worker) { bitmap.close(); return; }
        worker.postMessage({ type: 'frame', bitmap, seq: pending.seq, timestampMs: mediaTimeMs }, [bitmap]);
      }).catch(error => { if (generation === this.generation) this.fail(error); });
    };
    if (video.requestVideoFrameCallback) this.frameCallback = video.requestVideoFrameCallback(callback);
    else this.animationFrame = requestAnimationFrame(callback);
  }
}
