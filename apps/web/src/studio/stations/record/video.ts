// Tracks the dancers in a video of the dance: each frame goes through the game's pose model (in
// a worker, as the camera's pictures do), and the people found are followed from frame to frame.
// The result is a take's worth of poses on the video's own clock.
import { assignSlots } from '../../../../../../packages/dance/tracking.ts';
import type { TrackedFrame } from '../../../../../../packages/dance/tracking.ts';
import { ASSET_PATH, poseModel } from '../../../../../../packages/pose/browser/models.ts';
import type { PoseWorkerRequest, PoseWorkerResponse } from '../../../../../../packages/pose/browser/pose.worker.ts';
import { detectedConfidence } from '../../../../../../packages/pose/browser/slots.ts';
import type { Landmark } from '../../../../../../packages/pose/choreography.ts';
import { seekFrames, seekVideoFrame, webCodecsFrames } from '../../../../../../tools/choreography/web/videoImport.ts';

export interface VideoTracking {
  /** One slot per person, the rightmost in the picture first (the first dancer, as a mirror shows them). */
  frames: TrackedFrame[];
  width: number; height: number; fps: number;
  /** The share of frames in which each person was found. */
  seen: number[];
}
const RATE = 30;
const cancelled = () => new DOMException('Tracking was cancelled', 'AbortError');

/** Tracks `people` dancers through the whole video. `onProgress` gets 0 to 1 as it goes. */
export async function trackVideo(file: Blob, people: number, onProgress: (fraction: number) => void, signal: AbortSignal): Promise<VideoTracking> {
  const url = URL.createObjectURL(file), video = document.createElement('video');
  const worker = new Worker(new URL('../../../../../../packages/pose/browser/pose.worker.ts', import.meta.url), { type: 'module' });
  const sessionId = crypto.randomUUID();
  /** Sends the worker a message and resolves with its answer of the wanted kind. */
  const ask = <T extends PoseWorkerResponse['type']>(message: PoseWorkerRequest, want: T, transfer: Transferable[] = []) =>
    new Promise<Extract<PoseWorkerResponse, { type: T }>>((resolve, reject) => {
      const timer = setTimeout(() => done(() => reject(Error('The pose tracker stopped answering.'))), 60_000);
      const done = (settle: () => void) => { clearTimeout(timer); worker.removeEventListener('message', onMessage); worker.removeEventListener('error', onError); signal.removeEventListener('abort', onAbort); settle(); };
      const onMessage = ({ data }: MessageEvent<PoseWorkerResponse>) => {
        if (data.type === 'error') done(() => reject(Error(data.message)));
        else if (data.type === want && (data.type !== 'result' || message.type === 'frame' && data.seq === message.seq)) done(() => resolve(data as Extract<PoseWorkerResponse, { type: T }>));
      };
      const onError = (e: ErrorEvent) => done(() => reject(Error(e.message || 'The pose tracker failed to start.')));
      const onAbort = () => done(() => reject(cancelled()));
      worker.addEventListener('message', onMessage); worker.addEventListener('error', onError); signal.addEventListener('abort', onAbort, { once: true });
      worker.postMessage(message, transfer);
    });
  try {
    if (signal.aborted) throw cancelled();
    video.preload = 'auto'; video.muted = true; video.playsInline = true; video.src = url;
    await new Promise<void>((resolve, reject) => { video.onloadeddata = () => resolve(); video.onerror = () => reject(Error('This browser can\'t play that video. Try an MP4 or WebM.')); });
    const width = video.videoWidth, height = video.videoHeight, durationMs = video.duration * 1000, aspect = width / height;
    if (!(width > 0 && height > 0 && durationMs > 0)) throw Error('That video has no picture to track.');
    const model = poseModel('lite'), base = new URL(`${import.meta.env?.BASE_URL || '/'}${ASSET_PATH}/`, location.origin).href;
    await ask({ type: 'initialize', sessionId, playerCount: people, runningMode: 'VIDEO', modelUrl: new URL(model.file, base).href, modelHash: model.sha256, wasmUrl: new URL('wasm', base).href }, 'ready');
    // Decoded straight through where the browser can; else by seeking the video a frame at a time.
    const frames = await webCodecsFrames(file, { width, height, durationMs, rate: RATE }) ?? seekFrames(video, seekVideoFrame, durationMs, signal, RATE);
    const found: { videoMs: number; poses: Landmark[][] }[] = [];
    let seq = 0, last = -Infinity, next = frames.next();
    try {
      for (;;) {
        const step = await next;
        if (step.done) break;
        if (signal.aborted) throw cancelled();
        const { source, mediaTimeMs } = step.value, bitmap = await createImageBitmap(source);
        // Decoded pictures come from a pool, so the next can decode while this one is looked at;
        // a video being seeked can't move on until its picture has been copied.
        next = frames.next();
        next.catch(() => {});
        if (!(mediaTimeMs > last && mediaTimeMs <= durationMs)) { bitmap.close(); continue; }
        const result = await ask({ type: 'frame', bitmap, seq: ++seq, timestampMs: mediaTimeMs }, 'result', [bitmap]);
        const poses = result.landmarks.map(points => points.map(p => ({ x: p.x, y: p.y, z: p.z, confidence: detectedConfidence(p) })))
          .filter(l => l.length === 33 && [11, 12, 23, 24].every(j => (l[j].confidence ?? 0) >= 0.5));
        found.push({ videoMs: Math.round(mediaTimeMs * 10) / 10, poses });
        last = mediaTimeMs;
        onProgress(Math.min(1, mediaTimeMs / durationMs));
      }
    } finally { await frames.return(); }
    if (found.length < 2 || found.every(f => !f.poses.length)) throw Error('No dancers could be found in that video. It needs to show them whole, from head to toe.');
    // People are numbered from the first picture that shows them all (so nobody takes another's
    // place by turning up first), left to right; then right to left, as the dance counts them.
    const first = found.findIndex(f => f.poses.length >= people);
    const tracked = assignSlots(found.map((f, i) => first >= 0 && i < first ? { ...f, poses: [] } : f), people, aspect);
    const out = tracked.map(f => ({ videoMs: f.videoMs, poses: [...f.poses].reverse() }));
    return { frames: out, width, height, fps: Math.round((out.length - 1) / (out[out.length - 1].videoMs - out[0].videoMs) * 10000) / 10,
      seen: Array.from({ length: people }, (_, s) => out.filter(f => f.poses[s]).length / out.length) };
  } finally {
    worker.postMessage({ type: 'close' } satisfies PoseWorkerRequest);
    worker.terminate();
    URL.revokeObjectURL(url);
    video.removeAttribute('src'); video.load();
  }
}
