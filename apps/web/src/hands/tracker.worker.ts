import { FilesetResolver, HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { Landmark, NormalizedLandmark } from '@mediapipe/tasks-vision';

/*
 * The /?hands demo's tracker: one player's pose (with its 3D world landmarks, in metres from the
 * hips) and each hand, found by the Hand Landmarker in a square cut round the pose's wrist (a
 * whole picture's hands are too small for its palm detector). Landmarks are unmirrored.
 *
 * The cuts follow the pose's wrists, and the pose mixes them up when the arms cross; the Hand
 * Landmarker's own handedness puts each hand found back on its side.
 */

export type HandSide = 'left' | 'right';
export interface TrackedHand {
  side: HandSide;
  /** 21 points in the whole picture (0-1). */
  landmarks: NormalizedLandmark[];
  /** 21 points in metres, round the hand's centre. */
  world: Landmark[];
  /** The side the Hand Landmarker took it for, and how sure it was. */
  handedness: { side: HandSide; score: number };
}
export interface TrackerResult {
  seq: number;
  /** The picture's size in pixels. */
  size: { width: number; height: number };
  pose: { landmarks: NormalizedLandmark[]; world: Landmark[] } | null;
  hands: TrackedHand[];
  /** The cuts the hands were looked for in (0-1, square in pixels), for the preview. */
  cuts: { side: HandSide; x: number; y: number; w: number; h: number }[];
  inferenceMs: number;
  /** The pose's and the hands' share of it. */
  timing: { poseMs: number; handsMs: number };
}
export type TrackerRequest =
  | { type: 'initialize'; wasmUrl: string; poseUrl: string; handUrl: string }
  | { type: 'frame'; bitmap: ImageBitmap; seq: number; timestampMs: number }
  | { type: 'close' };
export type TrackerResponse =
  | { type: 'ready'; delegate: 'GPU' | 'CPU' }
  | ({ type: 'result' } & TrackerResult)
  | { type: 'error'; message: string };

interface Scope {
  onmessage: ((event: MessageEvent<TrackerRequest>) => void) | null;
  postMessage(message: TrackerResponse): void;
  close(): void;
}
const scope: Scope = self;

// MediaPipe pose-33: shoulder, wrist, index and pinky for each of the player's sides.
const JOINTS = { left: { shoulder: 11, wrist: 15, index: 19, pinky: 17 }, right: { shoulder: 12, wrist: 16, index: 20, pinky: 18 } } as const;
const SEEN = 0.3;
/**
 * The Hand Landmarker's names for the hands. Its documentation says it assumes a mirrored (selfie)
 * picture, but measured on unmirrored webcam footage its "Right" is the hand at the pose's right
 * wrist (nine times in ten), so the names are taken as they are.
 */
const NAMED: Record<string, HandSide> = { Left: 'left', Right: 'right' };
/** Sure enough of a hand's side to move it to the other cut's. */
const SURE = 0.8;

/** Each hand on the side its handedness says, when the cuts' sides (the pose's) disagree. */
function sorted(found: TrackedHand[]): TrackedHand[] {
  const [a, b] = found;
  // Both cuts found the same hand (the wrists crossed or met): keep it once, on its own side.
  if (a && b) {
    const palm = Math.hypot(a.landmarks[0].x - a.landmarks[9].x, a.landmarks[0].y - a.landmarks[9].y);
    if (Math.hypot(a.landmarks[0].x - b.landmarks[0].x, a.landmarks[0].y - b.landmarks[0].y) < palm * 0.5) {
      const keep = [a, b].sort((x, y) => y.handedness.score - x.handedness.score)[0];
      return [{ ...keep, side: keep.handedness.side }];
    }
    // Both on the wrong side, surely: the pose swapped the wrists.
    const wrong = (h: TrackedHand) => h.handedness.side !== h.side && h.handedness.score >= SURE;
    if (wrong(a) && wrong(b)) return [{ ...a, side: b.side }, { ...b, side: a.side }];
    return found;
  }
  // One hand, surely the other side's.
  if (a && a.handedness.side !== a.side && a.handedness.score >= SURE) return [{ ...a, side: a.handedness.side }];
  return found;
}

let pose: PoseLandmarker | undefined;
/** One per side, following its hand from frame to frame in its cut (VIDEO mode skips the palm search while it holds on). */
let hands: Record<HandSide, HandLandmarker> | undefined;
let delegate: 'GPU' | 'CPU' = 'GPU';

async function load(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw Error(`Model download failed (HTTP ${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

/** The square cut (in pixels) the side's hand should be in, from the pose, or null. */
function cutFor(points: NormalizedLandmark[], side: HandSide, width: number, height: number) {
  const j = JOINTS[side];
  const wrist = points[j.wrist], index = points[j.index], pinky = points[j.pinky];
  const l = points[JOINTS.left.shoulder], r = points[JOINTS.right.shoulder];
  if ((wrist.visibility ?? 1) < SEEN) return null;
  const shoulders = Math.hypot((l.x - r.x) * width, (l.y - r.y) * height);
  // Centred a little past the wrist, towards the fingers; a hand is about half the shoulders' width.
  const fx = ((index.x + pinky.x) / 2 - wrist.x) * width, fy = ((index.y + pinky.y) / 2 - wrist.y) * height;
  const cx = wrist.x * width + fx * 0.6, cy = wrist.y * height + fy * 0.6;
  const size = Math.max(96, shoulders * 1.1, Math.hypot(fx, fy) * 4);
  return { x: cx - size / 2, y: cy - size / 2, size };
}

scope.onmessage = async ({ data }) => {
  try {
    if (data.type === 'initialize') {
      const files = await FilesetResolver.forVisionTasks(data.wasmUrl, true);
      const [poseModel, handModel] = await Promise.all([load(data.poseUrl), load(data.handUrl)]);
      const make = async (d: 'GPU' | 'CPU') => {
        // MediaPipe forgets its WASM loader once it has made a landmarker: the second needs it again under another URL.
        pose = await PoseLandmarker.createFromOptions(files, {
          baseOptions: { modelAssetBuffer: poseModel, delegate: d }, canvas: new OffscreenCanvas(1, 1), runningMode: 'VIDEO', numPoses: 1,
          minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
        });
        const hand = (name: string) => HandLandmarker.createFromOptions({ ...files, wasmLoaderPath: `${files.wasmLoaderPath}?${name}` }, {
          baseOptions: { modelAssetBuffer: handModel, delegate: d }, canvas: new OffscreenCanvas(1, 1), runningMode: 'VIDEO', numHands: 1,
          minHandDetectionConfidence: 0.4, minHandPresenceConfidence: 0.4, minTrackingConfidence: 0.4,
        });
        hands = { left: await hand('left'), right: await hand('right') };
      };
      try { await make('GPU'); } catch { delegate = 'CPU'; await make('CPU'); }
      scope.postMessage({ type: 'ready', delegate });
    } else if (data.type === 'frame') {
      const { bitmap } = data;
      try {
        if (!pose || !hands) throw Error('The tracker is not ready');
        const start = performance.now();
        const body = pose.detectForVideo(bitmap, data.timestampMs);
        const landmarks = body.landmarks[0], world = body.worldLandmarks[0];
        const poseMs = performance.now() - start;
        const result: TrackerResult = { seq: data.seq, size: { width: bitmap.width, height: bitmap.height }, pose: landmarks && world ? { landmarks, world } : null, hands: [], cuts: [], inferenceMs: 0, timing: { poseMs, handsMs: 0 } };
        if (landmarks) {
          const { width, height } = bitmap;
          for (const side of ['left', 'right'] as const) {
            const cut = cutFor(landmarks, side, width, height);
            if (!cut) continue;
            result.cuts.push({ side, x: cut.x / width, y: cut.y / height, w: cut.size / width, h: cut.size / height });
            // A cut past the picture's edge is padded, so it stays square.
            const picture = await createImageBitmap(bitmap, Math.round(cut.x), Math.round(cut.y), Math.round(cut.size), Math.round(cut.size), { resizeWidth: 256, resizeHeight: 256 });
            try {
              const found = hands[side].detectForVideo(picture, data.timestampMs);
              // The hand nearest the pose's wrist (the other hand may be in the cut too).
              const wrist = landmarks[JOINTS[side].wrist];
              let best = -1, bestD = Infinity;
              found.landmarks.forEach((points, i) => {
                const x = (cut.x + points[0].x * cut.size) / width, y = (cut.y + points[0].y * cut.size) / height;
                const d = Math.hypot((x - wrist.x) * width, (y - wrist.y) * height);
                if (d < bestD) { bestD = d; best = i; }
              });
              const named = found.handedness[best]?.[0];
              if (best >= 0 && bestD < cut.size * 0.45) result.hands.push({
                side,
                landmarks: found.landmarks[best].map((p) => ({ ...p, x: (cut.x + p.x * cut.size) / width, y: (cut.y + p.y * cut.size) / height })),
                world: found.worldLandmarks[best],
                handedness: { side: NAMED[named?.categoryName ?? ''] ?? side, score: named?.score ?? 0 },
              });
            } finally { picture.close(); }
          }
        }
        result.hands = sorted(result.hands);
        result.inferenceMs = performance.now() - start;
        result.timing.handsMs = result.inferenceMs - poseMs;
        scope.postMessage({ type: 'result', ...result });
      } finally { bitmap.close(); }
    } else if (data.type === 'close') {
      pose?.close(); hands?.left.close(); hands?.right.close(); scope.close();
    }
  } catch (error) {
    scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
