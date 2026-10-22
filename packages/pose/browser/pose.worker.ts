import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
import { describeLooks, LOOKS_WIDTH } from './appearance.ts';

// The message protocol between a page (WebcamPoseSource, Studio video import) and this worker.
export type PoseRunningMode = 'IMAGE' | 'VIDEO';
export type PoseDelegate = 'GPU' | 'CPU';
export type PoseWorkerRequest =
  /** playerCount is how many poses to look for; looks asks for each person's looks (appearance.ts) too. */
  | { type: 'initialize'; sessionId: string; playerCount: number; modelUrl: string; modelHash: string; wasmUrl: string; runningMode?: PoseRunningMode; looks?: boolean }
  | { type: 'frame'; bitmap: ImageBitmap; seq: number; timestampMs: number }
  | { type: 'close' };
export type PoseWorkerResponse =
  | { type: 'ready'; sessionId: string; delegate: PoseDelegate; fallback: string }
  | { type: 'result'; sessionId: string | undefined; seq: number; landmarks: NormalizedLandmark[][]; inferenceMs: number; looks?: (number[] | null)[] }
  | { type: 'error'; sessionId: string | undefined; message: string };

// The project type-checks against the DOM lib; this is the part of the worker scope used here.
interface PoseWorkerScope {
  onmessage: ((event: MessageEvent<PoseWorkerRequest>) => void) | null;
  postMessage(message: PoseWorkerResponse): void;
  close(): void;
}
const scope: PoseWorkerScope = self;

let landmarker: PoseLandmarker | undefined;
let sessionId: string | undefined;
let runningMode: PoseRunningMode = 'VIDEO';
/** A small copy of each frame to sample looks from, when they're wanted. */
let looksCanvas: OffscreenCanvasRenderingContext2D | null = null;
const errorMessage = (error: unknown) => typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string' ? error.message : '';
scope.onmessage = async ({ data }) => {
  try {
    if (data.type === 'initialize') {
      sessionId = data.sessionId;
      runningMode = data.runningMode || 'VIDEO';
      looksCanvas = data.looks ? new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true }) : null;
      if (!['IMAGE', 'VIDEO'].includes(runningMode)) throw Error('Invalid pose running mode');
      if (!await FilesetResolver.isSimdSupported()) throw Error('Pose tracking requires a browser with WebAssembly SIMD support. Update your browser.');
      const files = await FilesetResolver.forVisionTasks(data.wasmUrl, true);
      const response = await fetch(data.modelUrl);
      if (!response.ok) throw Error(`Model download failed (HTTP ${response.status})`);
      const buffer = await response.arrayBuffer();
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)), n => n.toString(16).padStart(2, '0')).join('');
      if (hash !== data.modelHash) throw Error('Model checksum mismatch');
      let delegate: PoseDelegate = 'GPU';
      let fallback = '';
      // Software WebGL can initialize successfully but make Heavy unusably slow.
      // Keep the chosen model and prefer CPU inference on such renderers.
      const probe = new OffscreenCanvas(1, 1).getContext('webgl2');
      if (probe) {
        const debug = probe.getExtension('WEBGL_debug_renderer_info');
        const renderer: unknown = debug ? probe.getParameter(debug.UNMASKED_RENDERER_WEBGL) : '';
        if (typeof renderer === 'string' && /swiftshader|llvmpipe|software/i.test(renderer)) { delegate = 'CPU'; fallback = 'Software GPU detected'; }
        probe.getExtension('WEBGL_lose_context')?.loseContext();
      }
      const create = (delegate: PoseDelegate) => PoseLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetBuffer: new Uint8Array(buffer), delegate },
        canvas: new OffscreenCanvas(1, 1), runningMode, numPoses: data.playerCount,
        minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
        outputSegmentationMasks: false,
      });
      try { landmarker = await create(delegate); }
      catch (error) {
        if (delegate === 'CPU') throw error;
        fallback = errorMessage(error); delegate = 'CPU'; landmarker = await create(delegate);
      }
      scope.postMessage({ type: 'ready', sessionId, delegate, fallback });
    } else if (data.type === 'frame') {
      try {
        if (!landmarker) throw Error('Pose model is not initialized');
        const start = performance.now();
        const result = runningMode === 'IMAGE' ? landmarker.detect(data.bitmap) : landmarker.detectForVideo(data.bitmap, data.timestampMs);
        const inferenceMs = performance.now() - start;
        let looks: (number[] | null)[] | undefined;
        if (looksCanvas && result.landmarks.length) {
          const { canvas } = looksCanvas;
          const height = Math.max(1, Math.round(LOOKS_WIDTH * data.bitmap.height / data.bitmap.width));
          if (canvas.width !== LOOKS_WIDTH || canvas.height !== height) { canvas.width = LOOKS_WIDTH; canvas.height = height; }
          looksCanvas.drawImage(data.bitmap, 0, 0, canvas.width, canvas.height);
          const pixels = looksCanvas.getImageData(0, 0, canvas.width, canvas.height);
          looks = result.landmarks.map(points => describeLooks(pixels, points));
        }
        scope.postMessage({ type: 'result', sessionId, seq: data.seq, landmarks: result.landmarks, inferenceMs, ...(looks ? { looks } : {}) });
      } finally { data.bitmap.close(); }
    } else if (data.type === 'close') { landmarker?.close(); scope.close(); }
  } catch (error) {
    scope.postMessage({ type: 'error', sessionId, message: errorMessage(error) || 'Pose inference failed' });
  }
};
