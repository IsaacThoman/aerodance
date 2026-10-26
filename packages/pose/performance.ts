// Authored character motion, independent of the human pose used by the scorer.
// Coordinates are model units before the coach's mirror: x right, y up, z toward the camera.
import { evaluate } from './curves.ts';
import type { CurveKey, Ease, Interp } from './curves.ts';

export type Triple = [number, number, number];
export interface CharacterPose {
  /** The body bone's pivot; standing is [0, 1.1, 0]. */
  body: Triple;
  /** XYZ degrees. Positive pitch bows toward the camera. */
  bodyRotation: Triple;
  bodyScale: Triple;
  /** The head's centre and its absolute rotation, independent of the body. */
  head: Triple;
  headRotation: Triple;
  headScale: number;
  /** Centres of the floating hands and feet. Anatomical left is x positive when facing front. */
  leftHand: Triple;
  rightHand: Triple;
  handScale: number;
  leftFoot: Triple;
  rightFoot: Triple;
  footScale: number;
}
export interface PerformanceKey { t: number; pose: CharacterPose; interp?: Interp; ease?: Ease; }
export interface PerformanceClip { id: string; startMs: number; endMs: number; keys: PerformanceKey[]; }
export interface Performance {
  schema: 'aerodance.performance'; schemaVersion: 1;
  tracks: { clips: PerformanceClip[] }[];
}
export const PERFORMANCE_VECTORS = ['body', 'bodyRotation', 'bodyScale', 'head', 'headRotation', 'leftHand', 'rightHand', 'leftFoot', 'rightFoot'] as const;
export const PERFORMANCE_SCALES = ['headScale', 'handScale', 'footScale'] as const;
export function neutralCharacterPose(): CharacterPose {
  return { body: [0, 1.1, 0], bodyRotation: [0, 0, 0], bodyScale: [1, 1, 1],
    head: [0, 2.7, 0], headRotation: [0, 0, 0], headScale: 1,
    leftHand: [.9, 1.5, .3], rightHand: [-.9, 1.5, .3], handScale: 1,
    leftFoot: [.4, .3, 0], rightFoot: [-.4, .3, 0], footScale: 1 };
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
function require(v: unknown, message: string): asserts v { if (!v) throw Error(`Invalid performance: ${message}`); }
export function assertPerformanceClips(clips: unknown): asserts clips is PerformanceClip[] {
  require(Array.isArray(clips) && clips.length <= 1000, 'clips must be an array of at most 1000 clips');
  let end = -Infinity;
  const ids = new Set<string>();
  for (const clip of clips) {
    require(object(clip) && typeof clip.id === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(clip.id) && !ids.has(clip.id), 'clip needs a unique id');
    ids.add(clip.id);
    require(finite(clip.startMs) && finite(clip.endMs) && clip.endMs > clip.startMs && clip.startMs >= end, 'clip ranges must be ordered and not overlap');
    end = clip.endMs;
    require(Array.isArray(clip.keys) && clip.keys.length >= 2 && clip.keys.length <= 50000, 'a clip needs 2–50000 keys');
    let last = -Infinity;
    for (const key of clip.keys) {
      require(object(key) && finite(key.t) && key.t > last && key.t >= clip.startMs && key.t <= clip.endMs, 'keys must be ordered within their clip');
      last = key.t;
      require(key.interp === undefined || ['smooth', 'linear', 'hold'].includes(String(key.interp)), 'unknown interpolation');
      require(key.ease === undefined || ['auto', 'stop', 'sharp'].includes(String(key.ease)), 'unknown ease');
      const p = key.pose;
      require(object(p), 'key needs a pose');
      for (const name of PERFORMANCE_VECTORS) {
        const v = p[name];
        require(Array.isArray(v) && v.length === 3 && v.every(n => finite(n) && Math.abs(n) <= (name.endsWith('Rotation') ? 3600 : 100)), `invalid ${name}`);
      }
      require((p.bodyScale as number[]).every(n => n >= .1 && n <= 4), 'bodyScale must be between .1 and 4');
      for (const name of PERFORMANCE_SCALES) require(finite(p[name]) && p[name] >= .1 && p[name] <= 4, `${name} must be between .1 and 4`);
      require(Object.keys(p).every(k => [...PERFORMANCE_VECTORS, ...PERFORMANCE_SCALES].includes(k as never)), 'unknown pose control');
    }
    require(clip.keys[0].t === clip.startMs && clip.keys.at(-1).t === clip.endMs, 'keys must cover both clip boundaries');
  }
}
export function validatePerformance(value: unknown, dancers: number): Performance {
  require(object(value) && value.schema === 'aerodance.performance' && value.schemaVersion === 1 && Array.isArray(value.tracks) && value.tracks.length === dancers, 'schema or dancer count');
  for (const track of value.tracks) { require(object(track), 'invalid track'); assertPerformanceClips(track.clips); }
  return value as unknown as Performance;
}
/** Build once after an edit; seeking and playback use the same curves. Outside a clip, return null. */
export function createPerformanceSampler(clips: readonly PerformanceClip[]) {
  const compiled = clips.map(clip => ({ clip, curves: clip.keys.map(k => ({ t: k.t, interp: k.interp, ease: k.ease,
    v: [...PERFORMANCE_VECTORS.flatMap(c => k.pose[c]), ...PERFORMANCE_SCALES.map(c => k.pose[c])] } satisfies CurveKey)) }));
  return (t: number): CharacterPose | null => {
    const found = compiled.findLast(({ clip }) => t >= clip.startMs && t <= clip.endMs);
    if (!found) return null;
    const v = evaluate(found.curves, t), pose = {} as CharacterPose;
    let i = 0;
    for (const c of PERFORMANCE_VECTORS) { pose[c] = v.slice(i, i + 3) as Triple; i += 3; }
    for (const c of PERFORMANCE_SCALES) pose[c] = v[i++];
    return pose;
  };
}
