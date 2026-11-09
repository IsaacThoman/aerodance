import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
import { describeLooks, LOOKS_WIDTH } from './appearance.ts';
import { fromCrop, fromTile, mergeTiles, outline, StripHiding } from './tiles.ts';
import type { Crop, Tile } from './tiles.ts';

// The message protocol between a page (WebcamPoseSource, Studio video import) and this worker.
export type PoseRunningMode = 'IMAGE' | 'VIDEO';
export type PoseDelegate = 'GPU' | 'CPU';
export type PoseWorkerRequest =
  /**
   * playerCount is how many poses to look for; looks asks for each person's looks (appearance.ts)
   * too. With tiles (VIDEO mode on a GPU), each strip of the picture looks for one person instead
   * (tiles.ts), and playerCount is used only if they can't be set up. search adds a second
   * landmarker to the whole picture (VIDEO mode on a GPU) that looks for whoever the first misses;
   * zoom lets one player be looked for in the middle of the picture (see MIDDLE).
   */
  | { type: 'initialize'; sessionId: string; playerCount: number; modelUrl: string; modelHash: string; wasmUrl: string; runningMode?: PoseRunningMode; looks?: boolean; tiles?: Tile[]; search?: boolean; zoom?: boolean }
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
/**
 * One player on the whole picture: MediaPipe's person detector misses somebody small in the
 * picture (a 120° webcam, or far away), and finds them in the middle of it, enlarged. So while
 * nobody has been found for ZOOM_AFTER_MS, every other frame shows the landmarker the middle
 * (MIDDLE) instead; whichever view finds somebody is kept, the middle only while they stand well
 * inside it. (Seeing a different picture breaks the landmarker's following, so the views
 * alternate only while there's nobody to follow.)
 */
const MIDDLE: Crop = { x: 0.125, y: 0.125, width: 0.75, height: 0.75 }, ZOOM_AFTER_MS = 1000, ZOOM_LOST_MS = 500, ZOOM_MARGIN = 0.05;
/**
 * While on the middle, one frame in ZOOM_GLANCE_MS shows the whole picture: somebody it finds
 * elsewhere than who the middle follows (a player walking in beside something person-shaped the
 * enlarged middle took for somebody) brings the whole picture back.
 */
const ZOOM_GLANCE_MS = 2000, ZOOM_SAME = 0.1;
let zoom: { view: 'whole' | 'middle' | 'both'; since: number | null; flip: boolean; size: string; glanced: number; at: { x: number; y: number } | null;
  /** Whether the landmarker was following somebody last time. */
  following: boolean;
  /** Looks at the whole picture in a glance (IMAGE mode, so afresh each time); made the first time the middle is kept. */
  glancer: Promise<PoseLandmarker | null> | null; make: () => Promise<PoseLandmarker> } | null = null;
/** A blank picture: shown to the landmarker before it goes back to the whole picture, so it looks afresh there instead of following a place from the middle. */
let blank: ImageBitmap | null = null;
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
/** One result with zoom (see MIDDLE): the view to show this frame, its people in the whole picture, and the view next time. */
const centre = (points: NormalizedLandmark[]) => [11, 12, 23, 24].reduce((c, i) => ({ x: c.x + points[i].x / 4, y: c.y + points[i].y / 4 }), { x: 0, y: 0 });
async function zoomed(z: NonNullable<typeof zoom>, bitmap: ImageBitmap, timestampMs: number): Promise<NormalizedLandmark[][]> {
  const { width, height } = bitmap;
  if (z.size !== `${width}x${height}`) Object.assign(z, { view: 'whole', since: null, flip: false, size: `${width}x${height}`, glanced: -Infinity, at: null, following: false });
  // A glance at the whole picture by the other landmarker: somebody there other than who the
  // middle follows brings the whole picture back.
  if (z.view === 'middle' && timestampMs - z.glanced >= ZOOM_GLANCE_MS) {
    z.glanced = timestampMs;
    const glancer = await (z.glancer ??= z.make().catch(() => null));
    const seen = glancer ? glancer.detect(bitmap).landmarks : [];
    if (seen.some(points => { const c = centre(points); return !z.at || Math.hypot(c.x - z.at.x, c.y - z.at.y) > ZOOM_SAME; })) {
      z.view = 'whole';
      if (z.following) {
        if (!blank) { const c = new OffscreenCanvas(64, 48), g = c.getContext('2d')!; g.fillStyle = '#808080'; g.fillRect(0, 0, 64, 48); blank = c.transferToImageBitmap(); }
        landmarker!.detectForVideo(blank, timestampMs - 0.5);
      }
    }
  }
  const middle = z.view === 'middle' || (z.view === 'both' && (z.flip = !z.flip));
  let landmarks: NormalizedLandmark[][];
  if (middle) {
    const sx = Math.round(MIDDLE.x * width), sy = Math.round(MIDDLE.y * height), sw = Math.round(MIDDLE.width * width), sh = Math.round(MIDDLE.height * height);
    const picture = await createImageBitmap(bitmap, sx, sy, sw, sh);
    try { landmarks = landmarker!.detectForVideo(picture, timestampMs).landmarks.map(points => fromCrop(points, { x: sx / width, y: sy / height, width: sw / width, height: sh / height })); }
    finally { picture.close(); }
  } else landmarks = landmarker!.detectForVideo(bitmap, timestampMs).landmarks;
  z.following = landmarks.length > 0;
  const torsoInside = (points: NormalizedLandmark[]) => [11, 12, 23, 24].every(i => points[i].x > MIDDLE.x + ZOOM_MARGIN && points[i].x < MIDDLE.x + MIDDLE.width - ZOOM_MARGIN
    && points[i].y > MIDDLE.y + ZOOM_MARGIN && points[i].y < MIDDLE.y + MIDDLE.height - ZOOM_MARGIN);
  if (landmarks.length) {
    z.since = null;
    // Somebody found: keep the view that found them, the middle only while they're well inside it.
    z.view = middle && landmarks.every(torsoInside) ? 'middle' : 'whole';
    if (z.view === 'middle' && !z.at) z.glanced = timestampMs;
    z.at = z.view === 'middle' ? centre(landmarks[0]) : null;
  } else {
    z.since ??= timestampMs;
    if (timestampMs - z.since >= (z.view === 'middle' ? ZOOM_LOST_MS : ZOOM_AFTER_MS)) z.view = 'both';
  }
  return landmarks;
}

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
      const create = (delegate: PoseDelegate, numPoses = data.playerCount, from = files, mode: PoseRunningMode = runningMode) => PoseLandmarker.createFromOptions(
        made++ ? { ...from, wasmLoaderPath: `${from.wasmLoaderPath}?landmarker=${made - 1}` } : from, {
        baseOptions: { modelAssetBuffer: new Uint8Array(buffer), delegate },
        canvas: new OffscreenCanvas(1, 1), runningMode: mode, numPoses,
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
        // (Its glances cost a landmarker, so like the search it's only where strips would be allowed.)
        zoom = data.zoom && data.playerCount === 1 && runningMode === 'VIDEO'
          ? { view: 'whole', since: null, flip: false, size: '', glanced: -Infinity, at: null, following: false, glancer: null, make: () => create(delegate, 1, files, 'IMAGE') } : null;
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
          if (zoom) landmarks = await zoomed(zoom, data.bitmap, data.timestampMs);
          else landmarks = (runningMode === 'IMAGE' ? landmarker!.detect(data.bitmap) : landmarker!.detectForVideo(data.bitmap, data.timestampMs)).landmarks;
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
    } else if (data.type === 'close') { landmarker?.close(); search?.landmarker.close(); void zoom?.glancer?.then(g => g?.close()); for (const l of tiled?.landmarkers ?? []) l.close(); scope.close(); }
  } catch (error) {
    scope.postMessage({ type: 'error', sessionId, message: errorMessage(error) || 'Pose inference failed' });
  }
};
