/*
 * Live poses for the players' characters: a calibration taken from a short window of
 * reliable poses and then held, and display smoothing between the camera's samples.
 * Display only: the scorer gets the raw poses.
 */

import type { FrameSize, Landmark, Pose, TrackCalibration } from '../../../packages/pose/choreography.ts';

const CORE = [11, 12, 23, 24];
const ANKLES = [27, 28];
const CALIBRATION_MS = 1200;   // reliable poses gathered before the calibration locks
const MIN_SAMPLES = 6;
const RESET_AFTER_MS = 3000;   // a player gone this long is calibrated afresh on return
const HOLD_MS = 600;           // an unreliable joint holds its last good place this long
const SMOOTH_MS = 70;          // display smoothing time constant
const MIN_CONFIDENCE = 0.5;

const confident = (j: Landmark) => j.confidence === null || j.confidence >= MIN_CONFIDENCE;
const median = (v: readonly number[]) => [...v].sort((a, b) => a - b)[v.length >> 1];
const mid = (p: readonly Landmark[], a: number, b: number) => ({ x: (p[a].x + p[b].x) / 2, y: (p[a].y + p[b].y) / 2, z: (p[a].z + p[b].z) / 2 });

/** The applier's calibration (packages/character/retarget.ts) from a set of live poses. */
export function calibrateLive(frames: readonly (readonly Landmark[])[], input: FrameSize): TrackCalibration {
  const aspect = input.width / input.height;
  const torso = frames.map((p) => { const h = mid(p, 23, 24), s = mid(p, 11, 12); return Math.hypot((h.x - s.x) * aspect, h.y - s.y); });
  const hips = frames.map((p) => mid(p, 23, 24));
  const torsoLength = Math.max(0.02, median(torso));
  const hipY = median(hips.map((h) => h.y));
  const withFeet = frames.filter((p) => ANKLES.every((i) => confident(p[i])));
  // Feet out of view (a common living-room framing): stand them where legs usually end.
  const floorY = withFeet.length >= frames.length / 2 ? median(withFeet.map((p) => Math.max(p[27].y, p[28].y))) : hipY + torsoLength * 1.9;
  return {
    inputWidth: input.width, inputHeight: input.height, torsoLength,
    baseHip: { x: median(hips.map((h) => h.x)), y: hipY, z: 0 }, floorY, profileVersion: 1,
  };
}

export interface LivePlayer {
  /** The calibration the character is drawn with (null until there is one). */
  readonly calibration: TrackCalibration | null;
  setCalibration(profile: TrackCalibration | null): void;
  push(landmarks: Landmark[] | null | undefined, recordInput: FrameSize, now: number): void;
  frame(now: number, visible: boolean): Pose | null;
}
export interface LivePlayerOptions {
  /** The player whose poses these are (the drawn pose's playerId). */
  playerId?: number;
  /** Calibrate from the first reliable poses (otherwise setCalibration provides it). */
  autoCalibrate?: boolean;
}

/**
 * One player's live character input. push() every pose (or null when the player isn't in
 * the record); each frame, frame(now) gives the smoothed pose to draw (null hides it).
 */
export function createLivePlayer({ playerId = 0, autoCalibrate = true }: LivePlayerOptions = {}): LivePlayer {
  let window: { at: number; landmarks: Landmark[] }[] = [];
  let calibration: TrackCalibration | null = null;
  let input: FrameSize | null = null;
  let lastSeen = -Infinity;
  let target: Landmark[] | null = null;          // latest landmarks, with unreliable joints held
  let shown: Landmark[] | null = null;           // what's drawn
  let lastFrame: number | null = null;
  const held: { x: number; y: number; z: number; at: number }[] = [];            // per joint: last confident place

  return {
    get calibration() { return calibration; },
    setCalibration(profile) { calibration = profile; window = []; shown = null; },
    push(landmarks, recordInput, now) {
      if (!landmarks) return;
      if (input && (recordInput.width !== input.width || recordInput.height !== input.height)) { calibration = null; window = []; }
      if (now - lastSeen > RESET_AFTER_MS) { if (autoCalibrate) calibration = null; window = []; shown = null; held.length = 0; }
      input = recordInput;
      lastSeen = now;
      if (autoCalibrate && !calibration && CORE.every((i) => confident(landmarks[i]))) {
        window.push({ at: now, landmarks });
        window = window.filter((f) => now - f.at <= CALIBRATION_MS * 2);
        if (window.length >= MIN_SAMPLES && now - window[0].at >= CALIBRATION_MS) {
          calibration = calibrateLive(window.map((f) => f.landmarks), recordInput);
          window = [];
        }
      }
      target = landmarks.map((j, i) => {
        if (confident(j)) { held[i] = { x: j.x, y: j.y, z: j.z, at: now }; return j; }
        const h: (typeof held)[number] | undefined = held[i];
        return h && now - h.at <= HOLD_MS ? { ...j, x: h.x, y: h.y, z: h.z } : j;
      });
    },
    /** The pose to draw now, or null when the player is missing or not yet calibrated. */
    frame(now, visible) {
      const dt = lastFrame === null ? 0 : Math.min(now - lastFrame, 100);
      lastFrame = now;
      if (!visible || !target || !calibration) { shown = null; return null; }
      if (!shown) {
        shown = target.map((j) => ({ ...j }));
        return { playerId, landmarks: shown };
      }
      const k = 1 - Math.exp(-dt / SMOOTH_MS);
      for (let i = 0; i < shown.length; i++) {
        const s = shown[i], t = target[i];
        s.x += (t.x - s.x) * k;
        s.y += (t.y - s.y) * k;
        s.z += (t.z - s.z) * k;
        s.confidence = t.confidence;
      }
      return { playerId, landmarks: shown };
    },
  };
}
