import { FilesetResolver, HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { Landmark as WorldLandmark, NormalizedLandmark } from '@mediapipe/tasks-vision';
import type { Point3 } from '../choreography.ts';
import type { HandSide, TrackedHand } from '../webcamRecord.ts';
import { describeLooks, LOOKS_WIDTH } from './appearance.ts';
import { MAX_HAND_PEOPLE, onTheirSides, ownHand, personAt, playerRanks, SLOT_FORGET_MS, slotsFor, tracksHands, wristsAt } from './hands.ts';
import type { PicturePoint } from './hands.ts';
import { fromCrop, fromTile, mergeTiles, outline, StripHiding } from './tiles.ts';
import type { Crop, Tile } from './tiles.ts';

// The message protocol between a page (WebcamPoseSource, Studio video import) and this worker.
export type PoseRunningMode = 'IMAGE' | 'VIDEO';
export type PoseDelegate = 'GPU' | 'CPU';
/**
 * The hand model's file and its SHA-256, checked before use, how many people's hands to look for
 * (1 by default, at most MAX_HAND_PEOPLE) and which of them: a list for each player in their
 * order (webcamRecord.ts detailHands), the last for any after it (both hands by default). Player
 * 1 is the person furthest to the camera's right, as the mirror shows them on the left.
 */
export interface HandModelRequest { modelUrl: string; modelHash: string; people?: number; sides?: HandSide[][]; }
export type PoseWorkerRequest =
  /**
   * playerCount is how many poses to look for; looks asks for each person's looks (appearance.ts)
   * too. With tiles (VIDEO mode on a GPU), each strip of the picture looks for one person instead
   * (tiles.ts), and playerCount is used only if they can't be set up. search adds a second
   * landmarker to the whole picture (VIDEO mode on a GPU) that looks for whoever the first misses;
   * zoom lets one player be looked for in the middle of the picture (see MIDDLE).
   */
  | { type: 'initialize'; sessionId: string; playerCount: number; modelUrl: string; modelHash: string; wasmUrl: string; runningMode?: PoseRunningMode; looks?: boolean; tiles?: Tile[]; search?: boolean; zoom?: boolean }
  /**
   * players: how many players were found in the last result, which steers the strips (tiles.ts);
   * lined: whether the player tracker has numbered them in line-up order yet (by default it has),
   * until when each person's hands are those of the player they stand as (slotsFor in hands.ts);
   * places: where the tracker last saw each player, in its numbering (PlayerTracker.places), which
   * once they're lined up says whose hands are whose (else the worker goes by where it saw them).
   */
  | { type: 'frame'; bitmap: ImageBitmap; seq: number; timestampMs: number; players?: number; lined?: boolean; places?: (PicturePoint | null)[] }
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
 * (MIDDLE) instead; whichever view finds somebody is kept, the middle only while they fit well
 * inside it (anybody bigger is found on the whole picture, and the middle would cut them off).
 * (Seeing a different picture breaks the landmarker's following, so the views alternate only
 * while there's nobody to follow.)
 */
const MIDDLE: Crop = { x: 0.125, y: 0.125, width: 0.75, height: 0.75 }, ZOOM_AFTER_MS = 1000, ZOOM_LOST_MS = 500, ZOOM_MARGIN = 0.05;
/**
 * Somebody the landmarker finds afresh in the enlarged middle counts only standing, their torso
 * within ZOOM_UPRIGHT_DEG of upright: enlarged, an empty room's sofa can look like somebody lying
 * on it. (Unless the player was last seen going down, more than ZOOM_DOWN_DEG from upright, within
 * ZOOM_REFIND_MS and ZOOM_REFIND of the picture: a player can lie on the floor in their dance.)
 */
const ZOOM_UPRIGHT_DEG = 45, ZOOM_DOWN_DEG = 20, ZOOM_REFIND_MS = 3000, ZOOM_REFIND = 0.2;
/**
 * Following somebody small off the middle onto the whole picture, the landmarker carries the
 * middle's place over for a result or two: for ZOOM_CROSS_MS, results more than ZOOM_CROSS from
 * where the middle last saw them aren't reported (the landmarker still follows them).
 */
const ZOOM_CROSS_MS = 100, ZOOM_CROSS = 0.05;
/**
 * While on the middle, one frame in ZOOM_GLANCE_MS shows the whole picture: somebody it finds
 * elsewhere than who the middle follows (a player walking in beside something person-shaped the
 * enlarged middle took for somebody) brings the whole picture back.
 */
const ZOOM_GLANCE_MS = 2000, ZOOM_SAME = 0.1;
let zoom: { view: 'whole' | 'middle' | 'both'; since: number | null; flip: boolean; size: string; glanced: number; at: { x: number; y: number } | null;
  /** Where and when somebody (not too big for the middle) was last found, and whether they were going down. */
  seen: { x: number; y: number; at: number; down: boolean } | null;
  /** Where the middle last saw somebody small it left for the whole picture, until when. */
  crossed: { x: number; y: number; until: number } | null;
  /** Whether the landmarker was following somebody last time, the last time it was shown, and whether it's to look afresh before the next frame. */
  following: boolean; last: number; afresh: boolean;
  /**
   * Looks at the whole picture in a glance (IMAGE mode, so afresh each time): made, off the
   * frames' path, the first time the middle is kept, and used once it's ready.
   */
  glancer: Promise<PoseLandmarker | null> | null; ready: PoseLandmarker | null; make: () => Promise<PoseLandmarker> } | null = null;
/**
 * A blank picture: shown to the landmarker before it changes view while following somebody, so it
 * looks afresh there instead of following a place from the other view (except for somebody small
 * leaving the middle, whom only following can keep: see ZOOM_CROSS_MS).
 */
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
/** The detail: whether world landmarks are kept, and the hand model asked for. */
let world = false;
let handModel: HandModelRequest | null = null;
/** A slot: the landmarkers for one person's hands (a landmarker per side asked for), and where and when (frame timestamp) they were last seen. */
interface HandSlot { landmarkers: Partial<Record<HandSide, HandLandmarker>>; at: PicturePoint | null; seen: number; }
/**
 * The hand landmarkers, once loaded, for the people and hands they were asked for (`sides`, each
 * player's): a slot per player in VIDEO mode, each landmarker following its hand from frame to
 * frame, when they fit beside the pose model's WebGL context; otherwise one slot shared by
 * everyone in IMAGE mode, a landmarker for each side anyone asked for, looking afresh in each
 * person's cuts (hands.ts).
 */
interface Hands { sides: HandSide[][]; video: boolean; slots: HandSlot[]; }
let hands: Hands | null = null;
/** Each player's hands a request is for (as many players as it's for). */
function sidesOf(model: HandModelRequest): HandSide[][] {
  const people = Math.min(MAX_HAND_PEOPLE, Math.max(1, Math.floor(model.people ?? 1)));
  const lists = model.sides?.length ? model.sides : [['left', 'right'] as HandSide[]];
  return Array.from({ length: people }, (_, player) => {
    const asked = (['left', 'right'] as const).filter((side) => (lists[player] ?? lists[lists.length - 1]).includes(side));
    return asked.length ? asked : ['left', 'right'];
  });
}
/** The hands loaded are the ones a request asks for. */
const loadedFor = (loaded: Hands, model: HandModelRequest) => JSON.stringify(loaded.sides) === JSON.stringify(sidesOf(model));
let handsLoading = false;
/** Hand landmarkers made so far, so each loads the WASM loader under a URL of its own (see initialize). */
let handsMade = 0;
/** One result with zoom (see MIDDLE): the view to show this frame, its people in the whole picture (and their world landmarks, metres round the hips whatever the view), and the view next time. */
const centre = (points: NormalizedLandmark[]) => [11, 12, 23, 24].reduce((c, i) => ({ x: c.x + points[i].x / 4, y: c.y + points[i].y / 4 }), { x: 0, y: 0 });
const inMiddle = (p: NormalizedLandmark, margin = 0) => p.x > MIDDLE.x + margin && p.x < MIDDLE.x + MIDDLE.width - margin && p.y > MIDDLE.y + margin && p.y < MIDDLE.y + MIDDLE.height - margin;
/** The whole person inside the middle (where the model places the joints it can't see too), their torso well inside. */
const fits = (points: NormalizedLandmark[]) => points.every(p => inMiddle(p)) && [11, 12, 23, 24].every(i => inMiddle(points[i], ZOOM_MARGIN));
/** Somebody too big for the middle wherever they stood in it: over ZOOM_BIG of its height. */
const ZOOM_BIG = 0.8;
const big = (points: NormalizedLandmark[]) => { const ys = points.map(p => p.y); return Math.max(...ys) - Math.min(...ys) > ZOOM_BIG * MIDDLE.height; };
/** The torso, shoulders over hips, within this many degrees of upright. */
function upright(points: NormalizedLandmark[], aspect: number, deg = ZOOM_UPRIGHT_DEG) {
  const s = { x: (points[11].x + points[12].x) / 2 * aspect, y: (points[11].y + points[12].y) / 2 }, h = { x: (points[23].x + points[24].x) / 2 * aspect, y: (points[23].y + points[24].y) / 2 };
  return Math.atan2(Math.abs(s.x - h.x), h.y - s.y) <= deg * Math.PI / 180;
}
async function zoomed(z: NonNullable<typeof zoom>, bitmap: ImageBitmap, timestampMs: number): Promise<{ landmarks: NormalizedLandmark[][]; worlds: WorldLandmark[][] }> {
  const { width, height } = bitmap;
  if (z.size !== `${width}x${height}`) Object.assign(z, { view: 'whole', since: null, flip: false, size: `${width}x${height}`, glanced: -Infinity, at: null, seen: null, crossed: null, afresh: z.following });
  // A blank picture between the landmarker's last frame and this one, while it follows somebody.
  const lookAfresh = () => {
    if (z.following) {
      if (!blank) { const c = new OffscreenCanvas(64, 48), g = c.getContext('2d')!; g.fillStyle = '#808080'; g.fillRect(0, 0, 64, 48); blank = c.transferToImageBitmap(); }
      landmarker!.detectForVideo(blank, Number.isFinite(z.last) && z.last < timestampMs ? (z.last + timestampMs) / 2 : timestampMs - 0.5);
      z.following = false;
    }
    z.afresh = false;
  };
  // A glance at the whole picture by the other landmarker (once it's ready): somebody there other
  // than who the middle follows brings the whole picture back.
  if (z.view === 'middle' && z.ready && timestampMs - z.glanced >= ZOOM_GLANCE_MS) {
    z.glanced = timestampMs;
    if (z.ready.detect(bitmap).landmarks.some(points => { const c = centre(points); return !z.at || Math.hypot(c.x - z.at.x, c.y - z.at.y) > ZOOM_SAME; })) {
      z.view = 'whole';
      z.afresh = true;
    }
  }
  if (z.afresh) lookAfresh();
  // (Whether the landmarker looks for somebody afresh this time, rather than following them.)
  const fresh = !z.following;
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
  z.last = timestampMs;
  // Somebody found afresh in the enlarged middle counts only standing (see ZOOM_UPRIGHT_DEG), and
  // the landmarker looks afresh next time rather than following them.
  const counts = (points: NormalizedLandmark[]) => {
    if (upright(points, width / height)) return true;
    const c = centre(points), { seen } = z;
    return !!seen?.down && timestampMs - seen.at <= ZOOM_REFIND_MS && Math.hypot(c.x - seen.x, c.y - seen.y) <= ZOOM_REFIND;
  };
  if (middle && fresh && !landmarks.every(counts)) {
    worlds = worlds.filter((_, i) => counts(landmarks[i]));
    landmarks = landmarks.filter(counts);
    z.afresh = true;
  }
  if (landmarks.length) {
    z.since = null;
    // Somebody found: keep the view that found them, the middle only while they fit in it. (Leaving
    // the middle for somebody too big for it, the landmarker looks afresh on the whole picture;
    // somebody small, at its edge, it follows there, where its detector couldn't find them.)
    const view = middle && landmarks.every(fits) ? 'middle' : 'whole';
    if (middle && view === 'whole') {
      if (landmarks.some(big)) z.afresh = true;
      else z.crossed = { ...centre(landmarks[0]), until: timestampMs + ZOOM_CROSS_MS };
    }
    // The glances' landmarker is made the first time the middle is kept.
    if (view === 'middle' && !z.at) {
      z.glanced = timestampMs;
      z.glancer ??= z.make().then(g => (z.ready = g), (error: unknown) => { console.warn('pose zoom glances could not start:', errorMessage(error) || error); return null; });
    }
    z.view = view;
    z.at = view === 'middle' ? centre(landmarks[0]) : null;
  } else {
    z.since ??= timestampMs;
    if (timestampMs - z.since >= (z.view === 'middle' ? ZOOM_LOST_MS : ZOOM_AFTER_MS)) z.view = 'both';
  }
  // Just off the middle, only results where the middle last saw them (see ZOOM_CROSS_MS).
  const { crossed } = z;
  if (crossed && !middle) {
    if (timestampMs > crossed.until) z.crossed = null;
    else {
      const near = (points: NormalizedLandmark[]) => { const c = centre(points); return Math.hypot(c.x - crossed.x, c.y - crossed.y) <= ZOOM_CROSS; };
      worlds = worlds.filter((_, i) => near(landmarks[i]));
      landmarks = landmarks.filter(near);
    }
  }
  // Where somebody reported was, for finding them again (see ZOOM_DOWN_DEG).
  if (landmarks.length) z.seen = landmarks.some(big) ? null : { ...centre(landmarks[0]), at: timestampMs, down: !upright(landmarks[0], width / height, ZOOM_DOWN_DEG) };
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
 * pose's wrists, and the pose mixes them up when the arms cross; with both hands looked for, the
 * Hand Landmarker's own handedness puts each hand found back on its side (onTheirSides).
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
/** The size each cut is looked at. */
const CUT_PIXELS = 256;

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

/**
 * A dark cut (dim light, a TV's glow, a dark sleeve in a dark room: its brightest LEVELS.high
 * share of pixels below LEVELS.dark) is brightened before the Hand Landmarker looks at it: that
 * brightness lifted to white (by at most LEVELS.gain) and the shadows opened up by a gamma of
 * LEVELS.gamma, the same for each channel. A cut that isn't dark is looked at as it is. On
 * trackbench's ping-pong scenes this finds the hand in 0.59 of the dim two-player scene's frames
 * where it found 0.25, and changes nothing in normal light.
 */
const LEVELS = { high: 0.98, dark: 160, gain: 4, gamma: 0.45 } as const;
let levels: OffscreenCanvasRenderingContext2D | null | undefined;
function brightened(picture: ImageBitmap): ImageBitmap | ImageData {
  levels ??= new OffscreenCanvas(CUT_PIXELS, CUT_PIXELS).getContext('2d', { willReadFrequently: true });
  if (!levels) return picture;
  levels.drawImage(picture, 0, 0);
  const image = levels.getImageData(0, 0, CUT_PIXELS, CUT_PIXELS), px = image.data;
  const counts = new Uint32Array(256);
  for (let i = 0; i < px.length; i += 4) counts[(px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8]++;
  let bright = 255;
  for (let v = 0, sum = 0; v < 256; v++) { sum += counts[v]; if (sum >= LEVELS.high * (px.length / 4)) { bright = v; break; } }
  if (bright >= LEVELS.dark) return picture;
  const gain = Math.min(LEVELS.gain, 255 / Math.max(1, bright));
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = 255 * Math.min(1, (v * gain) / 255) ** LEVELS.gamma;
  for (let i = 0; i < px.length; i += 4) { px[i] = lut[px[i]]; px[i + 1] = lut[px[i + 1]]; px[i + 2] = lut[px[i + 2]]; }
  return image;
}

/**
 * The hands at one person's wrists in this frame, by the slot's landmarkers (following them in
 * VIDEO mode, or looking afresh), none nearer another person's wrists (`others`, in pixels) than
 * their own.
 */
async function findHands(bitmap: ImageBitmap, points: readonly NormalizedLandmark[], timestampMs: number, landmarkers: HandSlot['landmarkers'], sides: readonly HandSide[], video: boolean, others: readonly PicturePoint[] = []): Promise<TrackedHand[]> {
  const { width, height } = bitmap;
  const found: { side: HandSide; landmarks: TrackedHand['landmarks']; world: Point3[]; named: HandSide; score: number }[] = [];
  for (const side of sides) {
    const landmarker = landmarkers[side];
    if (!landmarker) continue;
    const cut = cutFor(points, side, width, height);
    if (!cut) continue;
    // A cut past the picture's edge is padded, so it stays square.
    const picture = await createImageBitmap(bitmap, Math.round(cut.x), Math.round(cut.y), Math.round(cut.size), Math.round(cut.size), { resizeWidth: CUT_PIXELS, resizeHeight: CUT_PIXELS });
    try {
      const input = brightened(picture);
      const result = video ? landmarker.detectForVideo(input, timestampMs) : landmarker.detect(input);
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
  const wrists = Object.fromEntries((['left', 'right'] as const).flatMap(side => { const w = points[JOINTS[side].wrist]; return (w.visibility ?? 1) >= SEEN ? [[side, w]] : []; }));
  return onTheirSides(found, sides.length, wrists, width / height).map(({ side, landmarks, world, named, score }) => ({ side, landmarks, world, score: named === side ? score : 1 - score }));
}

/** The hand landmarkers for the people and sides asked for (see Hands), from the hand model (the delegate the pose model got, or the CPU if that fails). */
async function loadHands(model: HandModelRequest): Promise<Hands> {
  if (!files) throw Error('Pose model is not initialized');
  if (runningMode !== 'VIDEO' || tiled) throw Error(`Hand tracking needs at most ${MAX_HAND_PEOPLE} players in the whole picture`);
  const sides = sidesOf(model), video = tracksHands(sides.flat().length);
  // Following: a landmarker for each player's each hand; shared: one for each side anyone asked for.
  const shared = (['left', 'right'] as const).filter((side) => sides.some((s) => s.includes(side)));
  const slotSides = video ? sides : [shared];
  const count = slotSides.flat().length;
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
    let next = 0;
    const slots = slotSides.map((own): HandSlot => ({ landmarkers: Object.fromEntries(own.map((side) => [side, made[next++]])), at: null, seen: -Infinity }));
    return { sides, video, slots };
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
 * The hands of each person found this frame, in their order, each person's being their player's
 * (playerRanks: Player 1 furthest to the camera's right). Following, each person goes to their
 * player's slot (slotsFor: by where they stand until the players are lined up, then by where the
 * player tracker last saw each player, whatever order the pose model reports them in); shared,
 * each looks with the one slot. (The pose model looks for no more people than the players, so that's everyone.)
 */
async function findAllHands(bitmap: ImageBitmap, people: readonly NormalizedLandmark[][], timestampMs: number, running: Hands, lined: boolean, places?: readonly (PicturePoint | null)[]): Promise<TrackedHand[][]> {
  const { width, height } = bitmap;
  const wrists = people.map((points) => wristsAt(points, width, height));
  const others = (i: number) => wrists.flatMap((w, j) => (j === i ? [] : w));
  const at = people.map((points) => personAt(points, width, height));
  const ranks = playerRanks(at);
  const found: TrackedHand[][] = people.map(() => []);
  if (!running.video) {
    for (const [i, points] of people.entries()) {
      const sides = running.sides[ranks[i]];
      if (sides) found[i] = await findHands(bitmap, points, timestampMs, running.slots[0].landmarkers, sides, false, others(i));
    }
    return found;
  }
  // Each slot's player where the tracker last saw them, or (from a page that doesn't say) where this
  // slot's person was last seen here.
  const known = places ? running.slots.map((_, i) => { const p = places[i]; return p ? { x: p.x * width, y: p.y * height } : null; })
    : running.slots.map((slot) => (timestampMs - slot.seen <= SLOT_FORGET_MS ? slot.at : null));
  const order = slotsFor(known, at, width * 0.25, ranks, lined);
  for (const [i, points] of people.entries()) {
    const slot = running.slots[order[i]];
    if (!slot) continue;
    found[i] = await findHands(bitmap, points, timestampMs, slot.landmarkers, running.sides[order[i]], true, others(i));
    if (at[i]) { slot.at = at[i]; slot.seen = timestampMs; }
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
        // (Its glances cost a landmarker, so like the strips and the search it's only where the
        // source allows them, not the iPhone/iPad app. Unlike them it runs on the CPU too: there it's
        // the only way to find somebody small, for one more inference every ZOOM_GLANCE_MS.)
        zoom = data.zoom && data.playerCount === 1 && runningMode === 'VIDEO'
          ? { view: 'whole', since: null, flip: false, size: '', glanced: -Infinity, at: null, seen: null, crossed: null, following: false, last: -Infinity, afresh: false, glancer: null, ready: null,
            make: () => create(delegate, 1, wasmFiles, 'IMAGE') } : null;
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
        // The hands of the people looked for (a hand model that fails mid-frame stands down; the pose carries on).
        let found: TrackedHand[][] | undefined;
        const running = hands;
        if (running && handModel) {
          try { found = await findAllHands(data.bitmap, landmarks, data.timestampMs, running, data.lined ?? true, data.places); }
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
