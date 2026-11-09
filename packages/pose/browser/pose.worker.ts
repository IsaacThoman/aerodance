import { FilesetResolver, HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { Landmark as WorldLandmark, NormalizedLandmark } from '@mediapipe/tasks-vision';
import type { Point3 } from '../choreography.ts';
import type { HandSide, TrackedHand } from '../webcamRecord.ts';
import { describeLooks, LOOKS_WIDTH } from './appearance.ts';
import { MAX_HAND_PEOPLE, assignSlots, ownHand, personAt, tracksHands, wristsAt } from './hands.ts';
import type { PicturePoint } from './hands.ts';
import { fromTile, mergeTiles, StripHiding } from './tiles.ts';
import type { Tile } from './tiles.ts';

// The message protocol between a page (WebcamPoseSource, Studio video import) and this worker.
export type PoseRunningMode = 'IMAGE' | 'VIDEO';
export type PoseDelegate = 'GPU' | 'CPU';
/**
 * The hand model's file and its SHA-256, checked before use, how many people's hands to look for
 * (1 by default, at most MAX_HAND_PEOPLE) and which of them (both by default).
 */
export interface HandModelRequest { modelUrl: string; modelHash: string; people?: number; sides?: HandSide[]; }
export type PoseWorkerRequest =
  /**
   * playerCount is how many poses to look for; looks asks for each person's looks (appearance.ts)
   * too. With tiles (VIDEO mode on a GPU), each strip of the picture looks for one person instead
   * (tiles.ts), and playerCount is used only if they can't be set up.
   */
  | { type: 'initialize'; sessionId: string; playerCount: number; modelUrl: string; modelHash: string; wasmUrl: string; runningMode?: PoseRunningMode; looks?: boolean; tiles?: Tile[] }
  /** players: how many players were found in the last result, which steers the strips (tiles.ts). */
  | { type: 'frame'; bitmap: ImageBitmap; seq: number; timestampMs: number; players?: number }
  /**
   * The detail (WebcamPoseSource.setDetail), once the worker is ready: world keeps each person's
   * world landmarks with their result, and hands runs the Hand Landmarker on the wrists of the
   * people looked for (up to hands.people of them; VIDEO mode on the whole picture), loading it
   * the first time it's asked for. Until a page sends this, results are as they always were.
   */
  | { type: 'detail'; world: boolean; hands: HandModelRequest | null }
  | { type: 'close' };
export type PoseWorkerResponse =
  | { type: 'ready'; sessionId: string; delegate: PoseDelegate; fallback: string; tiled?: boolean }
  /** world and hands (while the detail asks for them): each person's world landmarks and the hands found at their wrists, in landmarks' order. */
  | { type: 'result'; sessionId: string | undefined; seq: number; landmarks: NormalizedLandmark[][]; inferenceMs: number; looks?: (number[] | null)[];
    world?: Point3[][]; hands?: TrackedHand[][] }
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
/** The detail: whether world landmarks are kept, and the hand model asked for. */
let world = false;
let handModel: HandModelRequest | null = null;
/** A slot: the landmarkers for one person's hands (a landmarker per side asked for), and where they were last seen. */
interface HandSlot { landmarkers: Partial<Record<HandSide, HandLandmarker>>; at: PicturePoint | null; }
/**
 * The hand landmarkers, once loaded, for the people and sides they were asked for: a slot each in
 * VIDEO mode, each landmarker following its hand from frame to frame, when they fit beside the
 * pose model's WebGL context; otherwise one slot shared by everyone in IMAGE mode, looking afresh
 * in each person's cuts (hands.ts).
 */
interface Hands { people: number; sides: HandSide[]; video: boolean; slots: HandSlot[]; }
let hands: Hands | null = null;
/** How many people's hands a request is for, and which. */
const peopleOf = (model: HandModelRequest) => Math.min(MAX_HAND_PEOPLE, Math.max(1, Math.floor(model.people ?? 1)));
const sidesOf = (model: HandModelRequest): HandSide[] => {
  const asked = (['left', 'right'] as const).filter((side) => model.sides?.includes(side));
  return asked.length ? asked : ['left', 'right'];
};
/** The hands loaded are the ones a request asks for. */
const loadedFor = (loaded: Hands, model: HandModelRequest) => loaded.people === peopleOf(model) && loaded.sides.join() === sidesOf(model).join();
let handsLoading = false;
/** Hand landmarkers made so far, so each loads the WASM loader under a URL of its own (see initialize). */
let handsMade = 0;
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

/**
 * The hands at one person's wrists in this frame, by the slot's landmarkers (following them in
 * VIDEO mode, or looking afresh), none nearer another person's wrists (`others`, in pixels) than
 * their own.
 */
async function findHands(bitmap: ImageBitmap, points: readonly NormalizedLandmark[], timestampMs: number, landmarkers: HandSlot['landmarkers'], video: boolean, others: readonly PicturePoint[] = []): Promise<TrackedHand[]> {
  const { width, height } = bitmap;
  const found: FoundHand[] = [];
  for (const side of ['left', 'right'] as const) {
    const landmarker = landmarkers[side];
    if (!landmarker) continue;
    const cut = cutFor(points, side, width, height);
    if (!cut) continue;
    // A cut past the picture's edge is padded, so it stays square.
    const picture = await createImageBitmap(bitmap, Math.round(cut.x), Math.round(cut.y), Math.round(cut.size), Math.round(cut.size), { resizeWidth: CUT_PIXELS, resizeHeight: CUT_PIXELS });
    try {
      const result = video ? landmarker.detectForVideo(picture, timestampMs) : landmarker.detect(picture);
      // The hand nearest the pose's wrist (the other hand may be in the cut too).
      const wrist = points[JOINTS[side].wrist];
      let best = -1, bestD = Infinity;
      result.landmarks.forEach((hand, i) => {
        const d = Math.hypot(cut.x + hand[0].x * cut.size - wrist.x * width, cut.y + hand[0].y * cut.size - wrist.y * height);
        if (d < bestD) { bestD = d; best = i; }
      });
      if (best < 0 || bestD >= cut.size * 0.45) continue;
      // The person beside them's hand, reaching into this cut.
      const at = { x: cut.x + result.landmarks[best][0].x * cut.size, y: cut.y + result.landmarks[best][0].y * cut.size };
      if (!ownHand(at, { x: wrist.x * width, y: wrist.y * height }, others)) continue;
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

/** The hand landmarkers for the people and sides asked for (see Hands), from the hand model (the delegate the pose model got, or the CPU if that fails). */
async function loadHands(model: HandModelRequest): Promise<Hands> {
  if (!files) throw Error('Pose model is not initialized');
  if (runningMode !== 'VIDEO' || tiled) throw Error(`Hand tracking needs at most ${MAX_HAND_PEOPLE} players in the whole picture`);
  const people = peopleOf(model), sides = sidesOf(model), video = tracksHands(people, sides.length);
  const count = (video ? people : 1) * sides.length;
  const buffer = await download(model.modelUrl, model.modelHash);
  // As for the strips, the WASM binary is fetched once for all of them.
  let wasm = '';
  const made: HandLandmarker[] = [];
  try {
    const binary = await fetch(files.wasmBinaryPath);
    if (!binary.ok) throw Error(`WASM download failed (HTTP ${binary.status})`);
    wasm = URL.createObjectURL(new Blob([await binary.arrayBuffer()], { type: 'application/wasm' }));
    const from = { ...files, wasmBinaryPath: wasm };
    const create = (d: PoseDelegate) => HandLandmarker.createFromOptions({ ...from, wasmLoaderPath: `${from.wasmLoaderPath}?hands=${handsMade++}` }, {
      baseOptions: { modelAssetBuffer: new Uint8Array(buffer), delegate: d }, canvas: new OffscreenCanvas(1, 1), runningMode: video ? 'VIDEO' : 'IMAGE', numHands: 1,
      minHandDetectionConfidence: 0.4, minHandPresenceConfidence: 0.4, minTrackingConfidence: 0.4,
    });
    const all = async (d: PoseDelegate) => { for (let i = made.length; i < count; i++) made.push(await create(d)); };
    try { await all(delegate); } catch (error) {
      if (delegate === 'CPU') throw error;
      for (const l of made.splice(0)) l.close();
      await all('CPU');
    }
    const slots = Array.from({ length: count / sides.length }, (_, i): HandSlot => ({
      landmarkers: Object.fromEntries(sides.map((side, j) => [side, made[i * sides.length + j]])), at: null }));
    return { people, sides, video, slots };
  } catch (error) {
    for (const l of made) l.close();
    throw error;
  } finally { if (wasm) URL.revokeObjectURL(wasm); }
}
const closeLandmarkers = ({ slots }: Hands) => { for (const slot of slots) for (const l of Object.values(slot.landmarkers)) l.close(); };
function closeHands() {
  if (hands) closeLandmarkers(hands);
  hands = null;
}

/**
 * The hands of each person found this frame, in their order: following, each person by their
 * slot (assignSlots: where they stood last, whatever order the pose model reports them in);
 * shared, each of as many people as were asked for by the one slot. (The pose model looks for no
 * more people than the players, so that's everyone.)
 */
async function findAllHands(bitmap: ImageBitmap, people: readonly NormalizedLandmark[][], timestampMs: number, running: Hands): Promise<TrackedHand[][]> {
  const { width, height } = bitmap;
  const wrists = people.map((points) => wristsAt(points, width, height));
  const others = (i: number) => wrists.flatMap((w, j) => (j === i ? [] : w));
  const found: TrackedHand[][] = people.map(() => []);
  if (!running.video) {
    for (const [i, points] of people.slice(0, running.people).entries()) found[i] = await findHands(bitmap, points, timestampMs, running.slots[0].landmarkers, false, others(i));
    return found;
  }
  const at = people.map((points) => personAt(points, width, height));
  const order = assignSlots(running.slots.map((slot) => slot.at), at, width * 0.25);
  for (const [i, points] of people.entries()) {
    const slot = running.slots[order[i]];
    if (!slot) continue;
    found[i] = await findHands(bitmap, points, timestampMs, slot.landmarkers, true, others(i));
    if (at[i]) slot.at = at[i];
  }
  return found;
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
      const create = (delegate: PoseDelegate, numPoses = data.playerCount, from = wasmFiles) => PoseLandmarker.createFromOptions(
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
      }
      scope.postMessage({ type: 'ready', sessionId, delegate, fallback, tiled: !!tiled });
    } else if (data.type === 'detail') {
      world = data.world;
      handModel = data.hands;
      if (!handModel) { closeHands(); return; }
      if (hands && loadedFor(hands, handModel)) { scope.postMessage({ type: 'hands', sessionId, state: 'on' }); return; }
      // Asked for other people or hands: the landmarkers are made afresh (in the mode for them).
      closeHands();
      // (A load already under way goes on to this request once it's done.)
      if (handsLoading) return;
      handsLoading = true;
      try {
        // Until they're what's asked for now (it can change while they load), or it's taken back.
        while (handModel && !(hands && loadedFor(hands, handModel))) {
          let loaded: Hands;
          try { loaded = await loadHands(handModel); } catch (error) {
            if (handModel) scope.postMessage({ type: 'hands', sessionId, state: 'unavailable', message: errorMessage(error) || 'Hand tracking could not start' });
            break;
          }
          if (handModel && loadedFor(loaded, handModel)) { closeHands(); hands = loaded; scope.postMessage({ type: 'hands', sessionId, state: 'on' }); }
          else closeLandmarkers(loaded);
        }
      } finally { handsLoading = false; }
    } else if (data.type === 'frame') {
      try {
        if (!landmarker && !tiled) throw Error('Pose model is not initialized');
        const start = performance.now();
        let landmarks: NormalizedLandmark[][];
        let worlds: (WorldLandmark[] | undefined)[];
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
          const result = runningMode === 'IMAGE' ? landmarker!.detect(data.bitmap) : landmarker!.detectForVideo(data.bitmap, data.timestampMs);
          landmarks = result.landmarks;
          worlds = result.worldLandmarks;
        }
        // The hands of the people looked for (a hand model that fails mid-frame stands down; the pose carries on).
        let found: TrackedHand[][] | undefined;
        const running = hands;
        if (running && handModel) {
          try { found = await findAllHands(data.bitmap, landmarks, data.timestampMs, running); }
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
          ...(world ? { world: worlds.map(points => (points ?? []).map(point)) } : {}), ...(found ? { hands: found } : {}) });
      } finally { data.bitmap.close(); }
    } else if (data.type === 'close') { landmarker?.close(); for (const l of tiled?.landmarkers ?? []) l.close(); closeHands(); handModel = null; scope.close(); }
  } catch (error) {
    scope.postMessage({ type: 'error', sessionId, message: errorMessage(error) || 'Pose inference failed' });
  }
};
