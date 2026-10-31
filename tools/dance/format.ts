// aerodance.dance v1: the editable animation project behind a song's choreography.
//
// A dance keeps the decisions an animator makes (keys, curves, holds, planted feet, phrases,
// timing, scoring exclusions) and the sources they were made against (video, audio, tracked
// reference poses). compile.ts bakes it into the game's sampled .adpose choreography, which
// can't be turned back into keys. docs/dance-format.md documents every field.
//
// Coordinates are the game's: MediaPipe image space of `frame` (the source video), x right and
// y down from 0 to 1 across the frame, z away from the camera in frame-width units with 0 at
// the hips. Lengths in `body` are in frame-height units, so they measure the same along x and y
// (x * width / height). Every time is in milliseconds. A dancer's keys, contacts and exclusions
// are on its own clock: song time minus its timeOffsetMs.
import { isStageId, replaceRemovedStage } from '../../packages/stages/catalog.ts';
import type { StageId } from '../../packages/stages/catalog.ts';
import { assertPerformanceClips } from '../../packages/pose/performance.ts';
import type { PerformanceClip } from '../../packages/pose/performance.ts';

export const DANCE_SCHEMA = 'aerodance.dance';
export const DANCE_VERSION = 1;
export const MAX_DANCERS = 4;

/** The body points a dancer is animated with; every other landmark is derived from them (rig.ts). */
export const POINTS = [
  'head',
  'leftShoulder', 'rightShoulder', 'leftElbow', 'rightElbow', 'leftWrist', 'rightWrist',
  'leftHip', 'rightHip', 'leftKnee', 'rightKnee', 'leftAnkle', 'rightAnkle',
] as const;
/**
 * Angles in degrees. turn: the body's facing, positive toward the dancer's left (their right
 * shoulder comes toward the camera). headYaw: positive looks to the dancer's left (image right
 * in an unmirrored frontal view). headPitch: positive looks up. headRoll: positive tilts toward
 * the dancer's left shoulder.
 */
export const SCALARS = ['turn', 'headYaw', 'headPitch', 'headRoll'] as const;
export type PointControl = typeof POINTS[number];
export type ScalarControl = typeof SCALARS[number];
export type Control = PointControl | ScalarControl;
export const CONTROLS: readonly Control[] = [...POINTS, ...SCALARS];

/** Named sets of controls, usable wherever ops take controls, and as additive layer channels for points. */
export const GROUPS = {
  all: CONTROLS,
  body: POINTS,
  headAngles: ['headYaw', 'headPitch', 'headRoll'],
  torso: ['leftShoulder', 'rightShoulder', 'leftHip', 'rightHip'],
  shoulders: ['leftShoulder', 'rightShoulder'],
  hips: ['leftHip', 'rightHip'],
  arms: ['leftElbow', 'rightElbow', 'leftWrist', 'rightWrist'],
  leftArm: ['leftElbow', 'leftWrist'],
  rightArm: ['rightElbow', 'rightWrist'],
  legs: ['leftKnee', 'rightKnee', 'leftAnkle', 'rightAnkle'],
  leftLeg: ['leftKnee', 'leftAnkle'],
  rightLeg: ['rightKnee', 'rightAnkle'],
  hands: ['leftWrist', 'rightWrist'],
  feet: ['leftAnkle', 'rightAnkle'],
  elbows: ['leftElbow', 'rightElbow'],
  knees: ['leftKnee', 'rightKnee'],
} as const satisfies Record<string, readonly Control[]>;
export type Group = keyof typeof GROUPS;
/** Elbows and knees are interpolated against their limb (rig.ts limbIK) rather than in the frame. */
export const MID_JOINTS = { leftElbow: ['leftShoulder', 'leftWrist'], rightElbow: ['rightShoulder', 'rightWrist'],
  leftKnee: ['leftHip', 'leftAnkle'], rightKnee: ['rightHip', 'rightAnkle'] } as const satisfies Partial<Record<PointControl, readonly [PointControl, PointControl]>>;
export type MidJoint = keyof typeof MID_JOINTS;
/** The points a contact can plant. */
export const CONTACT_CONTROLS = ['leftAnkle', 'rightAnkle', 'leftWrist', 'rightWrist'] as const;
export type ContactControl = typeof CONTACT_CONTROLS[number];

/** A stored point: z is optional; without it the depth comes from the dancer's turn (rig.ts). */
export type PointValue = [number, number] | [number, number, number];
/**
 * How a key's value travels to the next key: smooth (cubic, the default), linear, or hold
 * (steps at the next key).
 */
export type Interp = 'smooth' | 'linear' | 'hold';
/**
 * The velocity at a key: auto (smooth through it, never overshooting a turning point; the
 * default), stop (settles into the key and starts again from rest), or sharp (arrives with the
 * incoming velocity and leaves with the outgoing one: a hit).
 */
export type Ease = 'auto' | 'stop' | 'sharp';
export interface Key<V> { t: number; v: V; interp?: Interp; ease?: Ease; }
export type PointKey = Key<PointValue>;
export type ScalarKey = Key<number>;
export type AnyKey = PointKey | ScalarKey;
/**
 * A layer's keys by channel. The base layer (absolute) holds positions and angles; an additive
 * layer holds offsets, and may key a point group (e.g. body) to move all of its points.
 */
export type Channels = { [name: string]: AnyKey[] };
export interface Layer {
  id: string; label: string;
  mode: 'absolute' | 'additive';
  enabled: boolean;
  /** Additive layers only: scales every offset, 0 to 1. */
  weight: number;
  channels: Channels;
}
/** Holds a foot or hand where it is at startMs (or at `position`) until endMs, blending in and out. */
export interface Contact {
  id: string; control: ContactControl;
  startMs: number; endMs: number;
  /** Blend from the animated path onto the planted point before startMs, and back after endMs. */
  blendMs: number;
  position: PointValue | null;
}
/** Song scoring ignores the dancer (or only the listed controls' landmarks) over an interval. */
export interface Exclusion { id: string; startMs: number; endMs: number; reason: string; controls: string[] | null; }
/** Segment lengths in frame-height units: they size the automatic elbows/knees, face, hands and feet. */
export interface Body {
  shoulderWidth: number; hipWidth: number; torso: number; neck: number; head: number;
  upperArm: number; forearm: number; thigh: number; shin: number; hand: number; foot: number;
}
export const BODY_FIELDS: readonly (keyof Body)[] = ['shoulderWidth', 'hipWidth', 'torso', 'neck', 'head', 'upperArm', 'forearm', 'thigh', 'shin', 'hand', 'foot'];
/** How the game sizes and places the character (the retargeter's calibration); null derives it from the poses. */
export interface Calibration { torsoLength: number; baseHip: [number, number, number]; floorY: number; }
/**
 * Exaggeration for the game's character, applied to the evaluated pose (1 leaves a part as
 * keyed). The keys stay true to the video; the characters, the scorer and the export play the
 * styled pose. The character has no elbows or knees: it shows the hips, torso lean and turn, the
 * head, and floating hands and feet, so those are what a style can push further. Only lean and
 * sway change a scored limb direction (the torso's, and the legs' as the hips move over the feet);
 * the rest move or scale limbs whole.
 */
export interface Style {
  /** Arms longer from the shoulder, elbow and wrist alike, so the hands travel further. */
  reach: number;
  /** How far the body dips below its average height over about a beat (the whole body moves). */
  bounce: number;
  /** Side-to-side hip motion within about a beat, likewise. */
  sway: number;
  /** Torso lean from upright; the arms keep their directions. */
  lean: number;
  /** Body turn (it moves only depth). */
  turn: number;
  /** Head yaw, pitch and roll. */
  head: number;
  /** How high a raised foot rises off the floor (the leg shortens toward the hip). */
  lift: number;
}
export const STYLE_FIELDS: readonly (keyof Style)[] = ['reach', 'bounce', 'sway', 'lean', 'turn', 'head', 'lift'];
/** The range each style factor may take. */
export const STYLE_LIMITS: Readonly<Record<keyof Style, readonly [number, number]>> = {
  reach: [0.5, 2], bounce: [0, 4], sway: [0, 4], lean: [0, 3], turn: [0, 3], head: [0, 3], lift: [0, 4],
};
export const neutralStyle = (): Style => ({ reach: 1, bounce: 1, sway: 1, lean: 1, turn: 1, head: 1, lift: 1 });
export interface Dancer {
  id: string; label: string;
  /** Delays this dancer's whole animation, in ms (negative advances it). */
  timeOffsetMs: number;
  /** Where the dancer stands when nothing else is keyed: the hip midpoint, [x, y]. */
  home: [number, number];
  body: Body;
  calibration: Calibration | null;
  /** Exaggeration for the characters; absent or null plays the pose as keyed. */
  style?: Style | null;
  /** Direct character poses on the dancer's clock; independent of scoring landmarks. */
  performance?: PerformanceClip[];
  /** layers[0] is the absolute base; any further layers are additive. */
  layers: Layer[];
  contacts: Contact[];
  exclusions: Exclusion[];
}
export interface Phrase { id: string; label: string; startMs: number; endMs: number; dancer: string | null; }
export type MarkerKind = 'beat' | 'phrase' | 'note';
export interface Marker { id: string; timeMs: number; kind: MarkerKind; label: string; }
export type Difficulty = 'easy' | 'normal' | 'hard';
export interface SongInfo {
  title: string; artist: string; songwriters: string[]; choreographers: string[];
  difficulty: Difficulty; stage: StageId; tags: string[]; description: string;
  /** The beat grid: beat 1 is at beatOffsetMs. */
  bpm: number | null; beatOffsetMs: number;
  durationMs: number; playableStartMs: number; playableEndMs: number;
}
/** A file in the project folder (or, linked, an absolute path), checked by hash. */
export interface FileRef { path: string; sha256: string; bytes: number; mimeType: string; }
export interface VideoSource extends FileRef {
  width: number; height: number; fps: number; durationMs: number;
  /** Song time of the video's first frame, and video seconds per song second. */
  startMs: number; rate: number;
  /** A browser-playable copy for Studio playback, if the original may not play. */
  proxy: string | null;
}
export interface AudioSource extends FileRef { durationMs: number; }
/** Poses tracked from the video (a `take` .adpose on the video's clock), for reference, drafts and scoring. */
export interface TrackingSource extends FileRef {
  id: string; model: string; createdAt: string; fps: number;
  /** The dancer each pose slot follows (null: nobody). */
  dancers: (string | null)[];
}
export interface Dance {
  schema: typeof DANCE_SCHEMA; schemaVersion: typeof DANCE_VERSION;
  revision: number; createdAt: string; updatedAt: string;
  song: SongInfo;
  /** The coordinate frame: the video's pixel size. */
  frame: { width: number; height: number };
  sources: { video: VideoSource | null; audio: AudioSource | null; tracking: TrackingSource[] };
  dancers: Dancer[];
  phrases: Phrase[];
  markers: Marker[];
}

export const isPointControl = (v: unknown): v is PointControl => (POINTS as readonly unknown[]).includes(v);
export const isScalarControl = (v: unknown): v is ScalarControl => (SCALARS as readonly unknown[]).includes(v);
export const isControl = (v: unknown): v is Control => isPointControl(v) || isScalarControl(v);
export const isGroup = (v: unknown): v is Group => typeof v === 'string' && Object.hasOwn(GROUPS, v);
export const isMidJoint = (v: unknown): v is MidJoint => typeof v === 'string' && Object.hasOwn(MID_JOINTS, v);
/** Controls and groups, expanded and deduplicated in CONTROLS order. */
export function expandControls(names: readonly string[] | null | undefined): Control[] {
  if (!names) return [...CONTROLS];
  const wanted = new Set<Control>();
  for (const name of names) {
    if (isControl(name)) wanted.add(name);
    else if (isGroup(name)) for (const c of GROUPS[name]) wanted.add(c);
    else throw Error(`Unknown control or group "${name}"; use ${[...CONTROLS, ...Object.keys(GROUPS)].join(', ')}`);
  }
  return CONTROLS.filter(c => wanted.has(c));
}
export const aspectOf = (dance: Pick<Dance, 'frame'>) => dance.frame.width / dance.frame.height;

/**
 * Typical proportions for a dancer `height` frame-heights tall (head top to floor). Joint
 * positions follow MediaPipe's landmarks, e.g. the head point is between the ears.
 */
export function defaultBody(height = 0.72): Body {
  const r = (v: number) => Math.round(v * height * 1e5) / 1e5;
  return { shoulderWidth: r(0.21), hipWidth: r(0.115), torso: r(0.29), neck: r(0.105), head: r(0.085),
    upperArm: r(0.175), forearm: r(0.15), thigh: r(0.245), shin: r(0.245), hand: r(0.06), foot: r(0.14) };
}

export const round = (v: number, digits = 5) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f || 0;
};
/** Times are stored to a tenth of a millisecond. */
export const roundTime = (t: number) => Math.round(t * 10) / 10 || 0;

const DEFAULT_SONG_MS = 30_000;
/** A new dance: `dancers` standing side by side in a 16:9 frame (or the video's), each with one neutral key at 0. */
export function newDance({ dancers = 2, frame = { width: 1280, height: 720 }, durationMs = DEFAULT_SONG_MS, title = '', now = new Date().toISOString() }:
  { dancers?: number; frame?: { width: number; height: number }; durationMs?: number; title?: string; now?: string } = {}): Dance {
  if (!Number.isInteger(dancers) || dancers < 1 || dancers > MAX_DANCERS) throw Error('A dance has one to four dancers');
  return {
    schema: DANCE_SCHEMA, schemaVersion: DANCE_VERSION, revision: 0, createdAt: now, updatedAt: now,
    song: { title, artist: '', songwriters: [], choreographers: [], difficulty: 'normal', stage: 'openreef', tags: [], description: '',
      bpm: null, beatOffsetMs: 0, durationMs, playableStartMs: 0, playableEndMs: durationMs },
    frame: { ...frame },
    sources: { video: null, audio: null, tracking: [] },
    dancers: Array.from({ length: dancers }, (_, i) => newDancer(i, dancers)),
    phrases: [], markers: [],
  };
}
/** Dancer i of n: P<i+1>, standing at its share of the frame. */
export function newDancer(index: number, count: number, id = `P${index + 1}`): Dancer {
  return {
    id, label: `Dancer ${index + 1}`, timeOffsetMs: 0,
    home: [round((index + 0.5) / count, 4), 0.5], body: defaultBody(), calibration: null,
    layers: [{ id: 'base', label: 'Base', mode: 'absolute', enabled: true, weight: 1, channels: {} }],
    contacts: [], exclusions: [],
  };
}

// ---- Validation ----

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const isId = (v: unknown): v is string => typeof v === 'string' && ID.test(v);
const isText = (v: unknown, max = 4000): v is string => typeof v === 'string' && v.length <= max;
const SHA = /^[a-f0-9]{64}$/;
const INTERPS: readonly Interp[] = ['smooth', 'linear', 'hold'];
const EASES: readonly Ease[] = ['auto', 'stop', 'sharp'];
const DIFFICULTIES: readonly Difficulty[] = ['easy', 'normal', 'hard'];
const MARKER_KINDS: readonly MarkerKind[] = ['beat', 'phrase', 'note'];

class Invalid extends Error {}
function check(ok: unknown, path: string, message: string): asserts ok {
  if (!ok) throw new Invalid(`${path}: ${message}`);
}
const isPointValue = (v: unknown): v is PointValue => Array.isArray(v) && (v.length === 2 || v.length === 3) && v.every(finite);
function checkKeys(keys: unknown, path: string, kind: 'point' | 'scalar') {
  check(Array.isArray(keys), path, 'must be an array of keys');
  let last = -Infinity;
  keys.forEach((key, i) => {
    const at = `${path}[${i}]`;
    check(isObject(key) && finite(key.t), at, 'needs a finite time t');
    check(key.t > last, at, 'keys must be in strictly increasing time order');
    last = key.t;
    check(kind === 'point' ? isPointValue(key.v) : finite(key.v), at, kind === 'point' ? 'v must be [x, y] or [x, y, z]' : 'v must be a number');
    check(key.interp === undefined || INTERPS.includes(key.interp as Interp), at, `interp must be one of ${INTERPS.join(', ')}`);
    check(key.ease === undefined || EASES.includes(key.ease as Ease), at, `ease must be one of ${EASES.join(', ')}`);
    for (const k of Object.keys(key)) check(['t', 'v', 'interp', 'ease'].includes(k), at, `unknown field ${k}`);
  });
}
function checkFile(v: unknown, path: string) {
  check(isObject(v) && isText(v.path, 1000) && v.path.length > 0 && typeof v.sha256 === 'string' && SHA.test(v.sha256) &&
    finite(v.bytes) && v.bytes >= 0 && isText(v.mimeType, 200), path, 'needs path, sha256, bytes and mimeType');
}
function checkInterval(v: Record<string, unknown>, path: string) {
  check(finite(v.startMs) && finite(v.endMs) && v.endMs > v.startMs, path, 'needs startMs < endMs');
}

/** Throws a message naming the first invalid field. */
export function assertDance(value: unknown): asserts value is Dance {
  check(isObject(value) && value.schema === DANCE_SCHEMA, 'dance', `schema must be "${DANCE_SCHEMA}"`);
  check(value.schemaVersion === DANCE_VERSION, 'dance', `unsupported schemaVersion ${String(value.schemaVersion)}; this tool reads version ${DANCE_VERSION}`);
  check(Number.isSafeInteger(value.revision) && (value.revision as number) >= 0, 'revision', 'must be a whole number');
  check(isText(value.createdAt, 64) && isText(value.updatedAt, 64), 'dance', 'needs createdAt and updatedAt');
  const song = value.song;
  check(isObject(song), 'song', 'is required');
  for (const k of ['title', 'artist', 'description'] as const) check(isText(song[k]), `song.${k}`, 'must be text');
  for (const k of ['songwriters', 'choreographers', 'tags'] as const) check(Array.isArray(song[k]) && song[k].every(v => isText(v, 200)), `song.${k}`, 'must be a list of text');
  check(DIFFICULTIES.includes(song.difficulty as Difficulty), 'song.difficulty', `must be ${DIFFICULTIES.join(', ')}`);
  check(isStageId(song.stage), 'song.stage', 'must be a stage id (packages/stages/catalog.ts)');
  check(song.bpm === null || finite(song.bpm) && song.bpm > 0 && song.bpm < 1000, 'song.bpm', 'must be null or a positive tempo');
  check(finite(song.beatOffsetMs), 'song.beatOffsetMs', 'must be a number');
  check(finite(song.durationMs) && song.durationMs > 0, 'song.durationMs', 'must be positive');
  check(finite(song.playableStartMs) && finite(song.playableEndMs) && song.playableStartMs >= 0 &&
    song.playableStartMs < song.playableEndMs && song.playableEndMs <= song.durationMs, 'song', 'needs 0 <= playableStartMs < playableEndMs <= durationMs');
  const frame = value.frame;
  check(isObject(frame) && Number.isInteger(frame.width) && Number.isInteger(frame.height) && (frame.width as number) > 0 && (frame.height as number) > 0 &&
    (frame.width as number) <= 65535 && (frame.height as number) <= 65535, 'frame', 'needs whole-pixel width and height');
  const sources = value.sources;
  check(isObject(sources), 'sources', 'is required');
  if (sources.video !== null) {
    const v = sources.video;
    checkFile(v, 'sources.video');
    check(isObject(v) && finite(v.width) && finite(v.height) && finite(v.fps) && v.fps > 0 && finite(v.durationMs) && finite(v.startMs) &&
      finite(v.rate) && v.rate > 0 && (v.proxy === null || isText(v.proxy, 1000)), 'sources.video', 'needs width, height, fps, durationMs, startMs, rate and proxy');
  }
  if (sources.audio !== null) {
    checkFile(sources.audio, 'sources.audio');
    check(isObject(sources.audio) && finite(sources.audio.durationMs) && sources.audio.durationMs > 0, 'sources.audio', 'needs durationMs');
  }
  check(Array.isArray(sources.tracking), 'sources.tracking', 'must be a list');
  const trackingIds = new Set<string>();
  sources.tracking.forEach((t, i) => {
    const path = `sources.tracking[${i}]`;
    checkFile(t, path);
    check(isObject(t) && isId(t.id) && !trackingIds.has(t.id), path, 'needs a unique id');
    trackingIds.add(t.id);
    check(isText(t.model, 40) && isText(t.createdAt, 64) && finite(t.fps) && Array.isArray(t.dancers) &&
      t.dancers.every(d => d === null || isId(d)), path, 'needs model, createdAt, fps and dancers');
  });
  const dancers = value.dancers;
  check(Array.isArray(dancers) && dancers.length >= 1 && dancers.length <= MAX_DANCERS, 'dancers', 'must hold one to four dancers');
  const ids = new Set<string>();
  dancers.forEach((d, i) => checkDancer(d, `dancers[${i}]`, ids));
  check(Array.isArray(value.phrases), 'phrases', 'must be a list');
  const phraseIds = new Set<string>();
  value.phrases.forEach((p, i) => {
    const path = `phrases[${i}]`;
    check(isObject(p) && isId(p.id) && !phraseIds.has(p.id) && isText(p.label, 200), path, 'needs a unique id and a label');
    phraseIds.add(p.id);
    checkInterval(p, path);
    check(p.dancer === null || ids.has(p.dancer as string), path, 'dancer must be null or a dancer id');
  });
  check(Array.isArray(value.markers), 'markers', 'must be a list');
  const markerIds = new Set<string>();
  value.markers.forEach((m, i) => {
    check(isObject(m) && isId(m.id) && !markerIds.has(m.id) && finite(m.timeMs) && MARKER_KINDS.includes(m.kind as MarkerKind) && isText(m.label, 200),
      `markers[${i}]`, 'needs a unique id, timeMs, kind (beat, phrase, note) and label');
    markerIds.add(m.id);
  });
}
function checkDancer(d: unknown, path: string, ids: Set<string>) {
  check(isObject(d) && isId(d.id) && !ids.has(d.id), path, 'needs a unique id (letters, digits, - and _)');
  ids.add(d.id);
  check(isText(d.label, 80) && d.label.trim().length > 0, `${path}.label`, 'must be non-empty text');
  check(finite(d.timeOffsetMs), `${path}.timeOffsetMs`, 'must be a number');
  check(Array.isArray(d.home) && d.home.length === 2 && d.home.every(finite), `${path}.home`, 'must be [x, y]');
  const body = d.body;
  check(isObject(body), `${path}.body`, 'is required');
  for (const k of BODY_FIELDS) check(finite(body[k]) && body[k] > 0 && body[k] < 4, `${path}.body.${k}`, 'must be a positive length in frame heights');
  if (d.calibration !== null) {
    const c = d.calibration;
    check(isObject(c) && finite(c.torsoLength) && c.torsoLength > 0 && Array.isArray(c.baseHip) && c.baseHip.length === 3 && c.baseHip.every(finite) &&
      finite(c.floorY), `${path}.calibration`, 'must be null or { torsoLength, baseHip: [x, y, z], floorY }');
  }
  if (d.style !== undefined && d.style !== null) {
    const style = d.style;
    check(isObject(style), `${path}.style`, 'must be null or an object of factors');
    for (const k of STYLE_FIELDS) check(finite(style[k]) && style[k] >= STYLE_LIMITS[k][0] && style[k] <= STYLE_LIMITS[k][1], `${path}.style.${k}`,
      `must be a factor from ${STYLE_LIMITS[k][0]} to ${STYLE_LIMITS[k][1]}`);
    for (const k of Object.keys(style)) check((STYLE_FIELDS as readonly string[]).includes(k), `${path}.style.${k}`, `is not a style factor; they are ${STYLE_FIELDS.join(', ')}`);
  }
  if (d.performance !== undefined) assertPerformanceClips(d.performance);
  check(Array.isArray(d.layers) && d.layers.length >= 1, `${path}.layers`, 'needs at least the base layer');
  const layerIds = new Set<string>();
  d.layers.forEach((layer, i) => {
    const at = `${path}.layers[${i}]`;
    check(isObject(layer) && isId(layer.id) && !layerIds.has(layer.id) && isText(layer.label, 80), at, 'needs a unique id and a label');
    layerIds.add(layer.id);
    check(layer.mode === (i === 0 ? 'absolute' : 'additive'), at, i === 0 ? 'the first layer is the absolute base' : 'layers after the base are additive');
    check(typeof layer.enabled === 'boolean' && finite(layer.weight) && layer.weight >= 0 && layer.weight <= 1, at, 'needs enabled and a weight from 0 to 1');
    check(i > 0 || layer.enabled && layer.weight === 1, at, 'the base layer is always enabled at full weight');
    check(isObject(layer.channels), `${at}.channels`, 'must be an object');
    for (const [name, keys] of Object.entries(layer.channels)) {
      const point = isPointControl(name) || i > 0 && isGroup(name) && name !== 'all' && name !== 'headAngles';
      check(point || isScalarControl(name), `${at}.channels.${name}`, i === 0 ? 'is not a control' : 'is not a control or point group');
      checkKeys(keys, `${at}.channels.${name}`, point ? 'point' : 'scalar');
    }
  });
  check(Array.isArray(d.contacts), `${path}.contacts`, 'must be a list');
  const contactIds = new Set<string>();
  d.contacts.forEach((c, i) => {
    const at = `${path}.contacts[${i}]`;
    check(isObject(c) && isId(c.id) && !contactIds.has(c.id) && (CONTACT_CONTROLS as readonly unknown[]).includes(c.control), at,
      `needs a unique id and a control (${CONTACT_CONTROLS.join(', ')})`);
    contactIds.add(c.id);
    checkInterval(c, at);
    check(finite(c.blendMs) && c.blendMs >= 0 && c.blendMs <= 2000, at, 'blendMs must be 0 to 2000');
    check(c.position === null || isPointValue(c.position), at, 'position must be null or [x, y(, z)]');
  });
  for (const control of CONTACT_CONTROLS) {
    const list = (d.contacts as Contact[]).filter(c => c.control === control).sort((a, b) => a.startMs - b.startMs);
    // Blends may overlap (a foot lifts briefly between two plants); the plants themselves may not.
    for (let i = 1; i < list.length; i++)
      check(list[i].startMs >= list[i - 1].endMs, `${path}.contacts`, `${control} contacts ${list[i - 1].id} and ${list[i].id} overlap`);
  }
  check(Array.isArray(d.exclusions), `${path}.exclusions`, 'must be a list');
  const exclusionIds = new Set<string>();
  d.exclusions.forEach((x, i) => {
    const at = `${path}.exclusions[${i}]`;
    check(isObject(x) && isId(x.id) && !exclusionIds.has(x.id) && isText(x.reason, 200) && x.reason.trim().length > 0, at, 'needs a unique id and a reason');
    exclusionIds.add(x.id);
    checkInterval(x, at);
    check(x.controls === null || Array.isArray(x.controls) && x.controls.every(c => isControl(c) || isGroup(c)), at, 'controls must be null or control/group names');
  });
}
export function validateDance(value: unknown): Dance {
  assertDance(value);
  return value;
}
/** Brings a saved dance up to date before it's checked: a song on a removed stage moves to its replacement. */
export function upgradeDance(value: unknown): unknown {
  if (isObject(value) && isObject(value.song)) value.song.stage = replaceRemovedStage(value.song.stage);
  return value;
}
/** The dancer with this id, a 1-based number, or label; throws listing the dancers otherwise. */
export function findDancer(dance: Dance, ref: unknown): Dancer {
  const list = dance.dancers;
  const found = typeof ref === 'number' ? list[ref - 1]
    : typeof ref === 'string' ? list.find(d => d.id === ref) ?? list.find(d => d.label === ref) ?? (/^\d+$/.test(ref) ? list[Number(ref) - 1] : undefined)
      : undefined;
  if (!found) throw Error(`Unknown dancer ${JSON.stringify(ref)}; this dance has ${list.map(d => `${d.id} (${d.label})`).join(', ')}`);
  return found;
}
export const baseLayer = (dancer: Dancer) => dancer.layers[0];
