import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
import { describeLooks, LOOKS_WIDTH } from './appearance.ts';
import { fromTile, mergeTiles, outline, StripHiding } from './tiles.ts';
import type { Tile } from './tiles.ts';

// The message protocol between a page (WebcamPoseSource, Studio video import) and this worker.
export type PoseRunningMode = 'IMAGE' | 'VIDEO';
export type PoseDelegate = 'GPU' | 'CPU';
export type PoseWorkerRequest =
  /**
   * playerCount is how many poses to look for; looks asks for each person's looks (appearance.ts)
   * too. With tiles (VIDEO mode on a GPU), each strip of the picture looks for one person instead
   * (tiles.ts), and playerCount is used only if they can't be set up. search adds a second
   * landmarker to the whole picture (VIDEO mode on a GPU) that looks for whoever the first misses.
   */
  | { type: 'initialize'; sessionId: string; playerCount: number; modelUrl: string; modelHash: string; wasmUrl: string; runningMode?: PoseRunningMode; looks?: boolean; tiles?: Tile[]; search?: boolean }
  /** players: how many players were found in the last result, which steers the strips (tiles.ts). */
  | { type: 'frame'; bitmap: ImageBitmap; seq: number; timestampMs: number; players?: number }
  | { type: 'close' };
export type PoseWorkerResponse =
  | { type: 'ready'; sessionId: string; delegate: PoseDelegate; fallback: string; tiled?: boolean }
  /** searched: the search landmarker looked this time (for measuring its cost). */
  | { type: 'result'; sessionId: string | undefined; seq: number; landmarks: NormalizedLandmark[][]; inferenceMs: number; looks?: (number[] | null)[]; searched?: boolean }
  | { type: 'error'; sessionId: string | undefined; message: string };

// The project type-checks against the DOM lib; this is the part of the worker scope used here.
interface PoseWorkerScope {
  onmessage: ((event: MessageEvent<PoseWorkerRequest>) => void) | null;
  postMessage(message: PoseWorkerResponse): void;
  close(): void;
}
const scope: PoseWorkerScope = self;

let landmarker: PoseLandmarker | undefined;
/**
 * On the whole picture: a second landmarker that, while the first finds fewer people than it was
 * asked for (but somebody), is shown the picture with those it found hidden (their head, torso and
 * legs), so it looks for whoever else is there. MediaPipe's person detector often finds only one
 * of two people standing close together, and then never the other.
 */
let search: { landmarker: PoseLandmarker; people: number } | null = null;
/** The search landmarker's results count as a strip of their own, for merging copies of somebody. */
const WHOLE: Tile = { x: 0, width: 1 }, SEARCHED: Tile = { x: 0, width: 1 };
/** With tiles: one landmarker per strip of the picture, the strips, who each is shown hidden (tiles.ts), and the picture's size. */
let tiled: { landmarkers: PoseLandmarker[]; tiles: Tile[]; hiding: StripHiding; size: string } | null = null;
/** Where a strip is drawn with people hidden. */
let hiding: OffscreenCanvasRenderingContext2D | null = null;
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
      // Software WebGL can initialize successfully but make inference unusably slow.
      // Prefer CPU inference on such renderers.
      const probe = new OffscreenCanvas(1, 1).getContext('webgl2');
      if (probe) {
        const debug = probe.getExtension('WEBGL_debug_renderer_info');
        const renderer: unknown = debug ? probe.getParameter(debug.UNMASKED_RENDERER_WEBGL) : '';
        if (typeof renderer === 'string' && /swiftshader|llvmpipe|software/i.test(renderer)) { delegate = 'CPU'; fallback = 'Software GPU detected'; }
        probe.getExtension('WEBGL_lose_context')?.loseContext();
      }
      // Each landmarker after the first loads the WASM loader again under its own URL: MediaPipe
      // forgets the loader once it has made a landmarker, and a module worker's import() of the
      // same URL doesn't run it again.
      let made = 0;
      const create = (delegate: PoseDelegate, numPoses = data.playerCount, from = files) => PoseLandmarker.createFromOptions(
        made++ ? { ...from, wasmLoaderPath: `${from.wasmLoaderPath}?landmarker=${made - 1}` } : from, {
        baseOptions: { modelAssetBuffer: new Uint8Array(buffer), delegate },
        canvas: new OffscreenCanvas(1, 1), runningMode, numPoses,
        minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
        outputSegmentationMasks: false,
      });
      // Strips need the GPU (on a CPU, each costs a whole frame's search) and VIDEO mode's following.
      tiled = null;
      if (data.tiles?.length && delegate === 'GPU' && runningMode === 'VIDEO') {
        const landmarkers: PoseLandmarker[] = [];
        // The WASM binary (13 MB) is fetched once for all of them.
        let wasm = '';
        try {
          const binary = await fetch(files.wasmBinaryPath);
          if (!binary.ok) throw Error(`WASM download failed (HTTP ${binary.status})`);
          wasm = URL.createObjectURL(new Blob([await binary.arrayBuffer()], { type: 'application/wasm' }));
          for (let i = 0; i < data.tiles.length; i++) landmarkers.push(await create(delegate, 1, { ...files, wasmBinaryPath: wasm }));
          tiled = { landmarkers, tiles: data.tiles, hiding: new StripHiding(data.tiles), size: '' };
        } catch (error) {
          console.warn('pose strips could not start, using the whole picture:', errorMessage(error) || error);
          for (const l of landmarkers) l.close();
        } finally { if (wasm) URL.revokeObjectURL(wasm); }
      }
      if (!tiled) {
        try { landmarker = await create(delegate); }
        catch (error) {
          if (delegate === 'CPU') throw error;
          fallback = errorMessage(error); delegate = 'CPU'; landmarker = await create(delegate);
        }
        // (Like the strips, it needs the GPU and VIDEO mode's following; without them it's left out.)
        search = null;
        if (data.search && data.playerCount > 1 && delegate === 'GPU' && runningMode === 'VIDEO') {
          try { search = { landmarker: await create(delegate, 1), people: data.playerCount }; }
          catch (error) { console.warn('pose search could not start:', errorMessage(error) || error); }
        }
      }
      scope.postMessage({ type: 'ready', sessionId, delegate, fallback, tiled: !!tiled });
    } else if (data.type === 'frame') {
      try {
        if (!landmarker && !tiled) throw Error('Pose model is not initialized');
        const start = performance.now();
        let landmarks: NormalizedLandmark[][];
        let searched = false;
        if (tiled) {
          const { width, height } = data.bitmap;
          // A picture of another size (a phone turned round) starts afresh.
          if (tiled.size !== `${width}x${height}`) { tiled.size = `${width}x${height}`; tiled.hiding = new StripHiding(tiled.tiles); }
          const found: { points: NormalizedLandmark[]; tile: Tile }[] = [];
          for (const [i, tile] of tiled.tiles.entries()) {
            const sx = Math.round(tile.x * width), sw = Math.max(1, Math.round(tile.width * width));
            const hide = tiled.hiding.hide[i];
            let strip: ImageBitmap;
            if (hide.length) {
              hiding ??= new OffscreenCanvas(1, 1).getContext('2d')!;
              const { canvas } = hiding;
              if (canvas.width !== sw || canvas.height !== height) { canvas.width = sw; canvas.height = height; }
              hiding.drawImage(data.bitmap, sx, 0, sw, height, 0, 0, sw, height);
              hiding.fillStyle = '#808080';
              for (const b of hide) hiding.fillRect(b.x0 * width - sx, b.y0 * height, (b.x1 - b.x0) * width, (b.y1 - b.y0) * height);
              strip = canvas.transferToImageBitmap();
            } else strip = await createImageBitmap(data.bitmap, sx, 0, sw, height);
            // The strip as cut, so landmarks map back exactly.
            const cut = { x: sx / width, width: sw / width };
            try { for (const points of tiled.landmarkers[i].detectForVideo(strip, data.timestampMs).landmarks) found.push({ points: fromTile(points, cut), tile }); }
            finally { strip.close(); }
          }
          landmarks = mergeTiles(found, width / height);
          tiled.hiding.next(found, landmarks, width / height, data.players);
        } else {
          landmarks = (runningMode === 'IMAGE' ? landmarker!.detect(data.bitmap) : landmarker!.detectForVideo(data.bitmap, data.timestampMs)).landmarks;
          if (search && landmarks.length && landmarks.length < search.people) {
            const { width, height } = data.bitmap;
            hiding ??= new OffscreenCanvas(1, 1).getContext('2d')!;
            const { canvas } = hiding;
            if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
            hiding.drawImage(data.bitmap, 0, 0);
            hiding.fillStyle = '#808080';
            for (const points of landmarks) { const b = outline(points); hiding.fillRect(b.x0 * width, b.y0 * height, (b.x1 - b.x0) * width, (b.y1 - b.y0) * height); }
            const picture = canvas.transferToImageBitmap();
            searched = true;
            try {
              const more = search.landmarker.detectForVideo(picture, data.timestampMs).landmarks;
              if (more.length) landmarks = mergeTiles([...landmarks.map(points => ({ points, tile: WHOLE })), ...more.map(points => ({ points, tile: SEARCHED }))], width / height);
            } finally { picture.close(); }
          }
        }
        const inferenceMs = performance.now() - start;
        let looks: (number[] | null)[] | undefined;
        if (looksCanvas && landmarks.length) {
          const { canvas } = looksCanvas;
          const height = Math.max(1, Math.round(LOOKS_WIDTH * data.bitmap.height / data.bitmap.width));
          if (canvas.width !== LOOKS_WIDTH || canvas.height !== height) { canvas.width = LOOKS_WIDTH; canvas.height = height; }
          looksCanvas.drawImage(data.bitmap, 0, 0, canvas.width, canvas.height);
          const pixels = looksCanvas.getImageData(0, 0, canvas.width, canvas.height);
          looks = landmarks.map(points => describeLooks(pixels, points));
        }
        scope.postMessage({ type: 'result', sessionId, seq: data.seq, landmarks, inferenceMs, ...(looks ? { looks } : {}), ...(searched ? { searched } : {}) });
      } finally { data.bitmap.close(); }
    } else if (data.type === 'close') { landmarker?.close(); search?.landmarker.close(); for (const l of tiled?.landmarkers ?? []) l.close(); scope.close(); }
  } catch (error) {
    scope.postMessage({ type: 'error', sessionId, message: errorMessage(error) || 'Pose inference failed' });
  }
};
