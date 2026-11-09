import { FilesetResolver, HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { Landmark as WorldLandmark, NormalizedLandmark } from '@mediapipe/tasks-vision';
import type { Point3 } from '../choreography.ts';
import type { HandSide, TrackedHand } from '../webcamRecord.ts';
import { describeLooks, LOOKS_WIDTH } from './appearance.ts';
import { fromCrop, fromTile, mergeTiles, outline, StripHiding } from './tiles.ts';
import type { Crop, Tile } from './tiles.ts';

// The message protocol between a page (WebcamPoseSource, Studio video import) and this worker.
export type PoseRunningMode = 'IMAGE' | 'VIDEO';
export type PoseDelegate = 'GPU' | 'CPU';
/** The hand model's file and its SHA-256, checked before use. */
export interface HandModelRequest { modelUrl: string; modelHash: string; }
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
  /**
   * The 'hands' detail (WebcamPoseSource.setDetail), once the worker is ready: world keeps each
   * person's world landmarks with their result, and hands runs the Hand Landmarker on the wrists
   * of the one person looked for (VIDEO mode on the whole picture), loading it the first time
   * it's asked for. Until a page sends this, results are as they always were.
   */
  | { type: 'detail'; world: boolean; hands: HandModelRequest | null }
  | { type: 'close' };
export type PoseWorkerResponse =
  | { type: 'ready'; sessionId: string; delegate: PoseDelegate; fallback: string; tiled?: boolean }
  /**
   * world and hands (while the detail asks for them): each person's world landmarks and the hands found at their wrists, in landmarks' order;
   * searched: the search landmarker looked this time (for measuring its cost).
   */
  | { type: 'result'; sessionId: string | undefined; seq: number; landmarks: NormalizedLandmark[][]; inferenceMs: number; looks?: (number[] | null)[];
    world?: Point3[][]; hands?: TrackedHand[][]; searched?: boolean }
  /** The hand model asked for is running, or isn't to be had (message says why); pose tracking carries on either way. */
  | { type: 'hands'; sessionId: string | undefined; state: 'on' | 'unavailable'; message?: string }
  | { type: 'error'; sessionId: string | undefined; message: string };

// The project type-checks against the DOM lib; this is the part of the worker scope used here.
interface PoseWorkerScope {
  onmessage: ((event: MessageEvent<PoseWorkerRequest>) => void) | null;
  postMessage(message: PoseWorkerResponse): void;
  close(): void;
}
const scope: PoseWorkerScope = self;
type Fileset = Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;

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
/** The WASM files and the delegate the pose model got, for the hand model later. */
let files: Fileset | undefined;
let delegate: PoseDelegate = 'GPU';
/** The 'hands' detail: whether world landmarks are kept, and the hand model asked for. */
let world = false;
let handModel: HandModelRequest | null = null;
/** One Hand Landmarker per side, each following its hand from frame to frame in its cut, once loaded. */
let hands: Record<HandSide, HandLandmarker> | null = null;
let handsLoading = false;
/** Hand landmarkers made so far, so each loads the WASM loader under a URL of its own (see initialize). */
let handsMade = 0;
/** One result with zoom (see MIDDLE): the view to show this frame, its people in the whole picture (and their world landmarks, metres round the hips whatever the view), and the view next time. */
const centre = (points: NormalizedLandmark[]) => [11, 12, 23, 24].reduce((c, i) => ({ x: c.x + points[i].x / 4, y: c.y + points[i].y / 4 }), { x: 0, y: 0 });
async function zoomed(z: NonNullable<typeof zoom>, bitmap: ImageBitmap, timestampMs: number): Promise<{ landmarks: NormalizedLandmark[][]; worlds: WorldLandmark[][] }> {
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
  let landmarks: NormalizedLandmark[][], worlds: WorldLandmark[][];
  if (middle) {
    const sx = Math.round(MIDDLE.x * width), sy = Math.round(MIDDLE.y * height), sw = Math.round(MIDDLE.width * width), sh = Math.round(MIDDLE.height * height);
    const picture = await createImageBitmap(bitmap, sx, sy, sw, sh);
    try {
      const result = landmarker!.detectForVideo(picture, timestampMs);
      landmarks = result.landmarks.map(points => fromCrop(points, { x: sx / width, y: sy / height, width: sw / width, height: sh / height }));
      worlds = result.worldLandmarks;
    } finally { picture.close(); }
  } else ({ landmarks, worldLandmarks: worlds } = landmarker!.detectForVideo(bitmap, timestampMs));
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
  return { landmarks, worlds };
}

const errorMessage = (error: unknown) => typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string' ? error.message : '';
const point = ({ x, y, z }: Point3): Point3 => ({ x, y, z });

async function download(url: string, hash: string) {
  const response = await fetch(url);
  if (!response.ok) throw Error(`Model download failed (HTTP ${response.status})`);
  const buffer = await response.arrayBuffer();
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)), n => n.toString(16).padStart(2, '0')).join('');
  if (digest !== hash) throw Error('Model checksum mismatch');
  return buffer;
}

/*
 * The hands, ported from the /?hands demo's tracker: the Hand Landmarker looks in a square cut
 * round each of the pose's wrists (a whole picture's hands are too small for its palm detector),
 * one landmarker per side so each follows its hand from frame to frame. The cuts follow the
 * pose's wrists, and the pose mixes them up when the arms cross; the Hand Landmarker's own
 * handedness puts each hand found back on its side.
 */
// MediaPipe pose-33: shoulder, wrist, index and pinky for each of the player's sides.
const JOINTS = { left: { shoulder: 11, wrist: 15, index: 19, pinky: 17 }, right: { shoulder: 12, wrist: 16, index: 20, pinky: 18 } } as const;
/** A wrist this sure is looked round for its hand. */
const SEEN = 0.3;
/**
 * The Hand Landmarker's names for the hands. Its documentation says it assumes a mirrored
 * (selfie) picture, but measured on unmirrored webcam footage its "Right" is the hand at the
 * pose's right wrist nine times in ten, so the names are taken as they are.
 */
const NAMED: Partial<Record<string, HandSide>> = { Left: 'left', Right: 'right' };
/** Sure enough of a hand's side to move it to the other cut's. */
const SURE = 0.8;
/** The size each cut is looked at. */
const CUT_PIXELS = 256;
interface FoundHand { side: HandSide; landmarks: TrackedHand['landmarks']; world: Point3[]; named: HandSide; score: number; }

/** The square cut (in pixels) the side's hand should be in, from the pose, or null when its wrist isn't seen. */
function cutFor(points: readonly NormalizedLandmark[], side: HandSide, width: number, height: number) {
  const j = JOINTS[side];
  const wrist = points[j.wrist], index = points[j.index], pinky = points[j.pinky];
  const l = points[JOINTS.left.shoulder], r = points[JOINTS.right.shoulder];
  if ((wrist.visibility ?? 1) < SEEN) return null;
  const shoulders = Math.hypot((l.x - r.x) * width, (l.y - r.y) * height);
  // Centred a little past the wrist, towards the fingers; a hand is about half the shoulders' width.
  const fx = ((index.x + pinky.x) / 2 - wrist.x) * width, fy = ((index.y + pinky.y) / 2 - wrist.y) * height;
  const size = Math.max(96, shoulders * 1.1, Math.hypot(fx, fy) * 4);
  return { x: wrist.x * width + fx * 0.6 - size / 2, y: wrist.y * height + fy * 0.6 - size / 2, size };
}

/** Each hand on the side its handedness says, when the cuts' sides (the pose's) disagree. */
function sorted(found: FoundHand[]): FoundHand[] {
  const [a, b] = found;
  if (a && b) {
    // Both cuts found the same hand (the wrists crossed or met): keep it once, on its own side.
    const palm = Math.hypot(a.landmarks[0].x - a.landmarks[9].x, a.landmarks[0].y - a.landmarks[9].y);
    if (Math.hypot(a.landmarks[0].x - b.landmarks[0].x, a.landmarks[0].y - b.landmarks[0].y) < palm * 0.5) {
      const keep = [a, b].sort((x, y) => y.score - x.score)[0];
      return [{ ...keep, side: keep.named }];
    }
    // Both on the wrong side, surely: the pose swapped the wrists.
    const wrong = (h: FoundHand) => h.named !== h.side && h.score >= SURE;
    if (wrong(a) && wrong(b)) return [{ ...a, side: b.side }, { ...b, side: a.side }];
    return found;
  }
  // One hand, surely the other side's.
  if (a && a.named !== a.side && a.score >= SURE) return [{ ...a, side: a.named }];
  return found;
}

/** The hands at one person's wrists in this frame. */
async function findHands(bitmap: ImageBitmap, points: readonly NormalizedLandmark[], timestampMs: number, landmarkers: Record<HandSide, HandLandmarker>): Promise<TrackedHand[]> {
  const { width, height } = bitmap;
  const found: FoundHand[] = [];
  for (const side of ['left', 'right'] as const) {
    const cut = cutFor(points, side, width, height);
    if (!cut) continue;
    // A cut past the picture's edge is padded, so it stays square.
    const picture = await createImageBitmap(bitmap, Math.round(cut.x), Math.round(cut.y), Math.round(cut.size), Math.round(cut.size), { resizeWidth: CUT_PIXELS, resizeHeight: CUT_PIXELS });
    try {
      const result = landmarkers[side].detectForVideo(picture, timestampMs);
      // The hand nearest the pose's wrist (the other hand may be in the cut too).
      const wrist = points[JOINTS[side].wrist];
      let best = -1, bestD = Infinity;
      result.landmarks.forEach((hand, i) => {
        const d = Math.hypot(cut.x + hand[0].x * cut.size - wrist.x * width, cut.y + hand[0].y * cut.size - wrist.y * height);
        if (d < bestD) { bestD = d; best = i; }
      });
      if (best < 0 || bestD >= cut.size * 0.45) continue;
      const named = result.handedness[best]?.[0];
      found.push({
        side, named: NAMED[named?.categoryName ?? ''] ?? side, score: named?.score ?? 0,
        landmarks: result.landmarks[best].map(p => ({ x: (cut.x + p.x * cut.size) / width, y: (cut.y + p.y * cut.size) / height, z: (p.z * cut.size) / width, confidence: null })),
        world: result.worldLandmarks[best].map(point),
      });
    } finally { picture.close(); }
  }
  // score says how sure it is of the side the hand ends up on.
  return sorted(found).map(({ side, landmarks, world, named, score }) => ({ side, landmarks, world, score: named === side ? score : 1 - score }));
}

/** The two hand landmarkers, from the hand model (the delegate the pose model got, or the CPU if that fails). */
async function loadHands(model: HandModelRequest): Promise<Record<HandSide, HandLandmarker>> {
  if (!files) throw Error('Pose model is not initialized');
  if (runningMode !== 'VIDEO' || tiled) throw Error('Hand tracking needs one player in the whole picture');
  const buffer = await download(model.modelUrl, model.modelHash);
  // As for the strips, the WASM binary is fetched once for both.
  let wasm = '';
  const made: HandLandmarker[] = [];
  try {
    const binary = await fetch(files.wasmBinaryPath);
    if (!binary.ok) throw Error(`WASM download failed (HTTP ${binary.status})`);
    wasm = URL.createObjectURL(new Blob([await binary.arrayBuffer()], { type: 'application/wasm' }));
    const from = { ...files, wasmBinaryPath: wasm };
    const create = (d: PoseDelegate) => HandLandmarker.createFromOptions({ ...from, wasmLoaderPath: `${from.wasmLoaderPath}?hands=${handsMade++}` }, {
      baseOptions: { modelAssetBuffer: new Uint8Array(buffer), delegate: d }, canvas: new OffscreenCanvas(1, 1), runningMode: 'VIDEO', numHands: 1,
      minHandDetectionConfidence: 0.4, minHandPresenceConfidence: 0.4, minTrackingConfidence: 0.4,
    });
    const both = async (d: PoseDelegate) => { for (let i = made.length; i < 2; i++) made.push(await create(d)); };
    try { await both(delegate); } catch (error) {
      if (delegate === 'CPU') throw error;
      for (const l of made.splice(0)) l.close();
      await both('CPU');
    }
    return { left: made[0], right: made[1] };
  } catch (error) {
    for (const l of made) l.close();
    throw error;
  } finally { if (wasm) URL.revokeObjectURL(wasm); }
}
function closeHands() {
  hands?.left.close(); hands?.right.close();
  hands = null;
}

scope.onmessage = async ({ data }) => {
  try {
    if (data.type === 'initialize') {
      sessionId = data.sessionId;
      runningMode = data.runningMode || 'VIDEO';
      looksCanvas = data.looks ? new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true }) : null;
      if (!['IMAGE', 'VIDEO'].includes(runningMode)) throw Error('Invalid pose running mode');
      if (!await FilesetResolver.isSimdSupported()) throw Error('Pose tracking requires a browser with WebAssembly SIMD support. Update your browser.');
      files = await FilesetResolver.forVisionTasks(data.wasmUrl, true);
      const buffer = await download(data.modelUrl, data.modelHash);
      delegate = 'GPU';
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
      const wasmFiles = files;
      const create = (delegate: PoseDelegate, numPoses = data.playerCount, from = wasmFiles, mode: PoseRunningMode = runningMode) => PoseLandmarker.createFromOptions(
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
          const binary = await fetch(wasmFiles.wasmBinaryPath);
          if (!binary.ok) throw Error(`WASM download failed (HTTP ${binary.status})`);
          wasm = URL.createObjectURL(new Blob([await binary.arrayBuffer()], { type: 'application/wasm' }));
          for (let i = 0; i < data.tiles.length; i++) landmarkers.push(await create(delegate, 1, { ...wasmFiles, wasmBinaryPath: wasm }));
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
          ? { view: 'whole', since: null, flip: false, size: '', glanced: -Infinity, at: null, following: false, glancer: null, make: () => create(delegate, 1, wasmFiles, 'IMAGE') } : null;
        // (Like the strips, it needs the GPU and VIDEO mode's following; without them it's left out.)
        search = null;
        if (data.search && data.playerCount > 1 && delegate === 'GPU' && runningMode === 'VIDEO') {
          try { search = { landmarker: await create(delegate, 1), people: data.playerCount }; }
          catch (error) { console.warn('pose search could not start:', errorMessage(error) || error); }
        }
      }
      scope.postMessage({ type: 'ready', sessionId, delegate, fallback, tiled: !!tiled });
    } else if (data.type === 'detail') {
      world = data.world;
      handModel = data.hands;
      if (!handModel) { closeHands(); return; }
      if (hands) { scope.postMessage({ type: 'hands', sessionId, state: 'on' }); return; }
      // (A load already under way says how it went once it's done.)
      if (handsLoading) return;
      handsLoading = true;
      try {
        const loaded = await loadHands(handModel);
        // Unless they were turned off meanwhile.
        if (handModel) { hands = loaded; scope.postMessage({ type: 'hands', sessionId, state: 'on' }); }
        else { loaded.left.close(); loaded.right.close(); }
      } catch (error) {
        if (handModel) scope.postMessage({ type: 'hands', sessionId, state: 'unavailable', message: errorMessage(error) || 'Hand tracking could not start' });
      } finally { handsLoading = false; }
    } else if (data.type === 'frame') {
      try {
        if (!landmarker && !tiled) throw Error('Pose model is not initialized');
        const start = performance.now();
        let landmarks: NormalizedLandmark[][];
        let worlds: (WorldLandmark[] | undefined)[];
        let searched = false;
        if (tiled) {
          const { width, height } = data.bitmap;
          // A picture of another size (a phone turned round) starts afresh.
          if (tiled.size !== `${width}x${height}`) { tiled.size = `${width}x${height}`; tiled.hiding = new StripHiding(tiled.tiles); }
          const found: { points: NormalizedLandmark[]; tile: Tile; world: WorldLandmark[] | undefined }[] = [];
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
            // The strip as cut, so landmarks map back exactly. (World landmarks are metres round
            // the hips, whatever the picture they were found in.)
            const cut = { x: sx / width, width: sw / width };
            try {
              const result = tiled.landmarkers[i].detectForVideo(strip, data.timestampMs);
              result.landmarks.forEach((points, k) => found.push({ points: fromTile(points, cut), tile, world: result.worldLandmarks[k] }));
            } finally { strip.close(); }
          }
          landmarks = mergeTiles(found, width / height);
          worlds = world ? landmarks.map(points => found.find(f => f.points === points)?.world) : [];
          tiled.hiding.next(found, landmarks, width / height, data.players);
        } else {
          const result = zoom ? await zoomed(zoom, data.bitmap, data.timestampMs)
            : runningMode === 'IMAGE' ? landmarker!.detect(data.bitmap) : landmarker!.detectForVideo(data.bitmap, data.timestampMs);
          landmarks = result.landmarks;
          worlds = 'worlds' in result ? result.worlds : result.worldLandmarks;
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
              const more = search.landmarker.detectForVideo(picture, data.timestampMs);
              if (more.landmarks.length) {
                const parts: { points: NormalizedLandmark[]; tile: Tile; world: WorldLandmark[] | undefined }[] = [
                  ...landmarks.map((points, k) => ({ points, tile: WHOLE, world: worlds[k] })),
                  ...more.landmarks.map((points, k) => ({ points, tile: SEARCHED, world: more.worldLandmarks[k] }))];
                landmarks = mergeTiles(parts, width / height);
                worlds = landmarks.map(points => parts.find(f => f.points === points)?.world);
              }
            } finally { picture.close(); }
          }
        }
        // The hands of the one person looked for (a hand model that fails mid-frame stands down; the pose carries on).
        let found: TrackedHand[][] | undefined;
        const running = hands;
        if (running && handModel) {
          try { found = landmarks.length === 1 ? [await findHands(data.bitmap, landmarks[0], data.timestampMs, running)] : landmarks.map(() => []); }
          catch (error) {
            found = undefined;
            // (Unless they were turned off while it looked: closed under it.)
            if (hands === running && handModel) {
              closeHands();
              scope.postMessage({ type: 'hands', sessionId, state: 'unavailable', message: errorMessage(error) || 'Hand tracking failed' });
            }
          }
          // Turned off while it looked: this frame goes without.
          if (hands !== running) found = undefined;
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
        scope.postMessage({ type: 'result', sessionId, seq: data.seq, landmarks, inferenceMs, ...(looks ? { looks } : {}),
          ...(world ? { world: worlds.map(points => (points ?? []).map(point)) } : {}), ...(found ? { hands: found } : {}), ...(searched ? { searched } : {}) });
      } finally { data.bitmap.close(); }
    } else if (data.type === 'close') {
      landmarker?.close(); search?.landmarker.close(); void zoom?.glancer?.then(g => g?.close()); for (const l of tiled?.landmarkers ?? []) l.close();
      closeHands(); handModel = null; scope.close();
    }
  } catch (error) {
    scope.postMessage({ type: 'error', sessionId, message: errorMessage(error) || 'Pose inference failed' });
  }
};
