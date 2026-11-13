// Bakes a dance into the game's choreography: sampled MediaPipe poses on the song clock, as
// Studio exports and the game plays and scores (packages/pose/song.ts, docs/pose-binary-format.md).
//
// Every dancer is evaluated on a 60 Hz grid plus every key, contact and exclusion boundary over
// the playable range. The game interpolates linearly between stored frames and treats frames
// more than maxInterpolationGapMs apart as a gap, so a frame is dropped only when straight-line
// interpolation between its kept neighbours stays within `tolerance` for every joint and the
// neighbours are at most maxGapMs apart.
import { calibratePoses } from '../character/calibration.ts';
import { songChoreographyFromTimeline } from '../pose/song.ts';
import type { SongChoreography, SongTimeline, SongTrack } from '../pose/song.ts';
import type { PoseMarker } from '../pose/binary.ts';
import type { Landmark, LandmarkOrigin, Pose, PoseQuality, TrackCalibration } from '../pose/choreography.ts';
import { createEvaluator } from './evaluate.ts';
import type { TakeLookup } from './evaluate.ts';
import { expandControls, isPointControl, roundTime } from './format.ts';
import type { Dance, Dancer } from './format.ts';
import { LANDMARKS_OF } from './rig.ts';

export const DANCE_COMPILER_VERSION = '2.0.0';
export interface CompileOptions {
  /** Largest error straight-line playback may add, in frame units (default 0.0015, a pixel at 640 wide). */
  tolerance?: number;
  /** Most time between stored frames (default 150; the game bridges up to 200). */
  maxGapMs?: number;
  /** The evaluation grid (default 60 Hz). */
  stepMs?: number;
  songId?: string;
  /** Only this range of the song (default: the playable range); for previews. */
  range?: [number, number];
  /** Decoded takes by id; a dance with take clips can't compile without them. */
  takes?: TakeLookup;
}
export interface CompiledDance {
  timeline: SongTimeline;
  markers: PoseMarker[];
  provenance: Record<string, unknown>;
  stats: { candidates: number; frames: number };
}

const median = (v: number[]) => [...v].sort((a, b) => a - b)[v.length >> 1];
/** The calibration the game retargets a dancer with: given, or measured from its compiled poses. */
export function dancerCalibration(dance: Dance, dancer: Dancer, poses: readonly Pose[]): TrackCalibration {
  const input = { width: dance.frame.width, height: dance.frame.height };
  if (dancer.calibration) {
    const c = dancer.calibration;
    return { inputWidth: input.width, inputHeight: input.height, torsoLength: c.torsoLength, baseHip: { x: c.baseHip[0], y: c.baseHip[1], z: c.baseHip[2] }, floorY: c.floorY, profileVersion: 1 };
  }
  // Torso length and floor as calibratePoses measures them, about the dancer's typical position
  // (not the first frame's), so a dancer who travels stays centred on their spot on stage.
  const calibration = calibratePoses(poses, input);
  if (poses.length) {
    const hips = poses.map(p => p.landmarks).map(l => [(l[23].x + l[24].x) / 2, (l[23].y + l[24].y) / 2, (l[23].z + l[24].z) / 2]);
    calibration.baseHip = { x: median(hips.map(h => h[0])), y: median(hips.map(h => h[1])), z: median(hips.map(h => h[2])) };
  }
  return calibration;
}

/**
 * Per-joint eligibility at a dancer-clock time. `captured` is the motion's own verdict (a take's
 * unsure joints are false); an approval over the time lets those be scored after all, and joints
 * of excluded controls never are.
 */
function eligibility(dancer: Dancer, t: number, captured: readonly boolean[]): boolean[] {
  const out = [...captured];
  if (out.includes(false)) for (const a of dancer.approvals) {
    if (t < a.startMs || t >= a.endMs) continue;
    if (!a.controls) out.fill(true);
    else for (const c of expandControls(a.controls)) if (isPointControl(c)) for (const j of LANDMARKS_OF[c]) out[j] = true;
  }
  for (const x of dancer.exclusions) {
    if (!x.controls || t < x.startMs || t >= x.endMs) continue;
    for (const c of expandControls(x.controls)) if (isPointControl(c)) for (const j of LANDMARKS_OF[c]) out[j] = false;
  }
  return out;
}

export function compileDance(dance: Dance, { tolerance = 0.0015, maxGapMs = 150, stepMs = 1000 / 60, songId = '', range, takes }: CompileOptions = {}): CompiledDance {
  const [start, end] = range ?? [dance.song.playableStartMs, dance.song.playableEndMs];
  if (!(end > start)) throw Error('The playable range is empty');
  const times = new Set<number>([start, end]);
  for (let t = start; t < end; t += stepMs) times.add(roundTime(t));
  for (const d of dance.dancers) {
    const add = (t: number) => { const s = roundTime(t + d.timeOffsetMs); if (s > start && s < end) times.add(s); };
    for (const layer of d.layers) for (const keys of Object.values(layer.channels)) for (const k of keys) add(k.t);
    for (const c of d.contacts) for (const t of [c.startMs - c.blendMs, c.startMs, c.endMs, c.endMs + c.blendMs]) add(t);
    for (const x of d.exclusions) for (const t of [x.startMs, x.endMs]) add(t);
    for (const a of d.approvals) for (const t of [a.startMs, a.endMs]) add(t);
    for (const c of d.clips) {
      for (const t of [c.startMs, c.startMs + c.fadeInMs, c.endMs - c.fadeOutMs, c.endMs]) add(t);
      // A take plays straight lines between its own frames: sampling on them lets the frames
      // between be dropped.
      const take = c.kind === 'take' ? takes?.(c.take) : null;
      if (take && c.kind === 'take') for (const takeMs of take.times) {
        const t = c.startMs + (takeMs - c.offsetMs) / c.rate;
        if (t > c.startMs && t < c.endMs) add(t);
      }
    }
  }
  const grid = [...times].sort((a, b) => a - b);
  const evaluators = dance.dancers.map(d => createEvaluator(dance, d, { takes }));
  // Frames that must be kept: endpoints and the eligibility boundaries of partial exclusions.
  const forced = new Set<number>([start, end]);
  for (const d of dance.dancers) for (const x of [...d.exclusions, ...d.approvals]) if (x.controls) for (const t of [x.startMs, x.endMs]) forced.add(roundTime(t + d.timeOffsetMs));
  const frames = grid.map(t => ({
    t,
    poses: evaluators.map((e, i): Pose => ({ playerId: i, landmarks: e.landmarks(t) })),
    eligible: dance.dancers.map((d, i) => eligibility(d, t - d.timeOffsetMs, evaluators[i].eligible(t))),
    captured: evaluators.map(e => e.playing(t)?.clip.kind === 'take'),
  }));
  const missing = [...new Set(evaluators.flatMap(e => [...e.missingTakes]))];
  if (missing.length) throw Error(`Take${missing.length > 1 ? 's' : ''} ${missing.join(', ')} ${missing.length > 1 ? "aren't" : "isn't"} loaded, so the clips that play ${missing.length > 1 ? 'them' : 'it'} can't be compiled`);
  // Greedy: extend each span from the last kept frame while every frame inside it is reproduced.
  const reproduces = (a: number, b: number) => {
    const fa = frames[a], fb = frames[b], span = fb.t - fa.t;
    if (span > maxGapMs) return false;
    for (let i = a + 1; i < b; i++) {
      const f = frames[i], u = (f.t - fa.t) / span;
      for (let p = 0; p < f.poses.length; p++) {
        if (f.eligible[p].some((e, j) => e !== (fa.eligible[p][j] && fb.eligible[p][j]))) return false;
        const la = fa.poses[p].landmarks, lb = fb.poses[p].landmarks, lf = f.poses[p].landmarks;
        for (let j = 0; j < 33; j++) {
          if (Math.abs(la[j].x + (lb[j].x - la[j].x) * u - lf[j].x) > tolerance || Math.abs(la[j].y + (lb[j].y - la[j].y) * u - lf[j].y) > tolerance ||
            Math.abs(la[j].z + (lb[j].z - la[j].z) * u - lf[j].z) > tolerance * 4) return false;
        }
      }
    }
    return true;
  };
  const kept = [0];
  for (let i = 1; i < frames.length; i++) {
    const last = kept[kept.length - 1];
    if (i + 1 < frames.length && !forced.has(frames[i].t) && reproduces(last, i + 1)) continue;
    kept.push(i);
  }
  const samples = kept.map(i => frames[i]).map(f => ({
    songTimeMs: f.t,
    poses: f.poses,
    quality: f.poses.map((p, i): PoseQuality => ({ playerId: p.playerId,
      landmarkOrigins: Array<LandmarkOrigin>(33).fill(f.captured[i] ? 'measured' : 'edited'), scoreEligible: f.eligible[i], reviewed: true })),
  }));
  const tracks: SongTrack[] = dance.dancers.map((d, i) => ({
    playerId: i, label: d.label,
    calibration: dancerCalibration(dance, d, frames.map(f => f.poses[i])),
    unscorableIntervals: d.exclusions.filter(x => !x.controls).map(x => ({
      startMs: Math.max(start, x.startMs + d.timeOffsetMs), endMs: Math.min(end, x.endMs + d.timeOffsetMs), reason: x.reason,
    })).filter(x => x.endMs > x.startMs),
  }));
  const markers: PoseMarker[] = [
    ...dance.markers.map(m => ({ timeMs: m.timeMs, kind: m.kind, label: m.label })),
    ...dance.phrases.map(p => ({ timeMs: p.startMs, kind: 'phrase' as const, label: p.label })),
  ].filter(m => m.timeMs >= start && m.timeMs <= end).sort((a, b) => a.timeMs - b.timeMs);
  const provenance = {
    compiler: 'aerodance-dance', compilerVersion: DANCE_COMPILER_VERSION, danceRevision: dance.revision,
    sources: { video: dance.sources.video?.sha256 ?? null, audio: dance.sources.audio?.sha256 ?? null, tracking: dance.sources.tracking.map(t => t.sha256),
      takes: dance.sources.takes.map(t => t.sha256) },
  };
  const timeline: SongTimeline = {
    schema: 'aerodance.choreography', schemaVersion: 1, songId,
    durationMs: dance.song.durationMs, playableStartMs: start, playableEndMs: end,
    coordinates: { kind: 'mediapipe-image', landmarkCount: 33, ordering: 'mediapipe-pose-33', xAxis: 'right', yAxis: 'down',
      zAxis: 'away-from-camera', mirrored: false, depthUnit: 'relative-image-width' },
    sampling: { targetRateHz: 30, maxInterpolationGapMs: 200, confidenceThreshold: 0.5 },
    tracks, samples,
  };
  return { timeline, markers, provenance, stats: { candidates: frames.length, frames: samples.length } };
}
/** The binary choreography (.adpose) a compiled dance publishes. */
export function choreographyOf(compiled: CompiledDance, songId = compiled.timeline.songId): SongChoreography {
  return songChoreographyFromTimeline({ ...compiled.timeline, songId }, { markers: compiled.markers, provenance: compiled.provenance });
}
/** A dancer's landmarks at a song time, as the game will play them (straight from the curves). */
export function poseAt(dance: Dance, dancerIndex: number, songMs: number, takes?: TakeLookup): Landmark[] {
  return createEvaluator(dance, dance.dancers[dancerIndex], { takes }).landmarks(songMs);
}
/**
 * Each dancer's calibration from poses every stepMs, close to what export measures from every
 * frame; for previews that can't wait for a full compile.
 */
export function previewCalibrations(dance: Dance, stepMs = 250, takes?: TakeLookup): TrackCalibration[] {
  const { playableStartMs: a, playableEndMs: b } = dance.song;
  const step = Math.max(stepMs, (b - a) / 600);
  return dance.dancers.map((d, i) => {
    if (d.calibration) return dancerCalibration(dance, d, []);
    const e = createEvaluator(dance, d, { takes }), poses: Pose[] = [];
    for (let t = a; t <= b; t += step) poses.push({ playerId: i, landmarks: e.landmarks(t) });
    return dancerCalibration(dance, d, poses);
  });
}
