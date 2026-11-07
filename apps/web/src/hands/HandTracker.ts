import { ASSET_PATH } from '../../../../packages/pose/browser/models.ts';
import type { TrackerRequest, TrackerResponse, TrackerResult } from './tracker.worker.ts';

/*
 * The /?hands demo's camera: the webcam (or, in development, ?video=<url> played as one) sent a
 * frame at a time to tracker.worker.ts. It keeps one frame in flight, so it runs as fast as the
 * models do.
 */

export type TrackerStatus = 'off' | 'starting' | 'running' | 'error';
export interface TrackerView {
  status: TrackerStatus;
  message: string;
  result: TrackerResult | null;
  /** Results a second. */
  hz: number;
  /** How long a frame takes from the camera to its result, eased, in milliseconds (0: not known yet). */
  latencyMs: number;
}
type Listener = (view: TrackerView, fresh: TrackerResult | null) => void;

const base = () => new URL(`${import.meta.env.BASE_URL || '/'}${ASSET_PATH}/`, location.origin);

export class HandTracker {
  view: TrackerView = { status: 'off', message: '', result: null, hz: 0, latencyMs: 0 };
  video: HTMLVideoElement | null = null;
  private listeners = new Set<Listener>();
  private worker: Worker | null = null;
  private stream: MediaStream | null = null;
  private busy = false;
  private seq = 0;
  private times: number[] = [];
  private generation = 0;
  /** When the frame being tracked was captured (performance.now's clock). */
  private capturedAt = 0;

  subscribe(listener: Listener) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private publish(change: Partial<TrackerView>, fresh: TrackerResult | null = null) {
    this.view = { ...this.view, ...change };
    for (const listener of this.listeners) listener(this.view, fresh);
  }

  async start(videoUrl?: string | null) {
    this.stop();
    const generation = ++this.generation;
    this.publish({ status: 'starting', message: 'Waiting for the camera…', result: null });
    try {
      const video = document.createElement('video');
      video.muted = true; video.playsInline = true;
      if (videoUrl) {
        Object.assign(video, { src: videoUrl, loop: true, crossOrigin: 'anonymous' });
      } else {
        if (!navigator.mediaDevices?.getUserMedia) throw Error('The camera needs HTTPS (or localhost).');
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } });
        video.srcObject = this.stream;
      }
      await video.play();
      if (generation !== this.generation) return;
      this.video = video;
      this.publish({ message: 'Loading the hand tracking models…' });
      const worker = this.worker = new Worker(new URL('./tracker.worker.ts', import.meta.url), { type: 'module' });
      await new Promise<void>((resolve, reject) => {
        worker.onmessage = ({ data }: MessageEvent<TrackerResponse>) => {
          if (data.type === 'ready') resolve();
          else if (data.type === 'error') reject(Error(data.message));
        };
        worker.onerror = (e) => reject(Error(e.message || 'The tracker failed to start'));
        const b = base();
        const init: TrackerRequest = { type: 'initialize', wasmUrl: new URL('wasm', b).href, poseUrl: new URL(new URLSearchParams(location.search).get('pose') === 'full' ? 'hands-pose_landmarker_full.task' : 'pose_landmarker_lite.task', b).href, handUrl: new URL('hands-hand_landmarker.task', b).href };
        worker.postMessage(init);
      });
      if (generation !== this.generation) return;
      worker.onmessage = ({ data }: MessageEvent<TrackerResponse>) => {
        // A result that was on its way when the camera stopped.
        if (generation !== this.generation) return;
        this.busy = false;
        if (data.type === 'error') { console.warn('hand tracker:', data.message); return; }
        if (data.type !== 'result') return;
        const now = performance.now();
        this.times.push(now);
        while (this.times.length && this.times[0] < now - 1000) this.times.shift();
        const { type: _type, ...result } = data;
        const took = now - this.capturedAt;
        const latencyMs = !this.view.latencyMs ? took : took > 0 && took < 1000 ? this.view.latencyMs * 0.9 + took * 0.1 : this.view.latencyMs;
        this.publish({ status: 'running', message: '', result, hz: this.times.length, latencyMs }, result);
      };
      this.publish({ status: 'running', message: '' });
      this.pump(video, generation);
    } catch (error) {
      if (generation !== this.generation) return;
      this.stop();
      this.publish({ status: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }

  private pump(video: HTMLVideoElement, generation: number) {
    const next = () => {
      if (generation !== this.generation) return;
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(send); else requestAnimationFrame(() => send());
    };
    const send = (_now?: number, frame?: VideoFrameCallbackMetadata) => {
      if (generation !== this.generation) return;
      if (this.busy || !this.worker || video.readyState < 2) { next(); return; }
      this.busy = true;
      // When the camera took it, if it says (else when it was shown).
      this.capturedAt = frame?.captureTime ?? frame?.presentationTime ?? performance.now();
      createImageBitmap(video).then((bitmap) => {
        if (generation !== this.generation || !this.worker) { bitmap.close(); return; }
        const frame: TrackerRequest = { type: 'frame', bitmap, seq: ++this.seq, timestampMs: performance.now() };
        this.worker.postMessage(frame, [bitmap]);
      }, () => { this.busy = false; }).finally(next);
    };
    next();
  }

  stop() {
    this.generation++;
    this.worker?.terminate();
    this.worker = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.video?.pause();
    this.video = null;
    this.busy = false;
    if (this.view.status !== 'off') this.publish({ status: 'off', message: '', result: null, hz: 0, latencyMs: 0 });
  }
}
