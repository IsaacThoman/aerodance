import { ASSET_PATH, MEDIAPIPE_VERSION, poseModel } from '../../../packages/pose/browser/models.ts';
import type { PoseModel } from '../../../packages/pose/browser/models.ts';
import { assignPlayerSlots, detectedConfidence, PlayerSlotMapper } from '../../../packages/pose/browser/slots.ts';
import type { DetectedLandmark } from '../../../packages/pose/browser/slots.ts';
import type { PoseDelegate, PoseRunningMode, PoseWorkerRequest, PoseWorkerResponse } from '../../../packages/pose/browser/pose.worker.ts';
import { reliableBodyPose } from '../../../packages/character/calibration.ts';
import { validatePoses } from '../../../packages/pose/choreography.ts';
import { PoseFileWriter } from '../../../packages/pose/binary.ts';
import type { FrameInput } from '../../../packages/pose/binary.ts';
import type { CalibrationFrame } from '../core.ts';
import { captureHeader } from '../poseFiles.ts';
import type { CaptureStart } from '../poseFiles.ts';
import type { Landmark, Pose } from '../../../packages/pose/choreography.ts';
import { takeIdOf } from './api.ts';
import type { ApiRequest } from './api.ts';
import type { Input as MediaInput } from 'mediabunny';
import { capturePoses, detectionCount } from './captureMode.ts';
import type { CaptureMode } from './captureMode.ts';
import { CLEANUP_SETTINGS } from '../poseCleanup.ts';

const cancelled = () => new DOMException('Video import cancelled', 'AbortError');
export const DEFAULT_SAMPLE_RATE = 30;

/** A rectangle of the video frame, in pixels. */
export interface Crop { x: number; y: number; width: number; height: number; }
/** A detection shown on the calibration frame, whether or not it can be used. */
export interface DetectedPose extends Pose { ready: boolean; reason: string; }
export interface CalibrationPreview { poses: Pose[]; detectedPoses: DetectedPose[]; }
export interface CalibrationResult extends CalibrationPreview { mediaTimeMs: number; }
/** How a frame's media time was found: its decoded timestamp, or the seek position. */
export type VideoTimingMethod = 'decoded-frame' | 'seek-time';
export interface FrameTiming { mediaTimeMs: number; timingMethod: VideoTimingMethod; }
/** A decoded frame to run inference on: the <video> itself when seeking, or a decoded canvas. */
export interface DecodedFrame extends FrameTiming {
  source: HTMLVideoElement | HTMLCanvasElement | OffscreenCanvas;
  method: string;
}
export interface DecodeOptions { width: number; height: number; durationMs: number; rate: number; }
export interface ImportProgress { fraction: number; message: string; }
/** The pose model configuration a video take records. */
export interface VideoModelStatus {
  modelId: string; modelHash: string; packageVersion: string; delegate: PoseDelegate;
  thresholds: { detection: number; presence: number; tracking: number };
  inferenceMethod: string;
}
/** Region frames carry the region they were cropped for. */
export type ImportWorkerRequest = PoseWorkerRequest & { regionId?: number };
export type MessageListener = (event: MessageEvent<PoseWorkerResponse>) => void;
export type ErrorListener = (event: ErrorEvent) => void;
/** The part of a pose Worker the importer uses; replaceable in tests. */
export interface ImportWorker {
  postMessage(message: ImportWorkerRequest, transfer: Transferable[]): void;
  addEventListener(type: 'message', listener: MessageListener): void;
  addEventListener(type: 'error', listener: ErrorListener): void;
  removeEventListener(type: 'message', listener: MessageListener): void;
  removeEventListener(type: 'error', listener: ErrorListener): void;
  terminate(): void;
}
export type BitmapFn = (source: DecodedFrame['source'], ...crop: [] | [x: number, y: number, width: number, height: number]) => Promise<ImageBitmap>;
export type SeekFn = (video: HTMLVideoElement, time: number, signal: AbortSignal) => Promise<FrameTiming>;
export type DecodeFn = (file: Blob | null | undefined, options: DecodeOptions) => Promise<AsyncGenerator<DecodedFrame, void> | null>;
export interface VideoImporterOptions {
  cleanup?: boolean;
  captureMode?: CaptureMode;
  video: HTMLVideoElement;
  file?: Blob | null;
  modelId: string;
  request: ApiRequest;
  projectId: string;
  onProgress?: (progress: ImportProgress) => void;
  /** Samples per second, 1 to 30. */
  sampleRate?: number;
  createWorker?: () => ImportWorker;
  bitmap?: BitmapFn;
  seek?: SeekFn;
  decodeFrames?: DecodeFn;
  assetUrl?: () => string;
}
type ReadyResponse = Extract<PoseWorkerResponse, { type: 'ready' }>;
type ResultResponse = Extract<PoseWorkerResponse, { type: 'result' }>;
type InitializeRequest = Extract<PoseWorkerRequest, { type: 'initialize' }>;

// Sample the middle of each 1/rate s window. Container timestamps are rounded
// (67 ms for 66.7 ms), so sampling exactly k/rate often selects the prior frame.
export function* sampleTimes(durationMs: number, start = 0, rate = DEFAULT_SAMPLE_RATE): Generator<number, void> {
  for (let k = 0; k < Math.ceil(durationMs * rate / 1000); k++) yield start + (k + .5) / rate;
}

const confident = (p: DetectedLandmark | undefined) => (p ? detectedConfidence(p) ?? 0 : 0) >= .5;
export function videoRegionCrop(detections: readonly (readonly DetectedLandmark[])[], playerId: number, width: number, height: number): Crop {
  // Small dancers in portrait footage need a vertical crop as well as a side
  // crop. Use reliable detections to locate the common dancing area.
  const ys = detections.flatMap(points => {
    const visible = points.filter(p => Number.isFinite(p.y) && p.y >= 0 && p.y <= 1 && confident(p)).map(p => p.y * height);
    if ([11, 12, 23, 24].some(i => !confident(points[i]))) return visible;
    const shoulderY = (points[11].y + points[12].y) * height / 2, hipY = (points[23].y + points[24].y) * height / 2;
    const dx = (points[23].x + points[24].x - points[11].x - points[12].x) * width / 2;
    const torso = Math.hypot(dx, hipY - shoulderY);
    // Inferred feet can be low confidence in the original small detection;
    // don't let that crop them out of the recovery input.
    return [...visible, Math.max(0, shoulderY - torso), Math.min(height, hipY + torso * 2.5)];
  });
  const padding = ys.length ? Math.max(height * .05, (Math.max(...ys) - Math.min(...ys)) * .3) : 0;
  const cropHeight = Math.min(height, Math.max(width * .75, height * .4));
  const top = ys.length ? Math.max(0, Math.floor(Math.min(...ys) - padding)) : Math.floor((height - cropHeight) / 2);
  const bottom = ys.length ? Math.min(height, Math.ceil(Math.max(...ys) + padding)) : top + cropHeight;
  const left = playerId === 1 ? 0 : Math.floor(width / 2);
  return { x: left, y: top, width: playerId === 1 ? Math.floor(width / 2) : width - left,
    height: Math.max(1, Math.ceil(bottom - top)) };
}

export function restoreVideoLandmarks<T extends DetectedLandmark>(points: readonly T[], crop: Crop, width: number, height: number): T[] {
  return points.map(p => ({ ...p, x: (crop.x + p.x * crop.width) / width,
    y: (crop.y + p.y * crop.height) / height, z: p.z * crop.width / width }));
}

/** Frozen crop coordinates keep VIDEO tracking state meaningful across frames. */
export function fixedVideoCrop(poses: readonly Pose[], playerId: number, width: number, height: number): Crop {
  const crop = videoRegionCrop([], playerId, width, height);
  crop.y = 0; crop.height = height;
  const body = poses.find(p => p.playerId === playerId);
  if (!body || !reliableBodyPose(body)) return crop;
  const p = body.landmarks, shoulder = (p[11].y+p[12].y)*height/2, hip = (p[23].y+p[24].y)*height/2;
  const torso = Math.hypot((p[11].x+p[12].x-p[23].x-p[24].x)*width/2, shoulder-hip);
  const top = Math.max(0, Math.floor(Math.min(shoulder-2*torso, ...p.filter(v => v.confidence !== null && v.confidence >= .5).map(v => v.y*height))));
  const bottom = Math.min(height, Math.ceil(Math.max(hip+3*torso, ...p.filter(v => v.confidence !== null && v.confidence >= .5).map(v => v.y*height))));
  return bottom > top ? { ...crop, y: top, height: bottom-top } : crop;
}

export function selectVideoPose(full: Pose | undefined, regional: Pose | undefined, previous: {pose: Pose; time: number} | undefined, time: number, aspect: number): Pose | undefined {
  if (!previous || time-previous.time > 200) return full ?? regional;
  const hip = (p: Pose) => ({x:(p.landmarks[23].x+p.landmarks[24].x)/2,y:(p.landmarks[23].y+p.landmarks[24].y)/2});
  const center = hip(previous.pose), p = previous.pose.landmarks;
  const scale = Math.max(.001, Math.hypot((center.x-(p[11].x+p[12].x)/2)*aspect,center.y-(p[11].y+p[12].y)/2));
  const distance = (pose: Pose) => { const h=hip(pose); return Math.hypot((h.x-center.x)*aspect,h.y-center.y); };
  if (!regional || distance(regional)>scale) return full;
  if (!full || distance(full)>scale) return regional;
  // Only override valid full-frame tracking when the estimates disagree markedly.
  const a=hip(full),b=hip(regional);
  return Math.hypot((a.x-b.x)*aspect,a.y-b.y)>.5*scale && distance(regional)<distance(full) ? regional : full;
}

// Display every valid detection, even when confidence or framing prevents using
// it for calibration. Otherwise a detected dancer looks completely missing.
export function videoCalibrationPreview(detections: readonly (readonly DetectedLandmark[])[], captureMode: CaptureMode = 'both'): CalibrationPreview {
  const accepted = capturePoses(assignPlayerSlots(detections, detectionCount(captureMode)).filter(reliableBodyPose), captureMode);
  const detectedPoses = detections.flatMap((points): DetectedPose[] => {
    const landmarks: Landmark[] = points.map(p => ({ x: p.x, y: p.y, z: p.z,
      confidence: detectedConfidence(p) }));
    try { validatePoses([{ playerId: 0, landmarks }]); } catch { return []; }
    const x = (landmarks[23].x + landmarks[24].x) / 2;
    const playerId = captureMode === 'both' ? x < .5 ? 1 : 0 : captureMode === 'p1' ? 0 : 1;
    const ready = accepted.some(p => p.playerId === playerId &&
      p.landmarks[23].x === landmarks[23].x && p.landmarks[23].y === landmarks[23].y);
    const reason = ready ? 'ready' : captureMode === 'both' && Math.abs(x - .5) <= .025
      ? 'move away from the center divider' : 'needs clearer shoulders, hips and feet';
    return [{ playerId, landmarks, ready, reason }];
  });
  return { poses: accepted, detectedPoses };
}

// Seek before copying pixels. Frame callbacks supply presentation timestamps;
// older browsers (and seeks that do not present a new frame) use seek time.
export function seekVideoFrame(video: HTMLVideoElement, time: number, signal: AbortSignal): Promise<FrameTiming> {
  return new Promise((resolve, reject) => {
    let callback: number | undefined, frameTimer: ReturnType<typeof setTimeout> | undefined, frame: FrameTiming | undefined;
    const timeout = setTimeout(() => { cleanup(); reject(Error('Video decoding timed out. Try another video format.')); }, 15000);
    const cleanup = () => {
      clearTimeout(timeout); clearTimeout(frameTimer);
      if (callback !== undefined) video.cancelVideoFrameCallback?.(callback);
      video.removeEventListener('seeked', seeked); video.removeEventListener('error', failed);
      signal.removeEventListener('abort', abort);
    };
    const finish = () => { cleanup(); resolve(frame || { mediaTimeMs: video.currentTime * 1000, timingMethod: 'seek-time' }); };
    const abort = () => { cleanup(); reject(cancelled()); };
    const failed = () => { cleanup(); reject(Error('Could not decode this video frame. Try another video format.')); };
    const seeked = () => {
      if (video.readyState < 2) { failed(); return; }
      if (frame || !video.requestVideoFrameCallback) finish();
      else frameTimer = setTimeout(finish, 100);
    };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    video.addEventListener('error', failed, { once: true });
    video.addEventListener('seeked', seeked, { once: true });
    if (video.requestVideoFrameCallback) callback = video.requestVideoFrameCallback((_now, metadata) => {
      frame = { mediaTimeMs: metadata.mediaTime * 1000, timingMethod: 'decoded-frame' };
      if (!video.seeking && video.readyState >= 2) finish();
    });
    video.pause();
    try { video.currentTime = time; } catch { failed(); }
  });
}

// Fallback when WebCodecs cannot decode the file: one seek per sample.
export async function* seekFrames(video: HTMLVideoElement, seek: SeekFn, durationMs: number, signal: AbortSignal, rate?: number): AsyncGenerator<DecodedFrame, void> {
  for (const time of sampleTimes(durationMs, 0, rate)) yield { source: video, method: 'seeking', ...await seek(video, time, signal) };
}

// Decodes the file sequentially, avoiding a decoder reset for every sample.
// Returns null when this browser or file needs the seeking fallback.
export async function webCodecsFrames(file: Blob | null | undefined, { width, height, durationMs, rate }: DecodeOptions): Promise<AsyncGenerator<DecodedFrame, void> | null> {
  if (!file || typeof VideoDecoder === 'undefined') return null;
  let input: MediaInput | undefined;
  try {
    const { Input, BlobSource, ALL_FORMATS, CanvasSink } = await import('mediabunny');
    const source = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    input = source;
    const track = await source.getPrimaryVideoTrack();
    // CanvasSink applies rotation metadata; the size must match what <video>
    // reports, which calibration and region crops use.
    if (!track || !await track.canDecode() || track.displayWidth !== width || track.displayHeight !== height) {
      source.dispose(); return null;
    }
    // Timestamps stay in file time, matching the <video> frame callbacks that
    // calibration uses, but files may start after zero.
    const start = Math.max(0, await track.getFirstTimestamp());
    // One canvas in inference, one prefetched, one spare.
    const sink = new CanvasSink(track, { poolSize: 3 });
    return (async function* () {
      try {
        for await (const frame of sink.canvasesAtTimestamps(sampleTimes(durationMs, start, rate))) {
          if (frame && frame.timestamp >= 0) yield { source: frame.canvas, mediaTimeMs: frame.timestamp * 1000,
            timingMethod: 'decoded-frame' as const, method: 'WebCodecs' };
        }
      } finally { source.dispose(); }
    })();
  } catch { input?.dispose(); return null; }
}

const createPoseWorker = (): ImportWorker =>
  new Worker(new URL('../../../packages/pose/browser/pose.worker.ts', import.meta.url), { type: 'module' });
const createBitmap: BitmapFn = (source, ...crop) =>
  crop.length === 4 ? createImageBitmap(source, ...crop) : createImageBitmap(source);
const defaultAssetUrl = () => new URL(`${import.meta.env?.BASE_URL || '/'}${ASSET_PATH}/`, location.origin).href;

export class VideoImporter {
  cleanup: boolean;
  captureMode: CaptureMode;
  video: HTMLVideoElement;
  file: Blob | null | undefined;
  modelId: string;
  request: ApiRequest;
  projectId: string;
  onProgress: (progress: ImportProgress) => void;
  sampleRate: number;
  createWorker: () => ImportWorker;
  bitmap: BitmapFn;
  seek: SeekFn;
  decodeFrames: DecodeFn;
  assetUrl: () => string;
  model: PoseModel;
  controller = new AbortController();
  sessionId: string = crypto.randomUUID();
  seq = 0;
  worker: ImportWorker | null = null;
  regionWorkers = new Map<number, ImportWorker>();
  regionCrops = new Map<number, Crop>();
  calibrationPoses: Pose[] = [];
  previousPoses = new Map<number, {pose: Pose; time: number}>();
  workerConfig?: InitializeRequest;
  /** The capture's API path once processing has started it. */
  path?: string;
  players = new Set<number>();
  batchCount = 0;
  recordCount = 0;
  processed?: boolean;
  constructor({ video, file, modelId, request, projectId, cleanup = true, captureMode = 'both', onProgress = () => {}, sampleRate = DEFAULT_SAMPLE_RATE,
    createWorker = createPoseWorker, bitmap = createBitmap, seek = seekVideoFrame, decodeFrames = webCodecsFrames,
    assetUrl = defaultAssetUrl,
  }: VideoImporterOptions) {
    this.video = video; this.file = file; this.modelId = modelId; this.request = request; this.projectId = projectId;
    this.onProgress = onProgress; this.sampleRate = sampleRate; this.createWorker = createWorker; this.bitmap = bitmap;
    this.seek = seek; this.decodeFrames = decodeFrames; this.assetUrl = assetUrl;
    this.model = poseModel(modelId);
    this.captureMode = captureMode;
    this.cleanup = cleanup;
  }
  abort() {
    this.controller.abort(); this.closeWorker(); this.video.pause();
  }
  closeWorker() {
    this.worker?.terminate(); this.worker = null;
    for (const worker of this.regionWorkers.values()) worker.terminate();
    this.regionWorkers.clear();
  }
  waitForMessage(send: ImportWorkerRequest, type: 'ready', worker?: ImportWorker | null): Promise<ReadyResponse>;
  waitForMessage(send: ImportWorkerRequest, type: 'result', worker?: ImportWorker | null): Promise<ResultResponse>;
  waitForMessage(send: ImportWorkerRequest, type: 'ready' | 'result', worker = this.worker): Promise<ReadyResponse | ResultResponse> {
    const signal = this.controller.signal;
    return new Promise((resolve, reject) => {
      if (!worker) { reject(Error('Video pose worker is not running')); return; }
      const timer = setTimeout(() => fail(Error('Pose processing timed out. Try Lite or another browser.')), 60000);
      const cleanup = () => {
        clearTimeout(timer); worker.removeEventListener('message', message); worker.removeEventListener('error', error);
        signal.removeEventListener('abort', abort);
      };
      const fail = (e: unknown) => { cleanup(); reject(e); };
      const abort = () => fail(cancelled());
      const error = (e: ErrorEvent) => fail(Error(e.message || 'Video pose worker failed'));
      const message = ({ data }: MessageEvent<PoseWorkerResponse>) => {
        if (data.sessionId !== this.sessionId) return;
        if (data.type === 'error') fail(Error(data.message));
        else if (data.type === type && (data.type !== 'result' || send.type === 'frame' && data.seq === send.seq)) { cleanup(); resolve(data); }
      };
      if (signal.aborted) { abort(); return; }
      worker.addEventListener('message', message); worker.addEventListener('error', error);
      signal.addEventListener('abort', abort, { once: true });
      const bitmap = send.type === 'frame' ? send.bitmap : undefined;
      try { worker.postMessage(send, bitmap ? [bitmap] : []); } catch (e) { bitmap?.close(); fail(e); }
    });
  }
  async initialize(runningMode: PoseRunningMode): Promise<VideoModelStatus> {
    this.closeWorker(); this.worker = this.createWorker();
    this.regionCrops.clear(); this.previousPoses.clear();
    const base = this.assetUrl();
    this.workerConfig = { type: 'initialize', sessionId: this.sessionId, playerCount: detectionCount(this.captureMode), runningMode,
      modelUrl: new URL(this.model.file, base).href, modelHash: this.model.sha256,
      wasmUrl: new URL('wasm', base).href };
    const ready = await this.waitForMessage(this.workerConfig, 'ready');
    return { modelId: this.model.id, modelHash: this.model.sha256, packageVersion: MEDIAPIPE_VERSION,
      delegate: ready.delegate, thresholds: { detection: .5, presence: .5, tracking: .5 },
      inferenceMethod: this.captureMode === 'both' ? 'full-frame-with-continuous-region-tracking' : 'full-frame-solo' };
  }
  async ensureRegionWorker(regionId: number): Promise<ImportWorker> {
    if (!this.regionWorkers.has(regionId)) {
      if (!this.workerConfig) throw Error('Initialize video tracking first');
      // One independent task per side preserves both VIDEO tracking histories.
      const worker = this.createWorker();
      this.regionWorkers.set(regionId, worker);
      await this.waitForMessage({ ...this.workerConfig, playerCount: 1 }, 'ready', worker);
    }
    return this.regionWorkers.get(regionId)!;
  }
  async infer(mediaTimeMs: number, crop: Crop | null, regionId: number | null, source: DecodedFrame['source'] = this.video): Promise<ResultResponse> {
    const worker = crop ? await this.ensureRegionWorker(regionId!) : this.worker;
    const bitmap = crop ? await this.bitmap(source, crop.x, crop.y, crop.width, crop.height) : await this.bitmap(source);
    if (this.controller.signal.aborted) { bitmap.close(); throw cancelled(); }
    return this.waitForMessage({ type: 'frame', bitmap, seq: ++this.seq,
      timestampMs: mediaTimeMs, ...(crop && regionId !== null ? { regionId } : {}) }, 'result', worker);
  }
  async detectDancers(mediaTimeMs: number, calibration = false, source: DecodedFrame['source'] = this.video): Promise<DetectedLandmark[][]> {
    const result = await this.infer(mediaTimeMs, null, null, source);
    let detections: DetectedLandmark[][] = result.landmarks;
    if (this.captureMode !== 'both') return detections;
    const accepted = assignPlayerSlots(detections, 2).filter(p => !calibration || reliableBodyPose(p));
    const width = this.video.videoWidth, height = this.video.videoHeight;
    for (const id of [0, 1]) {
      if (calibration && accepted.some(p => p.playerId === id)) continue;
      if (!this.regionCrops.has(id)) this.regionCrops.set(id, fixedVideoCrop(this.calibrationPoses, id, width, height));
      const crop = calibration ? videoRegionCrop(detections, id, width, height) : this.regionCrops.get(id)!;
      const regional = await this.infer(mediaTimeMs, crop, id, source);
      const restored = regional.landmarks.map(p => restoreVideoLandmarks(p, crop, width, height));
      const candidate = assignPlayerSlots(restored, 2).find(p => p.playerId === id);
      const chosen = calibration ? candidate && reliableBodyPose(candidate) ? candidate : undefined
        : selectVideoPose(accepted.find(p => p.playerId === id), candidate, this.previousPoses.get(id), mediaTimeMs, width/height);
      if (!chosen) {
        if (!calibration) detections = detections.filter(p => ((p[23].x+p[24].x)/2 < .5 ? 1 : 0) !== id);
        continue;
      }
      if (!calibration) this.previousPoses.set(id, {pose: chosen, time: mediaTimeMs});
      // Replace candidates only in the searched region, retaining the other
      // dancer and its original coordinates and confidence.
      detections = detections.filter(p => ((p[23].x + p[24].x) / 2 < .5 ? 1 : 0) !== id);
      detections.push(chosen.landmarks.map(({ confidence, ...p }) => ({ ...p, visibility: confidence, presence: confidence })));
    }
    return detections;
  }
  async calibrate(time = this.video.currentTime): Promise<CalibrationResult> {
    try {
      await this.initialize('IMAGE');
      const frame = await this.seek(this.video, time, this.controller.signal);
      const preview = videoCalibrationPreview(await this.detectDancers(frame.mediaTimeMs, true), this.captureMode);
      if (!preview.detectedPoses.length) throw Error('No dancers detected in this frame. Try a clearer frame with the dancers\' whole bodies visible.');
      this.calibrationPoses = preview.poses;
      return { mediaTimeMs: frame.mediaTimeMs, ...preview };
    } finally { this.closeWorker(); }
  }
  async upload(path: string, body: unknown): Promise<unknown> {
    const options = { method: 'POST', body, signal: this.controller.signal };
    try { return await this.request(path, options); }
    catch {
      if (this.controller.signal.aborted) throw cancelled();
      return this.request(path, options);
    }
  }
  async process(filename: string) {
    const durationMs = this.video.duration * 1000;
    if (!(durationMs > 0 && durationMs <= 3600000) || !this.video.videoWidth || !this.video.videoHeight)
      throw Error('Choose a decodable video between zero and one hour long');
    const input = { width: this.video.videoWidth, height: this.video.videoHeight, mirrored: false };
    this.onProgress({ fraction: 0, message: `Loading ${this.model.label} model…` });
    try {
      const status = { ...await this.initialize('VIDEO'), filename, durationMs, targetRateHz: this.sampleRate, captureMode: this.captureMode,
        cleanup: this.cleanup ? { ...CLEANUP_SETTINGS } : false };
      const header: CaptureStart = { sourceKind: 'video', sessionId: this.sessionId, input: { width: input.width, height: input.height },
        playerCount: 2, modelId: this.model.id, audioPlaybackRate: null, extensionBases: [] };
      const writer = new PoseFileWriter(captureHeader(header));
      const capture = await this.upload(`/api/projects/${this.projectId}/takes`, { sourceKind: 'video', name: filename, status, header });
      const path = `/api/projects/${this.projectId}/takes/${takeIdOf(capture)}`;
      this.path = path;
      this.players = new Set(); this.batchCount = 0; this.recordCount = 0;
      const slots = new PlayerSlotMapper();
      let lastTime = -Infinity, pending: FrameInput[] = [];
      const flush = async () => {
        if (!pending.length) return;
        await this.upload(`${path}/batches?batchId=${this.batchCount}`, writer.frames(pending));
        this.batchCount++; pending = [];
      };
      const frames = await this.decodeFrames(this.file, { width: input.width, height: input.height, durationMs,
        rate: this.sampleRate }) ?? seekFrames(this.video, this.seek, durationMs, this.controller.signal, this.sampleRate);
      let next = frames.next(), firstTime: number | undefined;
      try {
        for (;;) {
          const result = await next;
          if (result.done) break;
          if (this.controller.signal.aborted) throw cancelled();
          const { source, method, mediaTimeMs, timingMethod } = result.value;
          // Decoded canvases come from a pool, so the next frame can decode
          // during inference. The seeking fallback must not move the video yet.
          const prefetch = source !== this.video;
          const upcoming = prefetch ? frames.next() : null;
          upcoming?.catch(() => {});
          // The last sample window can reach past the container duration, and
          // the final frame's timestamp may exceed it; the take rejects those.
          if (mediaTimeMs > lastTime && mediaTimeMs <= durationMs) {
            if (!prefetch && (this.video.videoWidth !== input.width || this.video.videoHeight !== input.height))
              throw Error('Video dimensions changed during processing');
            const poses = capturePoses(slots.map(await this.detectDancers(mediaTimeMs, false, source), detectionCount(this.captureMode)), this.captureMode);
            for (const p of poses) this.players.add(p.playerId);
            pending.push({ timeMs: mediaTimeMs, poses: validatePoses(poses), seq: ++this.recordCount,
              seekTime: timingMethod === 'seek-time' });
            lastTime = mediaTimeMs;
            firstTime ??= mediaTimeMs;
            this.onProgress({ fraction: Math.min(1, (mediaTimeMs - firstTime) / durationMs),
              message: `Processing video · ${this.recordCount} samples · ${method} · ${status.delegate}` });
            if (pending.length >= 100) await flush();
          }
          next = upcoming ?? frames.next();
        }
      } finally { await frames.return(); }
      await flush();
      if (this.recordCount < 2) throw Error('Video needs at least two distinct frames');
      if (!this.players.size) throw Error('No dancers detected in this video');
      this.processed = true;
    } finally { this.closeWorker(); }
  }
  /** Resolves with the saved take (unvalidated). */
  async finalize(calibrationFrame: CalibrationFrame | null): Promise<unknown> {
    if (!this.processed) throw Error('Process the video first');
    const missing = [...this.players].filter(id => !calibrationFrame?.poses.some(p => p.playerId === id));
    if (missing.length) throw Error(`Choose a calibration frame with ${missing.map(id => `P${id + 1}`).join(' and ')} clearly visible. Processed poses are ready to save.`);
    return this.upload(`${this.path}/finalize`, { batchCount: this.batchCount, recordCount: this.recordCount, calibrationFrame });
  }
}
