// .adpose, the chunked binary pose container (docs/pose-binary-format.md): one format for song
// choreography, Studio takes, tracks and raw captures, and game replay recordings.
import { interpolatePoses, interpolatedOrigin, qualityFor } from './choreography.ts';
import type { FrameSize, LandmarkOrigin, Pose, PoseQuality, PoseSnapshot, TimedPoses, TimeKey, TrackCalibration } from './choreography.ts';
import type { PoseModelId } from './browser/models.ts';
import type { ScoreExclusion } from './song.ts';

export const JOINTS = 33;
export const DEFAULT_POSITION_STEP = 1 / 16384;
/** The quantized 0.5 confidence threshold every caller uses. */
export const CONFIDENCE_THRESHOLD = 127;
export const NULL_CONFIDENCE = 255;
const MAGIC = [0x89, 0x41, 0x44, 0x50, 0x4f, 0x53, 0x45, 0x0a];
const MAX_POSITION = 32767;

export type PoseFileKind = 'choreography' | 'take' | 'track' | 'capture' | 'recording';
export type PoseClock = 'song' | 'take' | 'media';
const KINDS: readonly PoseFileKind[] = ['choreography', 'take', 'track', 'capture', 'recording'];
const CLOCKS: readonly PoseClock[] = ['song', 'take', 'media'];
export const KIND_CLOCK: Readonly<Record<PoseFileKind, PoseClock>> = { choreography: 'song', take: 'take', track: 'take', capture: 'media', recording: 'song' };
const MODEL_IDS: readonly PoseModelId[] = ['lite', 'full', 'heavy'];
/** Per-frame clock fields: i32 microseconds from a per-file base. */
export const EXTENSION = {
  frameBrowserTimeMs: 1, resultBrowserTimeMs: 2, receivedBrowserTimeMs: 3,
  audioPositionAtFrameMs: 4, audioPositionAtReceiptMs: 5, captureBrowserTimeMs: 6,
} as const;
// Stored origin codes; 1 (resampled) is never stored.
const ORIGIN_CODES: Readonly<Record<LandmarkOrigin, number>> = { measured: 0, resampled: 0, edited: 2, 'gap-repaired': 3, 'missing-confidence': 4 };
const ORIGIN_NAMES: readonly (LandmarkOrigin | undefined)[] = ['measured', undefined, 'edited', 'gap-repaired', 'missing-confidence'];
const ELIGIBLE = 8;
const SEEK_TIME = 1;
const EVENT_TYPES = ['audio-start-scheduled', 'audio-stop', 'source-stopped'] as const;
const MARKER_KINDS = ['beat', 'phrase', 'note'] as const;
const SOURCE_KINDS = ['webcam', 'video'] as const;

export interface SongHeader {
  songId: string; durationMs: number; playableStartMs: number; playableEndMs: number;
  maxInterpolationGapMs: number;
  /** Quantized like confidence: 127 is 0.5. */
  confidenceThreshold: number;
}
export interface TrackHeader { slot: number; playerId: number; label: string; calibration: TrackCalibration | null; exclusions: ScoreExclusion[]; }
export interface PoseMarker { timeMs: number; kind: typeof MARKER_KINDS[number]; label: string; }
export interface CaptureInfo { sourceKind: typeof SOURCE_KINDS[number]; sessionId: string; audioPlaybackRate: number | null; }
export type CaptureEvent =
  | { type: 'audio-start-scheduled'; audioContextStartTime: number; positionMs: number; rate: number }
  | { type: 'audio-stop'; reason: string | null }
  | { type: 'source-stopped'; reason: string };
export type TimedCaptureEvent = CaptureEvent & { receivedBrowserTimeMs: number; audioPositionAtReceiptMs: number };
/** An event in a decoded file; frameIndex is the number of frames stored before it. */
export type FileCaptureEvent = TimedCaptureEvent & { frameIndex: number };

/** Everything in a file except its frames. */
export interface PoseFileHeader {
  kind: PoseFileKind;
  playerSlots: 1 | 2;
  input: FrameSize;
  modelId: PoseModelId | null;
  positionStep: number;
  extensionIds: number[];
  /** One base time in ms per extension field; each frame stores microseconds from it. */
  extensionBases: number[];
  song?: SongHeader; tracks?: TrackHeader[]; markers?: PoseMarker[]; capture?: CaptureInfo;
  /** The ancillary prov chunk: free-form JSON only Studio reads. */
  provenance?: unknown;
}
/** A decoded file: frame data in flat typed arrays, indexed [frame][slot][joint]. */
export interface PoseFrames extends PoseFileHeader {
  clock: PoseClock;
  times: Float64Array;
  /** Bit p set when slot p holds a pose. */
  present: Uint8Array;
  reviewed: Uint8Array;
  /** Bit 0: video frame timed by seek-time. */
  frameFlags: Uint8Array;
  seq: Uint32Array;
  /** [frame][slot][joint][xyz], already dequantized. */
  positions: Float32Array;
  /** [frame][slot][joint] bytes: q / 254, or 255 for null. */
  confidence: Uint8Array;
  /** Stored joint flags, or null when quality is derived from confidence. */
  jointFlags: Uint8Array | null;
  /** Extension values in absolute ms, by extension ID. */
  extensions: Map<number, Float64Array>;
  calibrationFrame?: PoseFrames;
  events: FileCaptureEvent[];
}
/** A frame in object form, for building files. */
export interface FrameInput {
  timeMs: number; poses: Pose[]; quality?: PoseQuality[];
  seq?: number; seekTime?: boolean;
  /** Extension values in ms by extension ID; required for each of the header's extensions. */
  extensions?: Readonly<Record<number, number>>;
}
export type PoseHeaderInput = Omit<PoseFileHeader, 'positionStep' | 'extensionIds' | 'extensionBases'> &
  Partial<Pick<PoseFileHeader, 'positionStep' | 'extensionIds' | 'extensionBases'>>;

function fail(message: string): never { throw Error(`Invalid pose file: ${message}`); }
function check(condition: unknown, message: string): asserts condition { if (!condition) fail(message); }
const encoder = new TextEncoder();
const pad8 = (n: number) => (8 - n % 8) % 8;
export const confidenceValue = (byte: number) => byte === NULL_CONFIDENCE ? null : byte / 254;
export const quantizeConfidence = (c: number | null) => c === null ? NULL_CONFIDENCE : Math.round(Math.min(1, Math.max(0, c)) * 254);
export const quantizePosition = (v: number, step: number) => Math.min(MAX_POSITION, Math.max(-MAX_POSITION, Math.round(v / step)));
/** Joint flags as derived from confidence when a file stores none. */
export const derivedFlags = (confidence: number, threshold: number) =>
  confidence === NULL_CONFIDENCE ? ORIGIN_CODES['missing-confidence'] : confidence >= threshold ? ELIGIBLE : 0;
export const strideOf = (slots: number, jointFlags: boolean, extensions: number) => {
  const size = 16 + slots * JOINTS * (6 + 1 + (jointFlags ? 1 : 0)) + extensions * 4;
  return size + pad8(size);
};
const thresholdOf = (h: Pick<PoseFileHeader, 'song'>) => h.song?.confidenceThreshold ?? CONFIDENCE_THRESHOLD;

class ByteWriter {
  buffer: Uint8Array<ArrayBuffer>;
  view: DataView;
  length: number;
  constructor(capacity = 1024) { this.buffer = new Uint8Array(capacity); this.view = new DataView(this.buffer.buffer); this.length = 0; }
  reserve(n: number) {
    if (this.length + n <= this.buffer.length) return;
    const next = new Uint8Array(Math.max(this.buffer.length * 2, this.length + n));
    next.set(this.buffer.subarray(0, this.length));
    this.buffer = next; this.view = new DataView(next.buffer);
  }
  u8(v: number) { this.reserve(1); this.view.setUint8(this.length, v); this.length += 1; }
  u16(v: number) { this.reserve(2); this.view.setUint16(this.length, v, true); this.length += 2; }
  u32(v: number) { this.reserve(4); this.view.setUint32(this.length, v, true); this.length += 4; }
  i16(v: number) { this.reserve(2); this.view.setInt16(this.length, v, true); this.length += 2; }
  i32(v: number) { this.reserve(4); this.view.setInt32(this.length, v, true); this.length += 4; }
  f32(v: number) { this.reserve(4); this.view.setFloat32(this.length, v, true); this.length += 4; }
  f64(v: number) { this.reserve(8); this.view.setFloat64(this.length, v, true); this.length += 8; }
  bytes(v: ArrayLike<number>) { this.reserve(v.length); this.buffer.set(v, this.length); this.length += v.length; }
  str(v: string) {
    const bytes = encoder.encode(v);
    if (bytes.length > 0xffff) throw Error('String exceeds 65535 bytes');
    this.u16(bytes.length); this.bytes(bytes);
  }
  zeros(n: number) { this.reserve(n); this.buffer.fill(0, this.length, this.length + n); this.length += n; }
  chunk(tag: string, body: () => void) {
    for (let i = 0; i < 4; i++) this.u8(tag.charCodeAt(i));
    const at = this.length; this.u32(0);
    body();
    const length = this.length - at - 4;
    this.view.setUint32(at, length, true);
    this.zeros(pad8(length));
  }
  result() { return this.buffer.slice(0, this.length); }
}

class ByteReader {
  view: DataView;
  bytes: Uint8Array;
  offset: number;
  constructor(bytes: Uint8Array) { this.bytes = bytes; this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); this.offset = 0; }
  take(n: number) { check(this.offset + n <= this.bytes.length, 'chunk ends early'); const at = this.offset; this.offset += n; return at; }
  u8() { return this.view.getUint8(this.take(1)); }
  u16() { return this.view.getUint16(this.take(2), true); }
  u32() { return this.view.getUint32(this.take(4), true); }
  f32() { return this.view.getFloat32(this.take(4), true); }
  f64() { return this.view.getFloat64(this.take(8), true); }
  str() { const n = this.u16(), at = this.take(n); return new TextDecoder('utf-8', { fatal: true }).decode(this.bytes.subarray(at, at + n)); }
  end() { check(this.offset === this.bytes.length, 'chunk has trailing bytes'); }
}

/** The slot holding a player: a track file's one slot holds the player its TRAK names. */
export function slotOf(header: Pick<PoseFileHeader, 'kind' | 'tracks' | 'playerSlots'>, playerId: number) {
  const slot = header.kind === 'track' ? header.tracks?.findIndex(t => t.playerId === playerId) ?? -1 : playerId;
  if (!(slot >= 0 && slot < header.playerSlots)) throw Error(`Player ${playerId} has no slot`);
  return slot;
}
export function slotPlayer(header: Pick<PoseFileHeader, 'kind' | 'tracks'>, slot: number) {
  return header.kind === 'track' ? header.tracks?.find(t => t.slot === slot)?.playerId ?? slot : slot;
}

/** Builds quantized frames from objects; decoding the encoded result gives the same values. */
export function buildFrames(header: PoseHeaderInput, inputs: readonly FrameInput[],
  extra: { calibrationFrame?: FrameInput; events?: FileCaptureEvent[] } = {}): PoseFrames {
  const positionStep = header.positionStep ?? DEFAULT_POSITION_STEP;
  const extensionIds = header.extensionIds ?? [];
  const extensionBases = header.extensionBases ?? extensionIds.map(id => inputs[0]?.extensions?.[id] ?? 0);
  const full: PoseFileHeader = { ...header, positionStep, extensionIds, extensionBases };
  const P = header.playerSlots, n = inputs.length, threshold = thresholdOf(header);
  const frames: PoseFrames = {
    ...full, clock: KIND_CLOCK[header.kind],
    times: new Float64Array(n), present: new Uint8Array(n), reviewed: new Uint8Array(n), frameFlags: new Uint8Array(n),
    seq: new Uint32Array(n), positions: new Float32Array(n * P * JOINTS * 3), confidence: new Uint8Array(n * P * JOINTS),
    jointFlags: new Uint8Array(n * P * JOINTS), extensions: new Map(extensionIds.map(id => [id, new Float64Array(n)])),
    events: extra.events ?? [],
  };
  let explicit = false;
  inputs.forEach((input, f) => {
    frames.times[f] = input.timeMs;
    frames.seq[f] = input.seq ?? 0;
    frames.frameFlags[f] = input.seekTime ? SEEK_TIME : 0;
    const quality = input.quality ?? qualityFor(input.poses);
    for (const pose of input.poses) {
      const slot = slotOf(header, pose.playerId), bit = 1 << slot;
      if (frames.present[f] & bit) throw Error(`Player ${pose.playerId} appears twice`);
      if (pose.landmarks.length !== JOINTS) throw Error('A pose needs all 33 landmarks');
      const q = quality.find(v => v.playerId === pose.playerId);
      if (!q) throw TypeError('Missing pose quality');
      frames.present[f] |= bit;
      if (q.reviewed) frames.reviewed[f] |= bit;
      pose.landmarks.forEach((p, j) => {
        const at = (f * P + slot) * JOINTS + j;
        frames.positions.set([p.x, p.y, p.z].map(v => quantizePosition(v, positionStep) * positionStep), at * 3);
        const c = quantizeConfidence(p.confidence);
        frames.confidence[at] = c;
        const flags = ORIGIN_CODES[q.landmarkOrigins[j]] | (q.scoreEligible[j] ? ELIGIBLE : 0);
        frames.jointFlags![at] = flags;
        // Quality qualityFor would give needs no flags; readers derive it from the byte, accepting
        // that a confidence just under the threshold rounds up to it.
        const derived = p.confidence === null ? ORIGIN_CODES['missing-confidence'] : p.confidence >= threshold / 254 ? ELIGIBLE : 0;
        if (flags !== derived) explicit = true;
      });
    }
    extensionIds.forEach((id, e) => {
      const value = input.extensions?.[id];
      if (value === undefined || !Number.isFinite(value)) throw Error(`Frame is missing extension field ${id}`);
      const q = Math.round((value - extensionBases[e]) * 1000);
      if (Math.abs(q) > 0x7fffffff) throw Error(`Extension field ${id} is out of range`);
      frames.extensions.get(id)![f] = extensionBases[e] + q / 1000;
    });
  });
  if (!explicit) frames.jointFlags = null;
  if (extra.calibrationFrame) frames.calibrationFrame = buildFrames(full, [extra.calibrationFrame]);
  return frames;
}
/** Object samples on a song or take clock as frames. */
export function framesFromSamples<K extends TimeKey>(header: PoseHeaderInput, samples: readonly (TimedPoses<K> & { sourceSeq?: number })[], timeKey: K,
  extra: { calibrationFrame?: FrameInput; events?: FileCaptureEvent[] } = {}): PoseFrames {
  return buildFrames(header, samples.map(s => ({ timeMs: s[timeKey], poses: s.poses, quality: s.quality, seq: s.sourceSeq })), extra);
}

function writeFrameRecords(w: ByteWriter, f: PoseFrames, from: number, to: number) {
  const P = f.playerSlots, hasFlags = !!f.jointFlags, E = f.extensionIds.length;
  const stride = strideOf(P, hasFlags, E), per = P * JOINTS;
  w.reserve((to - from) * stride);
  for (let i = from; i < to; i++) {
    const start = w.length;
    w.f64(f.times[i]); w.u8(f.present[i]); w.u8(f.reviewed[i] & f.present[i]); w.u8(f.frameFlags[i]); w.u8(0); w.u32(f.seq[i]);
    for (let slot = 0; slot < P; slot++) {
      const absent = !(f.present[i] & (1 << slot));
      for (let k = 0; k < JOINTS * 3; k++) w.i16(absent ? 0 : quantizePosition(f.positions[(i * per + slot * JOINTS) * 3 + k], f.positionStep));
    }
    for (let slot = 0; slot < P; slot++) for (let j = 0; j < JOINTS; j++)
      w.u8(f.present[i] & (1 << slot) ? f.confidence[i * per + slot * JOINTS + j] : 0);
    if (f.jointFlags) for (let slot = 0; slot < P; slot++) for (let j = 0; j < JOINTS; j++)
      w.u8(f.present[i] & (1 << slot) ? f.jointFlags[i * per + slot * JOINTS + j] : 0);
    f.extensionIds.forEach((id, e) => w.i32(Math.round((f.extensions.get(id)![i] - f.extensionBases[e]) * 1000)));
    w.zeros(stride - (w.length - start));
  }
}
function writeFramesChunk(w: ByteWriter, tag: string, f: PoseFrames, from: number, to: number) {
  w.chunk(tag, () => { w.u32(to - from); w.u32(0); writeFrameRecords(w, f, from, to); });
}
function writeEvents(w: ByteWriter, events: readonly TimedCaptureEvent[]) {
  w.chunk('EVNT', () => {
    w.u16(events.length);
    for (const e of events) {
      w.f64(e.receivedBrowserTimeMs); w.f64(e.audioPositionAtReceiptMs); w.u8(EVENT_TYPES.indexOf(e.type) + 1);
      const start = e.type === 'audio-start-scheduled';
      w.f64(start ? e.audioContextStartTime : NaN); w.f64(start ? e.positionMs : NaN); w.f64(start ? e.rate : NaN);
      w.str(e.type === 'audio-start-scheduled' ? '' : e.reason ?? '');
    }
  });
}
function writeHeader(w: ByteWriter, h: PoseFileHeader, hasFlags: boolean, calibrationFrame?: PoseFrames) {
  w.bytes(MAGIC);
  w.chunk('HEAD', () => {
    w.u16(1); w.u8(KINDS.indexOf(h.kind) + 1); w.u8(CLOCKS.indexOf(KIND_CLOCK[h.kind]) + 1); w.u8(h.playerSlots); w.u8(1);
    w.u8(hasFlags ? 1 : 0); w.u8(h.modelId ? MODEL_IDS.indexOf(h.modelId) + 1 : 0);
    w.u16(h.input.width); w.u16(h.input.height); w.f32(h.positionStep);
    w.u8(h.extensionIds.length); w.bytes(h.extensionIds);
    w.zeros(pad8(17 + h.extensionIds.length));
    for (const base of h.extensionBases) w.f64(base);
  });
  if (h.song) {
    const s = h.song;
    w.chunk('SONG', () => { w.str(s.songId); w.f64(s.durationMs); w.f64(s.playableStartMs); w.f64(s.playableEndMs); w.u16(s.maxInterpolationGapMs); w.u8(s.confidenceThreshold); });
  }
  for (const t of h.tracks ?? []) w.chunk('TRAK', () => {
    const c = t.calibration;
    if (c && (c.inputWidth !== h.input.width || c.inputHeight !== h.input.height)) throw Error('Track calibration must use the file input size');
    w.u8(t.slot); w.u8(t.playerId); w.str(t.label); w.u8(c ? c.profileVersion : 0);
    for (const v of c ? [c.torsoLength, c.baseHip.x, c.baseHip.y, c.baseHip.z, c.floorY, c.bodyTorsoLength ?? NaN] : Array(6).fill(NaN)) w.f32(v);
    w.u8(c?.cameraScaleMode === 'body-relative' ? 1 : 0);
    w.u16(t.exclusions.length);
    for (const x of t.exclusions) { w.f64(x.startMs); w.f64(x.endMs); w.str(x.reason); }
  });
  if (h.markers) {
    const markers = h.markers;
    w.chunk('MARK', () => { w.u16(markers.length); for (const m of markers) { w.f64(m.timeMs); w.u8(MARKER_KINDS.indexOf(m.kind)); w.str(m.label); } });
  }
  if (calibrationFrame) writeFramesChunk(w, 'CALF', { ...calibrationFrame, jointFlags: hasFlags ? calibrationFrame.jointFlags ?? explicitFlags(calibrationFrame) : null }, 0, 1);
  if (h.capture) {
    const c = h.capture;
    w.chunk('CAPT', () => { w.u8(SOURCE_KINDS.indexOf(c.sourceKind) + 1); w.str(c.sessionId); w.f64(c.audioPlaybackRate ?? NaN); });
  }
  if (h.provenance !== undefined) w.chunk('prov', () => w.bytes(encoder.encode(JSON.stringify(h.provenance))));
}
// Frames that derive their flags still need explicit bytes when the file stores flags.
function explicitFlags(f: PoseFrames) {
  const threshold = thresholdOf(f);
  return f.confidence.map(c => derivedFlags(c, threshold));
}

/** The whole file: header chunks, then frames, with each event chunk at its frame position. */
export function encodePoseFile(f: PoseFrames): Uint8Array<ArrayBuffer> {
  const hasFlags = !!f.jointFlags || !!f.calibrationFrame?.jointFlags;
  const frames = hasFlags && !f.jointFlags ? { ...f, jointFlags: explicitFlags(f) } : f;
  const w = new ByteWriter(64 + f.times.length * strideOf(f.playerSlots, hasFlags, f.extensionIds.length));
  writeHeader(w, f, hasFlags, f.calibrationFrame);
  let cursor = 0, wroteFrames = false;
  const events = [...f.events].sort((a, b) => a.frameIndex - b.frameIndex);
  for (let i = 0; i < events.length;) {
    const at = events[i].frameIndex;
    if (at > cursor) { writeFramesChunk(w, 'FRMS', frames, cursor, at); cursor = at; wroteFrames = true; }
    let end = i; while (end < events.length && events[end].frameIndex === at) end++;
    writeEvents(w, events.slice(i, end).map(({ frameIndex: _, ...e }) => e as TimedCaptureEvent));
    i = end;
  }
  if (cursor < f.times.length || !wroteFrames) writeFramesChunk(w, 'FRMS', frames, cursor, f.times.length);
  return w.result();
}

/** Appends to a file chunk by chunk, as the Studio recorder uploads batches. */
export class PoseFileWriter {
  header: PoseFileHeader;
  frameCount: number;
  lastTimeMs: number;
  constructor(header: PoseHeaderInput) {
    const extensionIds = header.extensionIds ?? [];
    if ((header.extensionBases ?? []).length !== extensionIds.length) throw Error('A streamed file needs a base for each extension field');
    this.header = { ...header, positionStep: header.positionStep ?? DEFAULT_POSITION_STEP, extensionIds, extensionBases: header.extensionBases ?? [] };
    this.frameCount = 0; this.lastTimeMs = -Infinity;
  }
  /** The magic and metadata chunks; joint flags are never streamed. */
  start(calibrationFrame?: FrameInput): Uint8Array<ArrayBuffer> {
    const w = new ByteWriter();
    writeHeader(w, this.header, false, calibrationFrame ? buildFrames(this.header, [calibrationFrame]) : undefined);
    return w.result();
  }
  /** One FRMS chunk. Frames must continue the file's increasing times. */
  frames(inputs: readonly FrameInput[]): Uint8Array<ArrayBuffer> {
    const frames = buildFrames(this.header, inputs);
    for (const t of frames.times) { if (!(t > this.lastTimeMs)) throw Error('Frame times must increase'); this.lastTimeMs = t; }
    const w = new ByteWriter(16 + inputs.length * strideOf(this.header.playerSlots, false, this.header.extensionIds.length));
    writeFramesChunk(w, 'FRMS', { ...frames, jointFlags: null }, 0, inputs.length);
    this.frameCount += inputs.length;
    return w.result();
  }
  events(events: readonly TimedCaptureEvent[]): Uint8Array<ArrayBuffer> {
    const w = new ByteWriter(); writeEvents(w, events); return w.result();
  }
}

interface Chunk { tag: string; payload: Uint8Array; }
const PER_KIND: Readonly<Record<PoseFileKind, { required: string[]; allowed: string[] }>> = {
  choreography: { required: ['SONG', 'TRAK', 'FRMS'], allowed: ['MARK'] },
  take: { required: ['FRMS'], allowed: ['CALF'] },
  track: { required: ['TRAK', 'FRMS'], allowed: [] },
  capture: { required: ['CAPT', 'FRMS'], allowed: ['CALF', 'EVNT'] },
  recording: { required: ['FRMS'], allowed: [] },
};
const METADATA = ['SONG', 'TRAK', 'MARK', 'CALF', 'CAPT', 'prov'];

function readHead(payload: Uint8Array) {
  const r = new ByteReader(payload);
  check(r.u16() === 1, 'unsupported format version');
  const kind = KINDS[r.u8() - 1], clock = CLOCKS[r.u8() - 1], playerSlots = r.u8(), landmarkSet = r.u8(), flags = r.u8(), model = r.u8();
  check(kind && clock === KIND_CLOCK[kind], 'unknown kind or clock');
  check(playerSlots === 1 || playerSlots === 2, 'player slots must be 1 or 2');
  check(landmarkSet === 1, 'unknown landmark set');
  check((flags & ~1) === 0 && model <= MODEL_IDS.length, 'unknown header flags or model');
  const input = { width: r.u16(), height: r.u16() }, positionStep = r.f32();
  check(input.width > 0 && input.height > 0, 'missing input size');
  check(Number.isFinite(positionStep) && positionStep > 0, 'invalid position step');
  const extensionIds = Array.from({ length: r.u8() }, () => r.u8());
  check(new Set(extensionIds).size === extensionIds.length && !extensionIds.includes(0), 'repeated extension field');
  r.take(pad8(17 + extensionIds.length));
  const extensionBases = extensionIds.map(() => r.f64());
  check(extensionBases.every(Number.isFinite), 'invalid extension base');
  r.end();
  return { kind, clock, playerSlots: playerSlots as 1 | 2, input, positionStep, extensionIds, extensionBases,
    modelId: model ? MODEL_IDS[model - 1] : null, hasFlags: flags === 1 };
}
const finiteOrNull = (v: number) => Number.isNaN(v) ? null : v;
function readTrack(payload: Uint8Array, input: FrameSize): TrackHeader {
  const r = new ByteReader(payload);
  const slot = r.u8(), playerId = r.u8(), label = r.str(), profile = r.u8();
  const [torsoLength, x, y, z, floorY, bodyTorsoLength] = Array.from({ length: 6 }, () => r.f32());
  const scaleMode = r.u8();
  check(playerId <= 1 && profile <= 2 && scaleMode <= 1, 'invalid track header');
  const exclusions = Array.from({ length: r.u16() }, () => ({ startMs: r.f64(), endMs: r.f64(), reason: r.str() }));
  r.end();
  let calibration: TrackCalibration | null = null;
  if (profile) {
    calibration = { inputWidth: input.width, inputHeight: input.height, torsoLength, baseHip: { x, y, z }, floorY, profileVersion: profile };
    if (scaleMode === 1) calibration.cameraScaleMode = 'body-relative';
    if (!Number.isNaN(bodyTorsoLength)) calibration.bodyTorsoLength = bodyTorsoLength;
  }
  return { slot, playerId, label, calibration, exclusions };
}
function readEvents(payload: Uint8Array, frameIndex: number): FileCaptureEvent[] {
  const r = new ByteReader(payload);
  const events = Array.from({ length: r.u16() }, (): FileCaptureEvent => {
    const receivedBrowserTimeMs = r.f64(), audioPositionAtReceiptMs = r.f64(), type = EVENT_TYPES[r.u8() - 1];
    const audioContextStartTime = r.f64(), positionMs = r.f64(), rate = r.f64(), reason = r.str();
    check(type, 'unknown event type');
    const timing = { receivedBrowserTimeMs, audioPositionAtReceiptMs, frameIndex };
    if (type === 'audio-start-scheduled') return { ...timing, type, audioContextStartTime, positionMs, rate };
    return type === 'audio-stop' ? { ...timing, type, reason: reason || null } : { ...timing, type, reason };
  });
  r.end();
  return events;
}

type HeadFields = ReturnType<typeof readHead>;
/** Reads FRMS-layout payloads into one set of arrays, validating every record. */
function readFrames(payloads: readonly Uint8Array[], head: HeadFields, threshold: number) {
  const P = head.playerSlots, E = head.extensionIds.length, per = P * JOINTS;
  const stride = strideOf(P, head.hasFlags, E);
  let n = 0;
  for (const p of payloads) {
    check(p.length >= 8, 'frame chunk ends early');
    const view = new DataView(p.buffer, p.byteOffset, p.byteLength), count = view.getUint32(0, true);
    check(view.getUint32(4, true) === 0, 'reserved frame chunk field');
    check(p.length === 8 + count * stride, 'frame count does not match the chunk length');
    n += count;
  }
  const times = new Float64Array(n), present = new Uint8Array(n), reviewed = new Uint8Array(n), frameFlags = new Uint8Array(n), seq = new Uint32Array(n);
  const positions = new Float32Array(n * per * 3), confidence = new Uint8Array(n * per), jointFlags = head.hasFlags ? new Uint8Array(n * per) : null;
  const extensions = new Map(head.extensionIds.map(id => [id, new Float64Array(n)]));
  const slotMask = (1 << P) - 1;
  let f = 0;
  for (const p of payloads) {
    const view = new DataView(p.buffer, p.byteOffset, p.byteLength), count = view.getUint32(0, true);
    for (let k = 0; k < count; k++, f++) {
      let at = 8 + k * stride;
      times[f] = view.getFloat64(at, true);
      check(Number.isFinite(times[f]) && (f === 0 || times[f] > times[f - 1]), 'frame times must be finite and increasing');
      present[f] = view.getUint8(at + 8); reviewed[f] = view.getUint8(at + 9); frameFlags[f] = view.getUint8(at + 10);
      check((present[f] & ~slotMask) === 0 && (reviewed[f] & ~present[f]) === 0 && (frameFlags[f] & ~SEEK_TIME) === 0 && view.getUint8(at + 11) === 0, 'invalid frame masks');
      seq[f] = view.getUint32(at + 12, true);
      at += 16;
      for (let slot = 0; slot < P; slot++) {
        const absent = !(present[f] & (1 << slot));
        for (let v = 0; v < JOINTS * 3; v++, at += 2) {
          const q = view.getInt16(at, true);
          check(q !== -32768 && (!absent || q === 0), 'invalid position');
          positions[(f * per + slot * JOINTS) * 3 + v] = q * head.positionStep;
        }
      }
      for (let slot = 0; slot < P; slot++) for (let j = 0; j < JOINTS; j++, at++) {
        const c = view.getUint8(at);
        check(c === 0 || present[f] & (1 << slot), 'absent pose has data');
        confidence[f * per + slot * JOINTS + j] = c;
      }
      if (jointFlags) for (let slot = 0; slot < P; slot++) for (let j = 0; j < JOINTS; j++, at++) {
        const flags = view.getUint8(at);
        check(flags === 0 || (present[f] & (1 << slot) && (flags & 0xf0) === 0 && ORIGIN_NAMES[flags & 7]), 'invalid joint flags');
        jointFlags[f * per + slot * JOINTS + j] = flags;
      }
      head.extensionIds.forEach((id, e) => { extensions.get(id)![f] = head.extensionBases[e] + view.getInt32(at, true) / 1000; at += 4; });
    }
  }
  // Flags identical to the derivation are dropped, as a writer would.
  const flags = jointFlags && jointFlags.some((v, i) => present[Math.floor(i / per)] & (1 << Math.floor(i % per / JOINTS)) && v !== derivedFlags(confidence[i], threshold)) ? jointFlags : null;
  return { times, present, reviewed, frameFlags, seq, positions, confidence, jointFlags: flags, extensions };
}

export interface DecodeOptions {
  /** Capture recovery: drop a final chunk that runs past the end instead of rejecting the file. */
  allowTruncated?: boolean;
}
/** Decodes and validates a file; throws on anything malformed. */
export function decodePoseFile(bytes: Uint8Array, { allowTruncated = false }: DecodeOptions = {}): PoseFrames {
  check(bytes.length >= 8 && MAGIC.every((b, i) => bytes[i] === b), 'not an .adpose file');
  const chunks: Chunk[] = [];
  for (let at = 8; at < bytes.length;) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + at, Math.min(8, bytes.length - at));
    if (bytes.length - at < 8 || at + 8 + view.getUint32(4, true) > bytes.length) {
      if (allowTruncated) break;
      fail('truncated');
    }
    const length = view.getUint32(4, true), tag = String.fromCharCode(...bytes.subarray(at, at + 4));
    check(/^[A-Za-z]{4}$/.test(tag), 'invalid chunk tag');
    chunks.push({ tag, payload: bytes.subarray(at + 8, at + 8 + length) });
    at += 8 + length + pad8(length);
  }
  check(chunks[0]?.tag === 'HEAD', 'HEAD must come first');
  const head = readHead(chunks[0].payload);
  const header: PoseFileHeader = { kind: head.kind, playerSlots: head.playerSlots, input: head.input, modelId: head.modelId,
    positionStep: head.positionStep, extensionIds: head.extensionIds, extensionBases: head.extensionBases };
  const seen = new Map<string, number>(), framePayloads: Uint8Array[] = [], events: FileCaptureEvent[] = [];
  let body = false, frameCount = 0, calibration: Uint8Array | undefined;
  const tracks: TrackHeader[] = [];
  for (const { tag, payload } of chunks.slice(1)) {
    seen.set(tag, (seen.get(tag) ?? 0) + 1);
    if (tag === 'FRMS') {
      body = true; framePayloads.push(payload);
      frameCount += payload.length >= 4 ? new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0, true) : 0;
      continue;
    }
    if (tag === 'EVNT') { body = true; events.push(...readEvents(payload, frameCount)); continue; }
    if (METADATA.includes(tag)) check(!body, `${tag} must come before the frames`);
    if (tag !== 'TRAK' && tag !== 'FRMS' && tag !== 'EVNT' && METADATA.includes(tag)) check(seen.get(tag) === 1, `repeated ${tag}`);
    if (tag === 'SONG') {
      const r = new ByteReader(payload);
      header.song = { songId: r.str(), durationMs: r.f64(), playableStartMs: r.f64(), playableEndMs: r.f64(), maxInterpolationGapMs: r.u16(), confidenceThreshold: r.u8() };
      r.end();
    } else if (tag === 'TRAK') tracks.push(readTrack(payload, head.input));
    else if (tag === 'MARK') {
      const r = new ByteReader(payload);
      header.markers = Array.from({ length: r.u16() }, () => {
        const timeMs = r.f64(), kind = MARKER_KINDS[r.u8()], label = r.str();
        check(kind && Number.isFinite(timeMs), 'invalid marker');
        return { timeMs, kind, label };
      });
      r.end();
    } else if (tag === 'CALF') calibration = payload;
    else if (tag === 'CAPT') {
      const r = new ByteReader(payload);
      const sourceKind = SOURCE_KINDS[r.u8() - 1], sessionId = r.str(), rate = r.f64();
      r.end();
      check(sourceKind, 'unknown capture source');
      header.capture = { sourceKind, sessionId, audioPlaybackRate: finiteOrNull(rate) };
    } else if (tag === 'prov') {
      try { header.provenance = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)); }
      catch { fail('provenance is not JSON'); }
    } else check(tag[0] >= 'a' && tag[0] <= 'z', `unsupported critical chunk ${tag}`);
  }
  if (tracks.length) header.tracks = tracks;
  const rules = PER_KIND[head.kind];
  for (const tag of rules.required) check(seen.has(tag), `${head.kind} needs ${tag}`);
  for (const tag of seen.keys()) check(tag === 'prov' || tag === 'FRMS' || rules.required.includes(tag) || rules.allowed.includes(tag) || tag[0] >= 'a', `${tag} is not allowed in a ${head.kind}`);
  checkKind(header, tracks);
  const threshold = thresholdOf(header);
  const frames: PoseFrames = { ...header, clock: head.clock, ...readFrames(framePayloads, head, threshold), events };
  if (calibration) {
    const calf = readFrames([calibration], head, threshold);
    check(calf.times.length === 1, 'CALF holds exactly one frame');
    frames.calibrationFrame = { ...header, clock: head.clock, ...calf, events: [] };
  }
  if (header.song) {
    const { times } = frames, s = header.song;
    check(times.length >= 2 && times[0] === s.playableStartMs && times[times.length - 1] === s.playableEndMs, 'missing endpoint anchors');
  }
  return frames;
}
function checkKind(h: PoseFileHeader, tracks: TrackHeader[]) {
  if (h.kind === 'choreography' || h.kind === 'take' || h.kind === 'track') check(!h.extensionIds.length, `a ${h.kind} has no extension fields`);
  if (h.kind === 'choreography') {
    check(h.playerSlots === 2 && tracks.length === 2 && tracks.every((t, i) => t.slot === i && t.playerId === i), 'both tracks are required');
    const s = h.song!;
    check(Number.isFinite(s.durationMs) && s.durationMs > 0 && s.playableStartMs >= 0 && s.playableStartMs < s.playableEndMs && s.playableEndMs <= s.durationMs, 'invalid song bounds');
    check(s.maxInterpolationGapMs >= 1 && s.maxInterpolationGapMs <= 200 && s.confidenceThreshold <= 254, 'invalid sampling policy');
  }
  if (h.kind === 'track') check(h.playerSlots === 1 && tracks.length === 1 && tracks[0].slot === 0, 'a track holds one slot');
  if (h.kind === 'capture') check(h.capture!.sourceKind === 'webcam' || h.playerSlots === 2, 'a video capture has two slots');
}

/** A slot's quality at a frame: stored flags, or derived from confidence as qualityFor does. */
export function frameQuality(f: PoseFrames, frame: number, slot: number): PoseQuality {
  const base = (frame * f.playerSlots + slot) * JOINTS, threshold = thresholdOf(f);
  const landmarkOrigins: LandmarkOrigin[] = [], scoreEligible: boolean[] = [];
  for (let j = 0; j < JOINTS; j++) {
    const flags = f.jointFlags ? f.jointFlags[base + j] : derivedFlags(f.confidence[base + j], threshold);
    landmarkOrigins.push(ORIGIN_NAMES[flags & 7] ?? 'measured');
    scoreEligible.push(!!(flags & ELIGIBLE));
  }
  return { playerId: slotPlayer(f, slot), landmarkOrigins, scoreEligible, reviewed: !!(f.reviewed[frame] & (1 << slot)) };
}
function framePose(f: PoseFrames, frame: number, slot: number): Pose {
  const base = (frame * f.playerSlots + slot) * JOINTS;
  return { playerId: slotPlayer(f, slot), landmarks: Array.from({ length: JOINTS }, (_, j) => ({
    x: f.positions[(base + j) * 3], y: f.positions[(base + j) * 3 + 1], z: f.positions[(base + j) * 3 + 2],
    confidence: confidenceValue(f.confidence[base + j]),
  })) };
}
/** The stored poses at a frame, in slot order. */
export function framesToPoses(f: PoseFrames, frame: number): PoseSnapshot {
  const poses: Pose[] = [], quality: PoseQuality[] = [];
  for (let slot = 0; slot < f.playerSlots; slot++) {
    if (!(f.present[frame] & (1 << slot))) continue;
    poses.push(framePose(f, frame, slot)); quality.push(frameQuality(f, frame, slot));
  }
  return { poses, quality };
}
export type FrameSample<K extends TimeKey> = TimedPoses<K> & { quality: PoseQuality[]; sourceSeq?: number };
/** Every frame as an object sample; sourceSeq is set when the frame has a sequence number. */
export function framesToSamples<K extends TimeKey>(f: PoseFrames, timeKey: K): FrameSample<K>[] {
  return Array.from(f.times, (t, i) => {
    const sample = { [timeKey]: t, ...framesToPoses(f, i) } as FrameSample<K>;
    if (f.seq[i]) sample.sourceSeq = f.seq[i];
    return sample;
  });
}
/** The first frame in [fromMs, toMs] where a slot holds a pose, or -1. */
export function firstPresentFrame(f: PoseFrames, slot: number, fromMs: number, toMs: number) {
  for (let i = 0; i < f.times.length && f.times[i] <= toMs; i++) if (f.times[i] >= fromMs && f.present[i] & (1 << slot)) return i;
  return -1;
}

/** The snapshot at timeMs, interpolated between stored frames exactly as sampleSnapshot does. */
export function sampleFrames(f: PoseFrames, timeMs: number, maxGap = f.song?.maxInterpolationGapMs ?? 200): PoseSnapshot {
  const { times } = f, n = times.length;
  if (!n || !(timeMs >= times[0] - 1e-5 && timeMs <= times[n - 1] + 1e-5)) return { poses: [], quality: [] };
  let lo = 0, hi = n - 1;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (times[mid] <= timeMs) lo = mid; else hi = mid - 1; }
  if (Math.abs(times[lo] - timeMs) < 1e-5) return framesToPoses(f, lo);
  if (lo + 1 < n && Math.abs(times[lo + 1] - timeMs) < 1e-5) return framesToPoses(f, lo + 1);
  if (lo + 1 >= n || times[lo + 1] - times[lo] > maxGap) return { poses: [], quality: [] };
  const a = lo, b = lo + 1, alpha = (timeMs - times[a]) / (times[b] - times[a]);
  const poses: Pose[] = [], quality: PoseQuality[] = [];
  for (let slot = 0; slot < f.playerSlots; slot++) {
    const bit = 1 << slot;
    if (!(f.present[a] & bit) || !(f.present[b] & bit)) continue; // Absence is never interpolated across.
    const pa = (a * f.playerSlots + slot) * JOINTS, pb = (b * f.playerSlots + slot) * JOINTS;
    poses.push({ playerId: slotPlayer(f, slot), landmarks: Array.from({ length: JOINTS }, (_, j) => {
      const ia = (pa + j) * 3, ib = (pb + j) * 3, ca = confidenceValue(f.confidence[pa + j]), cb = confidenceValue(f.confidence[pb + j]);
      return { x: f.positions[ia] + (f.positions[ib] - f.positions[ia]) * alpha,
        y: f.positions[ia + 1] + (f.positions[ib + 1] - f.positions[ia + 1]) * alpha,
        z: f.positions[ia + 2] + (f.positions[ib + 2] - f.positions[ia + 2]) * alpha,
        confidence: ca === null || cb === null ? null : ca + (cb - ca) * alpha };
    }) });
    const qa = frameQuality(f, a, slot), qb = frameQuality(f, b, slot);
    quality.push({ playerId: qa.playerId, landmarkOrigins: qa.landmarkOrigins.map((o, j) => interpolatedOrigin(o, qb.landmarkOrigins[j])),
      scoreEligible: qa.scoreEligible.map((v, j) => v && qb.scoreEligible[j]), reviewed: qa.reviewed && qb.reviewed });
  }
  return { poses, quality };
}

// Confidence is compared at half its quantization step: older data interpolated visibility and
// presence separately, so min(lerp) and lerp(min) differ slightly where the smaller one switches.
const CONFIDENCE_TOLERANCE = 1 / 508;
const sameSnapshot = (a: PoseSnapshot, b: { poses: Pose[]; quality?: PoseQuality[] }) => {
  const qb = b.quality ?? qualityFor(b.poses);
  return a.poses.length === b.poses.length && a.poses.every((p, i) => {
    const o = b.poses[i], q = a.quality[i], r = qb[i];
    return o.playerId === p.playerId && q.reviewed === r.reviewed && p.landmarks.every((l, j) => {
      const m = o.landmarks[j];
      return Math.abs(l.x - m.x) <= 1e-6 && Math.abs(l.y - m.y) <= 1e-6 && Math.abs(l.z - m.z) <= 1e-6 &&
        (l.confidence === null ? m.confidence === null : m.confidence !== null && Math.abs(l.confidence - m.confidence) <= CONFIDENCE_TOLERANCE) &&
        q.landmarkOrigins[j] === r.landmarkOrigins[j] && q.scoreEligible[j] === r.scoreEligible[j];
    });
  });
};
/**
 * The samples a choreography or track stores: a frame is dropped when interpolating its kept
 * neighbours reproduces it, so the sampler rebuilds it. Measured and edited frames never match an
 * interpolation's origins, so in practice only resampled frames go. The endpoints are always kept.
 */
export function sparseSamples<K extends TimeKey, S extends TimedPoses<K>>(samples: readonly S[], timeKey: K, maxGap: number): S[] {
  const time = (s: S) => s[timeKey];
  const reproduced = (l: number, r: number) => {
    const a = samples[l], b = samples[r], span = time(b) - time(a);
    for (let i = l + 1; i < r; i++) {
      const snapshot = span > maxGap ? { poses: [], quality: [] } : interpolatePoses(a, b, (time(samples[i]) - time(a)) / span);
      if (!sameSnapshot(snapshot, samples[i])) return false;
    }
    return true;
  };
  if (samples.length <= 2) return [...samples];
  const kept = [samples[0]];
  // Greedy: extend each segment from the last kept frame while every frame inside stays reproducible.
  for (let l = 0, r = 1; r < samples.length; r++) {
    if (r + 1 < samples.length && reproduced(l, r + 1)) continue;
    kept.push(samples[r]); l = r;
  }
  return kept;
}
