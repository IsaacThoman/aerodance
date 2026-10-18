import {
  copy,
  finite,
  clamp,
  isArray,
  isObject,
  oneOf,
  assertPoses,
  qualityFor,
  sampleSnapshot,
  mirrorPose,
  PAIRS,
  assertChoreography,
  validateChoreography,
} from "../../packages/pose/choreography.ts";
import type {
  CaptureInput,
  ChoreographySample,
  FrameSize,
  LandmarkOrigin,
  Point3,
  Pose,
  PoseQuality,
  TrackCalibration,
} from "../../packages/pose/choreography.ts";
import type { MotionTake, TakeSample } from "../../packages/pose/legacy.ts";
import type { RightsStatement, ScoreExclusion, SongChoreography, SongTrack } from "../../packages/pose/song.ts";
import { calibratePoses, reliableBodyPose } from "../../packages/character/calibration.ts";
import { DEFAULT_STAGE, isStageId } from "../../packages/stages/catalog.ts";
import type { StageId } from "../../packages/stages/catalog.ts";
import { validateWebcamRecord } from '../../packages/pose/webcamRecord.ts';
import type { WebcamRecord } from '../../packages/pose/webcamRecord.ts';
import { validateVideoRecord } from '../../packages/pose/videoRecord.ts';
import type { VideoRecord } from '../../packages/pose/videoRecord.ts';
import { poseModel, MEDIAPIPE_VERSION } from '../../packages/pose/browser/models.ts';
export const COMPILER_VERSION='1.2.0';

export type Difficulty = "easy" | "normal" | "hard";
export type AudioExtension = "mp3" | "wav" | "ogg" | "m4a" | "flac";
/** The song audio, stored once as assets/<sha256>.<extension>. */
export interface ProjectAudio { sha256: string; extension: AudioExtension; mimeType: string; durationMs: number; name: string; }
export interface ProjectMetadata {
  title: string; artist: string; songwriters: string[]; choreographers: string[];
  difficulty: Difficulty;
  /** The dance stage the game shows this song on. */
  stage: StageId;
  tags: string[]; bpm: number | null; description: string;
  rights: { audio: RightsStatement; choreography: RightsStatement };
}
export interface Marker { songTimeMs: number; kind: "beat" | "phrase" | "note"; label: string; }
/** A library take as the project lists it; the take itself is stored in takes/<takeId>.json. */
export interface TakeSummary {
  takeId: string; name: string; source: string; input: CaptureInput;
  /** Webcam and video takes: copied from the take's provenance. */
  modelId?: unknown; sourceRateHz?: unknown;
}
/** Project format 1: a track is a list of clips cut from library takes. */
export interface Clip {
  clipId: string; takeId: string; sourcePlayerId: number;
  sourceStartMs: number; sourceEndMs: number; songStartMs: number; timeScale: number;
}
export interface ClipTrack { playerId: number; label: string; clips: Clip[]; }
/** Project format 2: a track points at an immutable snapshot (tracks/<dataId>.json) placed at offsetMs. */
export interface Track { playerId: number; label: string; dataId: string | null; originalDataId: string | null; offsetMs: number; }

/** Edits apply over [startMs, endMs) on the song clock; a null playerId means both players. */
interface RangeEdit { startMs: number; endMs: number; playerId: number | null; }
export interface JointTarget { joint: number; value: Point3; }
/** Moves one joint (or a group, `targets`) at timeMs, blended in and out over the range. */
export interface JointEdit extends RangeEdit { type: "joint"; joint: number; value: Point3; timeMs: number; targets?: JointTarget[]; }
export interface PoseEdit extends RangeEdit { type: "swap" | "mirror" | "repair"; }
export interface SmoothEdit extends RangeEdit { type: "smooth"; windowMs: number; }
export interface ReviewEdit extends RangeEdit { type: "exclude" | "approve"; reason: string; }
export type EditCommand = JointEdit | PoseEdit | SmoothEdit | ReviewEdit;
export type EditType = EditCommand["type"];
/** Format 1 history: the edits themselves, replayed by every compile. */
export type EditOperation = EditCommand & { operationId: string };
export interface TrackEdit { type: "overwrite" | "clear" | "offset" | "interpolate"; playerId: number | null; }
export type TrackCommand = EditCommand | TrackEdit;
export type OperationType = TrackCommand["type"];
/** Format 2 history: each change keeps the track references before and after it. */
export type TrackChange = TrackCommand & { operationId: string; beforeTracks: Track[]; afterTracks: Track[] };

interface ProjectBase {
  schema: "aerodance.project";
  projectId: string; songId: string; revision: number;
  createdAt: string; updatedAt: string;
  metadata: ProjectMetadata;
  audio: ProjectAudio | null;
  durationMs: number; playableStartMs: number; playableEndMs: number;
  takes: TakeSummary[];
  operationCursor: number;
  markers: Marker[];
  alignmentReviewed: boolean;
}
export interface ProjectV1 extends ProjectBase { schemaVersion: 1; tracks: ClipTrack[]; operations: EditOperation[]; }
export interface ProjectV2 extends ProjectBase { schemaVersion: 2; tracks: Track[]; operations: TrackChange[]; }
/** aerodance.project: format 1 projects are migrated to 2 when opened. */
export type Project = ProjectV1 | ProjectV2;
/** A project as the project list shows it; unsupported formats are listed too. */
export interface ProjectSummary { projectId: string; schemaVersion: unknown; title: string; artist: string; updatedAt: string; }

export interface StudioTakeSample extends TakeSample { /** Webcam/video: the capture record's seq. */ sourceSeq?: number; }
export interface CalibrationFrame { mediaTimeMs: number; poses: Pose[]; }
/** Capture details; the shape depends on the source and is not validated. */
export type TakeProvenance = Record<string, unknown>;
/** aerodance.take v1 as Dance Studio stores it. Unlike a game motion take it has no durationMs. */
export interface Take extends Omit<MotionTake, "durationMs" | "samples"> {
  takeId: string; name: string;
  /** "webcam", "video", "legacy-demo", "choreography", or "android" for stored legacy captures. */
  source: string;
  samples: StudioTakeSample[];
  /** Song position of take time zero, and the take's playback rate. */
  offsetMs: number; timeScale: number;
  createdAt?: string;
  /** Required for video takes: the frame the dancers were calibrated on. */
  calibrationFrame?: CalibrationFrame;
  /** The pose model configuration the capture reported. */
  status?: unknown;
  interruptionReason?: string | null;
  provenance?: TakeProvenance | null;
  /** SHA-256 of the stored take file, added by the server. */
  sha256?: string;
}
export interface SourceRef { takeId: string; name?: string; source: string; sha256: string | null; provenance: TakeProvenance | null; }
export interface TrackSample extends StudioTakeSample { quality: PoseQuality[]; }
/** aerodance.track v1: an immutable snapshot of one player's poses, on its own clock. */
export interface TrackData {
  schema: "aerodance.track"; schemaVersion: 1;
  dataId: string; playerId: number; input: CaptureInput;
  samples: TrackSample[];
  sources: SourceRef[];
  exclusions: ScoreExclusion[];
  calibration?: TrackCalibration;
}
/** Takes by takeId and track snapshots by dataId. */
export type StudioAssets = Map<string, Take | TrackData>;
export const isTake = (asset: Take | TrackData | undefined): asset is Take => asset?.schema === "aerodance.take";
export const isTrackData = (asset: Take | TrackData | undefined): asset is TrackData => asset?.schema === "aerodance.track";

export interface CompileProvenance {
  compilerVersion: string; projectRevision: number; qualityPolicyVersion: 1;
  sources: SourceRef[];
  /** Added by the server: a hash of the edits and track references compiled. */
  settingsHash?: string;
}
/** The compiled choreography.json: the song bundle format plus markers and provenance. */
export interface CompiledChoreography extends SongChoreography { markers: Marker[]; provenance: CompileProvenance; }
export interface CompileOptions {
  /** Compile everything the tracks hold rather than the playable range; skips final validation. */
  fullTimeline?: boolean;
  /** Format 2: the edit to apply. */
  editOperation?: EditCommand | null;
}
export interface TrackCoverage { playerId: number; missingMs: number; eligibleMs: number; editedMs: number; }
export interface ReviewReport { blockers: string[]; warnings: string[]; coverage: TrackCoverage[]; }
export interface Interval { startMs: number; endMs: number; }

export type CaptureSourceKind = "webcam" | "video";
export const CAPTURE_SOURCES: readonly CaptureSourceKind[] = ["webcam", "video"];
/** capture/<takeId>/capture.json, written when a capture starts; finalize adds the last two fields. */
export interface CaptureMetadata {
  takeId: string; projectId?: string; name?: string; createdAt?: string;
  /** "webcam" or "video"; captures left by older editors have another or none. */
  sourceKind?: unknown;
  /** The pose model configuration the browser reported; checked when the take is built. */
  status?: unknown;
  interruptionReason?: string | null;
  calibrationFrame?: unknown;
}
export type CaptureEvent =
  | { type: "audio-start-scheduled"; audioContextStartTime: number; positionMs: number; rate: number }
  | { type: "audio-stop"; reason: string | null }
  | { type: "source-stopped"; reason: string };
interface EnvelopeTiming { ordinal: number; receivedBrowserTimeMs: number; audioPositionAtReceiptMs: number; }
/** A webcam pose record as the recorder uploads it, anchored to the song audio clock. */
export interface PoseEnvelope extends EnvelopeTiming { audioPlaybackRate: number; audioPositionAtFrameMs: number; record: WebcamRecord; }
export interface EventEnvelope extends EnvelopeTiming { event: CaptureEvent; }
export type WebcamEnvelope = PoseEnvelope | EventEnvelope;
export interface VideoEnvelope { ordinal: number; record: VideoRecord; }

const DIFFICULTIES: readonly Difficulty[] = ["normal", "easy", "hard"];
const AUDIO_EXTENSIONS: readonly AudioExtension[] = ["mp3", "wav", "ogg", "m4a", "flac"];
const EDIT_TYPES: readonly EditType[] = ["joint", "swap", "mirror", "smooth", "repair", "exclude", "approve"];
const MARKER_KINDS: readonly Marker["kind"][] = ["beat", "phrase", "note"];
const ORIGINS: readonly LandmarkOrigin[] = ["measured", "resampled", "edited", "gap-repaired", "missing-confidence"];
const DELEGATES = ["GPU", "CPU"] as const;
const AXES = ["x", "y", "z"] as const;
const ID = /^[a-zA-Z0-9-]{1,80}$/;
const isId = (v: unknown): v is string => typeof v === "string" && ID.test(v);
const strings = (v: unknown) => isArray(v) && v.every((s) => typeof s === "string");
const point3 = (v: unknown): v is Point3 => isObject(v) && finite(v.x) && finite(v.y) && finite(v.z);
const isPlayerId = (v: unknown): v is number => v === 0 || v === 1;
const lastOf = <T>(items: readonly T[]): T => items[items.length - 1];

export function newProject(id?: string, schemaVersion?: 2): ProjectV2;
export function newProject(id: string, schemaVersion: 1): ProjectV1;
export function newProject(id: string = crypto.randomUUID(), schemaVersion: 1 | 2 = 2): Project {
  const now = new Date().toISOString();
  const metadata: ProjectMetadata = {
    title: "Untitled routine",
    artist: "",
    songwriters: [],
    choreographers: [],
    difficulty: "normal",
    stage: DEFAULT_STAGE,
    tags: [],
    bpm: null,
    description: "",
    rights: {
      audio: { license: "unknown", attribution: "" },
      choreography: { license: "unknown", attribution: "" },
    },
  };
  const head = {
    projectId: id,
    songId: `song-${id.slice(0, 8)}`,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    metadata,
    audio: null,
    durationMs: 0,
    playableStartMs: 0,
    playableEndMs: 0,
    takes: [],
  };
  const tail = { operationCursor: 0, markers: [], alignmentReviewed: false };
  const label = (playerId: number) => `Player ${playerId + 1}`;
  return schemaVersion === 1
    ? { schema: "aerodance.project", schemaVersion, ...head,
        tracks: [0, 1].map((playerId) => ({ playerId, label: label(playerId), clips: [] })), operations: [], ...tail }
    : { schema: "aerodance.project", schemaVersion, ...head,
        tracks: [0, 1].map((playerId) => ({ playerId, label: label(playerId), dataId: null, originalDataId: null, offsetMs: 0 })),
        operations: [], ...tail };
}
function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw Error(message);
}
const isTakeRef = (t: unknown): t is { takeId: string } => isObject(t) && isId(t.takeId);
const isJointTarget = (t: unknown): t is JointTarget =>
  isObject(t) && typeof t.joint === "number" && Number.isInteger(t.joint) && t.joint >= 0 && t.joint < 33 && point3(t.value);
/** Checks a stored project. Fills in the default stage for projects saved before songs had stages. */
export function assertProject(p: unknown): asserts p is Project {
  const version = isObject(p) ? p.schemaVersion ?? "unknown" : "unknown";
  assert(
    isObject(p) && p.schema === "aerodance.project" && (p.schemaVersion === 1 || p.schemaVersion === 2),
    `Unsupported project format ${version}. This editor supports project formats 1 and 2.`,
  );
  assert(isId(p.projectId), "Invalid project ID");
  assert(
    typeof p.songId === "string" && /^[a-z0-9][a-z0-9-]{0,79}$/.test(p.songId),
    "Song ID must use lowercase letters, digits and hyphens",
  );
  assert(
    typeof p.revision === "number" && Number.isSafeInteger(p.revision) && p.revision >= 0,
    "Invalid revision",
  );
  const m = p.metadata;
  assert(
    isObject(m) && typeof m.title === "string" && typeof m.artist === "string",
    "Missing title/artist",
  );
  assert(oneOf(DIFFICULTIES, m.difficulty), "Invalid difficulty");
  // Projects saved before songs had stages dance on the default one.
  m.stage ??= DEFAULT_STAGE;
  assert(isStageId(m.stage), "Choose one of the dance stages");
  assert(
    strings(m.songwriters) && strings(m.choreographers) && strings(m.tags),
    "Invalid credits/tags",
  );
  assert(m.bpm === null || (finite(m.bpm) && m.bpm > 0), "Invalid BPM");
  if (p.audio)
    assert(
      isObject(p.audio) &&
        typeof p.audio.sha256 === "string" &&
        /^[a-f0-9]{64}$/.test(p.audio.sha256) &&
        oneOf(AUDIO_EXTENSIONS, p.audio.extension),
      "Invalid audio asset reference",
    );
  assert(
    finite(p.durationMs) && p.durationMs >= 0 && p.durationMs <= 3600000,
    "Duration must be between zero and one hour",
  );
  assert(
    finite(p.playableStartMs) &&
      finite(p.playableEndMs) &&
      p.playableStartMs >= 0 &&
      p.playableEndMs >= p.playableStartMs &&
      p.playableEndMs <= p.durationMs,
    "Invalid playable range",
  );
  assert(
    isArray(p.tracks) &&
      p.tracks.length === 2 &&
      isObject(p.tracks[0]) && p.tracks[0].playerId === 0 &&
      isObject(p.tracks[1]) && p.tracks[1].playerId === 1,
    "Two ordered tracks required",
  );
  assert(
    isArray(p.takes) &&
      p.takes.every(isTakeRef) &&
      new Set(p.takes.map((t) => t.takeId)).size === p.takes.length,
    "Invalid takes",
  );
  const ids = new Set(p.takes.map((t) => t.takeId));
  for (const track of p.tracks) {
    if (p.schemaVersion === 2) {
      assertTrackRefs([track], false);
      continue;
    }
    assert(isObject(track) && isArray(track.clips) && track.clips.every(isObject), "Invalid clips");
    const spans = track.clips.map((c) => {
      assert(
        typeof c.takeId === "string" && ids.has(c.takeId) &&
          isPlayerId(c.sourcePlayerId) &&
          finite(c.sourceStartMs) && finite(c.sourceEndMs) && finite(c.songStartMs) && finite(c.timeScale) &&
          c.sourceEndMs > c.sourceStartMs &&
          c.timeScale > 0,
        "Invalid source clip",
      );
      return [c.songStartMs, c.songStartMs + (c.sourceEndMs - c.sourceStartMs) * c.timeScale] as const;
    }).sort((a, b) => a[0] - b[0]);
    let end = -Infinity;
    for (const [start, stop] of spans) {
      assert(start >= end, "Overlapping clips must be split first");
      end = stop;
    }
  }
  assert(
    isArray(p.operations) &&
      typeof p.operationCursor === "number" &&
      Number.isInteger(p.operationCursor) &&
      p.operationCursor >= 0 &&
      p.operationCursor <= p.operations.length,
    "Invalid edit history",
  );
  for (const op of p.operations) {
    if (p.schemaVersion === 2) {
      assert(isObject(op) && typeof op.type === "string", "Invalid history entry");
      assertTrackRefs(op.beforeTracks);
      assertTrackRefs(op.afterTracks);
      continue;
    }
    assert(isObject(op) && oneOf(EDIT_TYPES, op.type), "Unknown edit operation");
    assert(
      finite(op.startMs) && finite(op.endMs) && op.endMs >= op.startMs,
      "Invalid edit range",
    );
    assert(op.playerId === null || isPlayerId(op.playerId), "Invalid edit track");
    if (op.type === "joint")
      assert(
        typeof op.joint === "number" &&
          Number.isInteger(op.joint) &&
          op.joint >= 0 &&
          op.joint < 33 &&
          point3(op.value) &&
          finite(op.timeMs) &&
          op.timeMs >= op.startMs &&
          op.timeMs <= op.endMs,
        "Invalid joint keyframe",
      );
    if (op.type === "joint" && op.targets !== undefined) {
      const targets = op.targets;
      assert(
        isArray(targets) &&
          targets.length > 0 &&
          targets.length <= 33 &&
          targets.every(isJointTarget) &&
          new Set(targets.map((t) => t.joint)).size === targets.length,
        "Invalid grouped joint keyframe",
      );
    }
    if (op.type === "smooth")
      assert(
        finite(op.windowMs) && op.windowMs > 0 && op.windowMs <= 1000,
        "Invalid smoothing window",
      );
    if (op.type === "repair")
      assert(
        op.endMs - op.startMs <= 1000,
        "Repair at most one second; replace longer gaps with another take",
      );
    if (op.type === "exclude" || op.type === "approve")
      assert(
        typeof op.reason === "string" && op.reason.trim(),
        "Review decisions require a reason",
      );
  }
  assert(
    isArray(p.markers) &&
      p.markers.every(
        (m) =>
          isObject(m) &&
          finite(m.songTimeMs) &&
          oneOf(MARKER_KINDS, m.kind) &&
          typeof m.label === "string",
      ),
    "Invalid markers",
  );
}
export function validateProject(p: unknown): Project {
  assertProject(p);
  return p;
}
export function assertTake(take: unknown): asserts take is Take {
  assert(
    isObject(take) && take.schema === "aerodance.take" && take.schemaVersion === 1,
    "Unsupported take schema",
  );
  assert(isId(take.takeId), "Invalid take ID");
  const input = take.input;
  const dimension = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v > 0;
  assert(
    isObject(input) && dimension(input.width) && dimension(input.height) && input.mirrored === false,
    "Takes must use unmirrored inference geometry",
  );
  assert(
    isArray(take.samples) &&
      take.samples.length >= 2 &&
      take.samples.length <= 150000,
    "Expected between 2 and 150000 take samples",
  );
  let last = -Infinity;
  const players = new Set<number>();
  for (const s of take.samples) {
    assert(
      isObject(s) && finite(s.takeTimeMs) && s.takeTimeMs > last,
      "Take times must increase",
    );
    last = s.takeTimeMs;
    assertPoses(s.poses);
    for (const p of s.poses) players.add(p.playerId);
  }
  assert(
    finite(take.offsetMs) && finite(take.timeScale) && take.timeScale > 0,
    "Invalid take alignment",
  );
  if (take.calibrationFrame !== undefined) {
    const frame = take.calibrationFrame;
    const limit = (isObject(take.provenance) ? take.provenance.durationMs : undefined) ?? last;
    assert(isObject(frame) && finite(frame.mediaTimeMs) && frame.mediaTimeMs >= 0 &&
      typeof limit === 'number' && frame.mediaTimeMs <= limit, 'Invalid calibration frame time');
    assertPoses(frame.poses);
    assert(frame.poses.length && frame.poses.every(reliableBodyPose), 'Choose a calibration frame with shoulders, hips and feet clearly visible');
    const poses = frame.poses;
    assert([...players].every(id => poses.some(p => p.playerId === id)), 'Choose a calibration frame with every captured dancer clearly visible');
  }
  assert(take.source !== 'video' || take.calibrationFrame, 'Video takes require a calibration frame');
}
export function validateTake(take: unknown): Take {
  assertTake(take);
  return take;
}

export function takeCalibration(take: Take, playerId: number): TrackCalibration {
  return calibratePoses(take.calibrationFrame
    ? take.calibrationFrame.poses.filter(p => p.playerId === playerId)
    : take.samples.flatMap(s => s.poses.filter(p => p.playerId === playerId)), take.input,
  { adaptiveDistance: ['webcam', 'video'].includes(take.source) });
}
export function importMotion(
  data: unknown,
  name = "Imported take",
  id: string = crypto.randomUUID(),
): Take {
  const unsupported = "Import a legacy dance.json, choreography.json or take.json";
  assert(isObject(data), unsupported);
  let samples: StudioTakeSample[], input: unknown, source: string;
  if (data.version === 1 && data.times && data.poses) {
    const { times, poses: legacyPoses } = data;
    assert(
      isArray(times) && isArray(legacyPoses) &&
        times.length === legacyPoses.length && times.length >= 2,
      "Invalid legacy arrays",
    );
    input = {
      width: isObject(data.source) ? data.source.width : undefined,
      height: isObject(data.source) ? data.source.height : undefined,
      mirrored: false,
    };
    source = "legacy-demo";
    samples = times.map((time, i) => {
      const players = legacyPoses[i];
      assert(isArray(players) && players.length === 2, "Legacy recording needs two people");
      const legacyConfidence: number[][] = [];
      const poses = players.map((points, playerId) => {
        assert(isArray(points), "Invalid legacy joint");
        const confidence: number[] = [];
        legacyConfidence.push(confidence);
        return {
          playerId,
          landmarks: points.map((j) => {
            assert(isArray(j) && j.length === 4 && j.every(finite), "Invalid legacy joint");
            confidence.push(j[3]);
            return {
              x: j[0],
              y: j[1],
              z: j[2],
              confidence: null,
            };
          }),
        };
      });
      assert(finite(time), "Take times must increase");
      return {
        takeTimeMs: time * 1000,
        poses,
        quality: qualityFor(poses),
        legacyConfidence,
      };
    });
  } else if (data.schema === "aerodance.choreography") {
    const choreography = validateChoreography(data);
    const c = choreography.tracks[0].calibration;
    assert(
      choreography.tracks.every(
        (t) =>
          t.calibration.inputWidth === c.inputWidth &&
          t.calibration.inputHeight === c.inputHeight,
      ),
      "Import requires matching track dimensions",
    );
    input = { width: c.inputWidth, height: c.inputHeight, mirrored: false };
    source = "choreography";
    samples = choreography.samples.map((s) => ({
      takeTimeMs: s.songTimeMs,
      poses: copy(s.poses),
      quality: copy(s.quality),
    }));
  } else if (data.schema === "aerodance.take") {
    const take = copy(data);
    take.takeId = id;
    take.name = name;
    return validateTake(take);
  } else
    throw Error(unsupported);
  return validateTake({
    schema: "aerodance.take",
    schemaVersion: 1,
    takeId: id,
    name,
    source,
    input,
    samples,
    offsetMs: 0,
    timeScale: 1,
    createdAt: new Date().toISOString(),
    provenance: {
      source: data.source || null,
      model: data.model || null,
      legacySmoothed: source === "legacy-demo",
    },
  });
}
export function assertCaptureMetadata(metadata: unknown): asserts metadata is CaptureMetadata {
  const text = (v: unknown) => v === undefined || typeof v === 'string';
  assert(isObject(metadata) && typeof metadata.takeId === 'string' && text(metadata.name) && text(metadata.createdAt) &&
    (metadata.interruptionReason === null || text(metadata.interruptionReason)), 'Invalid capture metadata');
}
export function takeFromRecords(records: readonly unknown[], metadata: CaptureMetadata): Take {
  if (metadata.sourceKind === 'video') return videoTakeFromRecords(records, metadata);
  if (metadata.sourceKind === 'webcam') return webcamTakeFromRecords(records, metadata);
  throw Error('Unsupported capture source');
}
// Projects saved before webcam capture keep their stored "android" takes.
export const sourceLabel = (source: string) => source === 'android' ? 'legacy capture' : source;
export function webcamTakeFromRecords(records: readonly unknown[], metadata: CaptureMetadata): Take {
  const envelopes = records.filter(isObject).filter(e => e.record);
  assert(envelopes.length >= 2, 'Take needs at least two pose records');
  const first = envelopes[0], firstRecord = validateWebcamRecord(first.record);
  const input = firstRecord.input, session = firstRecord.sessionId;
  const model = poseModel(firstRecord.modelId), config = metadata.status;
  assert(isObject(config) && config.modelId === model.id && config.modelHash === model.sha256 &&
    config.packageVersion === MEDIAPIPE_VERSION && oneOf(DELEGATES, config.delegate), 'Invalid webcam model configuration');
  const rate = first.audioPlaybackRate;
  assert(finite(rate) && rate > 0, 'Invalid capture audio rate');
  const samples: StudioTakeSample[] = [];
  let lastSeq = 0, lastTime = -Infinity, lastBrowserTime = -Infinity, sequenceGaps = 0;
  for (const e of envelopes) {
    const r = validateWebcamRecord(e.record);
    assert(r.sessionId === session && r.modelId === model.id && r.playerCount === 2 &&
      r.input.width === input.width && r.input.height === input.height && e.audioPlaybackRate === rate,
    'Capture source/session/model/mode/geometry changed');
    assert(r.seq > lastSeq && r.mediaTimeMs > lastTime && r.frameBrowserTimeMs > lastBrowserTime &&
      finite(e.audioPositionAtFrameMs) && finite(e.receivedBrowserTimeMs) &&
      e.receivedBrowserTimeMs >= r.resultBrowserTimeMs, 'Invalid webcam frame/audio timing');
    if (lastSeq) sequenceGaps += Math.max(0, r.seq - lastSeq - 1);
    const t = r.mediaTimeMs - firstRecord.mediaTimeMs;
    const previous = samples.at(-1);
    if (previous && t - previous.takeTimeMs > 200)
      samples.push({ takeTimeMs: previous.takeTimeMs + 200, poses: [], quality: [] });
    samples.push({ takeTimeMs: t, poses: copy(r.poses), quality: qualityFor(r.poses), sourceSeq: r.seq });
    lastSeq = r.seq; lastTime = r.mediaTimeMs; lastBrowserTime = r.frameBrowserTimeMs;
  }
  return validateTake({ schema: 'aerodance.take', schemaVersion: 1, takeId: metadata.takeId,
    name: metadata.name || 'Webcam take', source: 'webcam', input, samples,
    offsetMs: first.audioPositionAtFrameMs, timeScale: rate, createdAt: metadata.createdAt,
    status: config, interruptionReason: metadata.interruptionReason || null,
    provenance: { sessionId: session, sequenceGaps, modelId: model.id, modelHash: model.sha256,
      packageVersion: config.packageVersion, delegate: config.delegate, thresholds: config.thresholds,
      sourceRateHz: (envelopes.length - 1) * 1000 / (lastTime - firstRecord.mediaTimeMs),
      alignmentMethod: 'browser-frame-audio-anchor', frameTimingMethod: 'browser-frame-observation',
      audioAnchor: config.audioAnchor, timingUncertaintyMs: null } });
}
const recordOf = (envelope: unknown) => isObject(envelope) ? envelope.record : undefined;
export function videoTakeFromRecords(records: readonly unknown[], metadata: CaptureMetadata): Take {
  assert(records.length >= 2 && records.length <= 150000, 'Take needs between 2 and 150000 video frames');
  const first = validateVideoRecord(recordOf(records[0])), config = metadata.status;
  const model = poseModel(first.modelId), input = first.input;
  assert(isObject(config) && config.modelId === model.id && config.modelHash === model.sha256 &&
    config.packageVersion === MEDIAPIPE_VERSION && oneOf(DELEGATES, config.delegate), 'Invalid video model configuration');
  const durationMs = config.durationMs;
  assert(finite(durationMs) && durationMs > 0 && durationMs <= 3600000, 'Invalid video duration');
  let lastTime = -Infinity, lastSeq = 0, seekTime = false;
  const samples = records.map((e): StudioTakeSample => {
    const r = validateVideoRecord(recordOf(e));
    assert(r.sessionId === first.sessionId && r.modelId === first.modelId &&
      r.input.width === input.width && r.input.height === input.height, 'Video source/session/model/geometry changed');
    assert(r.seq === lastSeq + 1 && r.mediaTimeMs > lastTime && r.mediaTimeMs <= durationMs, 'Invalid video frame sequence or timing');
    lastTime = r.mediaTimeMs; lastSeq = r.seq;
    if (r.timingMethod === 'seek-time') seekTime = true;
    return { takeTimeMs: r.mediaTimeMs, poses: copy(r.poses), quality: qualityFor(r.poses), sourceSeq: r.seq };
  });
  assert(samples.some(s => s.poses.length), 'No dancers detected in this video');
  const frame = metadata.calibrationFrame;
  return validateTake({ schema: 'aerodance.take', schemaVersion: 1, takeId: metadata.takeId,
    name: metadata.name || 'Video take', source: 'video', input, samples, offsetMs: 0, timeScale: 1,
    createdAt: metadata.createdAt, calibrationFrame: copy(frame), status: config,
    provenance: { sessionId: first.sessionId, modelId: model.id, modelHash: model.sha256,
      packageVersion: config.packageVersion, delegate: config.delegate, thresholds: config.thresholds,
      filename: config.filename, durationMs, targetRateHz: config.targetRateHz ?? 30,
      inferenceMethod: config.inferenceMethod || 'full-frame',
      calibrationFrameTimeMs: isObject(frame) ? frame.mediaTimeMs : undefined,
      sourceRateHz: (samples.length - 1) * 1000 / (lastTime - first.mediaTimeMs),
      alignmentMethod: 'video-time-zero', frameTimingMethod: seekTime ? 'seek-time' : 'decoded-frame' } });
}

export function addTake<P extends Project>(project: P, take: Take): P {
  const p = copy(project), q: Project = p;
  q.takes.push({
    takeId: take.takeId,
    name: take.name,
    source: take.source,
    input: take.input,
    ...(['webcam', 'video'].includes(take.source) ? { modelId: take.provenance?.modelId, sourceRateHz: take.provenance?.sourceRateHz } : {}),
  });
  const first = take.samples[0].takeTimeMs,
    last = lastOf(take.samples).takeTimeMs;
  if (!q.durationMs) {
    q.durationMs = Math.ceil(last);
    q.playableEndMs = q.durationMs;
  }
  if (q.schemaVersion === 1) {
    for (const track of q.tracks)
      if (!track.clips.length)
        track.clips.push({
          clipId: crypto.randomUUID(),
          takeId: take.takeId,
          sourcePlayerId: track.playerId,
          sourceStartMs: first,
          sourceEndMs: last,
          songStartMs: take.offsetMs + first * take.timeScale,
          timeScale: take.timeScale,
        });
    q.alignmentReviewed = false;
  }
  return p;
}
export function appendOperation(project: ProjectV2, operation: EditCommand, assets: StudioAssets): ProjectV2;
export function appendOperation(project: ProjectV1, operation: EditCommand, assets?: StudioAssets): ProjectV1;
export function appendOperation(project: Project, operation: EditCommand, assets?: StudioAssets): Project;
export function appendOperation(project: Project, operation: EditCommand, assets?: StudioAssets): Project {
  if (project.schemaVersion === 2)
    return editTracks(project, operation, assets);
  const p = copy(project);
  p.operations = p.operations.slice(0, p.operationCursor);
  p.operations.push({ operationId: crypto.randomUUID(), ...operation });
  p.operationCursor = p.operations.length;
  return p;
}
function trackAsset(assets: StudioAssets, dataId: string): TrackData {
  const data = assets.get(dataId);
  assert(data, "Missing track data");
  assert(isTrackData(data), "Invalid track snapshot");
  return data;
}
function takeAsset(assets: StudioAssets, takeId: string, missing = "Missing take"): Take {
  const take = assets.get(takeId);
  assert(take, missing);
  assert(isTake(take), "Unsupported take schema");
  return take;
}
function rawSample(p: Project, takes: StudioAssets, time: number): ChoreographySample {
  const poses: Pose[] = [],
    quality: PoseQuality[] = [];
  if (p.schemaVersion === 2) {
    for (const track of p.tracks) {
      if (!track.dataId) continue;
      const data = trackAsset(takes, track.dataId);
      const snapshot = sampleSnapshot(
        data.samples,
        time - track.offsetMs,
        "takeTimeMs",
      );
      poses.push(...snapshot.poses);
      quality.push(...snapshot.quality);
    }
    return { songTimeMs: time, poses, quality };
  }
  for (const track of p.tracks) {
    const clip = track.clips.find(
      (c) =>
        time >= c.songStartMs &&
        time <= c.songStartMs + (c.sourceEndMs - c.sourceStartMs) * c.timeScale,
    );
    if (!clip) continue;
    const take = takeAsset(takes, clip.takeId, "Missing source take");
    const sourceTime =
      clip.sourceStartMs + (time - clip.songStartMs) / clip.timeScale;
    const s = sampleSnapshot(take.samples, sourceTime, "takeTimeMs");
    const pose = s.poses.find((v) => v.playerId === clip.sourcePlayerId);
    if (!pose) continue;
    pose.playerId = track.playerId;
    const q = s.quality.find((v) => v.playerId === clip.sourcePlayerId);
    assert(q, "Missing pose quality");
    q.playerId = track.playerId;
    poses.push(pose);
    quality.push(q);
  }
  return { songTimeMs: time, poses, quality };
}
// What a compiled track draws on: its input frames, stored calibration and stored exclusions.
interface TrackSources {
  track: ClipTrack | Track;
  inputs: FrameSize[];
  calibration?: TrackCalibration;
  adaptiveDistance: boolean;
  exclusions: ReviewEdit[];
}
const isExclusion = (o: EditCommand): o is ReviewEdit => o.type === "exclude";
export function compileProject(
  project: Project,
  takes: StudioAssets,
  { fullTimeline = false, editOperation = null }: CompileOptions = {},
): CompiledChoreography {
  assertProject(project);
  const p = project,
    ops: readonly EditCommand[] =
      p.schemaVersion === 2
        ? editOperation
          ? [editOperation]
          : []
        : p.operations.slice(0, p.operationCursor),
    [start, end] = fullTimeline
      ? projectBounds(p, takes)
      : [p.playableStartMs, p.playableEndMs];
  if (!(end > start)) throw Error("Import a recording or audio first");
  const times = new Set([start, end]);
  for (let i = 1; start + (i * 1000) / 30 < end; i++)
    times.add(Number((start + (i * 1000) / 30).toFixed(6)));
  if (p.schemaVersion === 2) {
    for (const track of p.tracks) {
      if (!track.dataId) continue;
      const data = trackAsset(takes, track.dataId);
      assertTrackData(data);
      for (const sample of data.samples)
        times.add(Number((sample.takeTimeMs + track.offsetMs).toFixed(6)));
    }
  } else
    for (const track of p.tracks)
      for (const clip of track.clips) {
        const take = takeAsset(takes, clip.takeId);
        assertTake(take);
        for (const s of take.samples)
          if (
            s.takeTimeMs >= clip.sourceStartMs &&
            s.takeTimeMs <= clip.sourceEndMs
          )
            times.add(
              Number(
                (
                  clip.songStartMs +
                  (s.takeTimeMs - clip.sourceStartMs) * clip.timeScale
                ).toFixed(6),
              ),
            );
      }
  for (const op of ops)
    for (const t of [op.startMs, op.endMs, op.type === "joint" ? op.timeMs : undefined])
      if (finite(t)) times.add(t);
  const samples = [...times]
    .filter((t) => t >= start && t <= end)
    .sort((a, b) => a - b)
    .map((t) => rawSample(p, takes, t));
  for (const op of ops) {
    const before = op.type === "smooth" ? copy(samples) : null;
    let repair: { a: ChoreographySample; b: ChoreographySample; left: Pose; right: Pose; playerId: number } | undefined;
    if (op.type === "repair") {
      const id = op.playerId;
      const a = [...samples]
        .reverse()
        .find(
          (s) =>
            s.songTimeMs <= op.startMs &&
            s.poses.some((v) => v.playerId === id),
        );
      const b = samples.find(
        (s) =>
          s.songTimeMs >= op.endMs &&
          s.poses.some((v) => v.playerId === id),
      );
      const left = a?.poses.find((v) => v.playerId === id),
        right = b?.poses.find((v) => v.playerId === id);
      assert(
        id !== null &&
          a &&
          b &&
          left &&
          right &&
          b.songTimeMs > a.songTimeMs &&
          b.songTimeMs - a.songTimeMs <= 1000,
        "Gap repair needs two endpoint poses within one second",
      );
      repair = { a, b, left, right, playerId: id };
    }
    for (let si = 0; si < samples.length; si++) {
      const s = samples[si],
        time = s.songTimeMs;
      if (
        time < op.startMs ||
        (time >= op.endMs && !(op.type === "joint" && time === op.timeMs))
      )
        continue;
      if (op.type === "swap") {
        s.poses.forEach((v) => {
          v.playerId = 1 - v.playerId;
        });
        s.quality.forEach((v) => {
          v.playerId = 1 - v.playerId;
        });
        s.poses.sort((a, b) => a.playerId - b.playerId);
        s.quality.sort((a, b) => a.playerId - b.playerId);
        continue;
      }
      if (repair) {
        const { a, b, left, right, playerId } = repair,
          alpha = (time - a.songTimeMs) / (b.songTimeMs - a.songTimeMs);
        const repaired = {
          playerId,
          landmarks: left.landmarks.map((j, i) => ({
            x: j.x + (right.landmarks[i].x - j.x) * alpha,
            y: j.y + (right.landmarks[i].y - j.y) * alpha,
            z: j.z + (right.landmarks[i].z - j.z) * alpha,
            confidence: null,
          })),
        };
        const index = s.poses.findIndex((v) => v.playerId === playerId),
          q: PoseQuality = {
            playerId,
            landmarkOrigins: Array<LandmarkOrigin>(33).fill("gap-repaired"),
            scoreEligible: Array<boolean>(33).fill(false),
            reviewed: false,
          };
        if (index < 0) {
          s.poses.push(repaired);
          s.quality.push(q);
        } else {
          s.poses[index] = repaired;
          s.quality[index] = q;
        }
        s.poses.sort((a, b) => a.playerId - b.playerId);
        s.quality.sort((a, b) => a.playerId - b.playerId);
        continue;
      }
      for (let i = 0; i < s.poses.length; i++) {
        const pose = s.poses[i],
          q = s.quality[i];
        if (op.playerId !== null && pose.playerId !== op.playerId) continue;
        if (op.type === "joint") {
          const weight =
            time === op.timeMs
              ? 1
              : time < op.timeMs
                ? (time - op.startMs) / (op.timeMs - op.startMs)
                : (op.endMs - time) / (op.endMs - op.timeMs);
          for (const target of op.targets || [
            { joint: op.joint, value: op.value },
          ]) {
            for (const k of AXES)
              pose.landmarks[target.joint][k] +=
                (target.value[k] - pose.landmarks[target.joint][k]) *
                clamp(weight, 0, 1);
            q.landmarkOrigins[target.joint] = "edited";
            q.scoreEligible[target.joint] = false;
          }
          q.reviewed = false;
        }
        if (op.type === "mirror") {
          s.poses[i] = mirrorPose(pose);
          for (const [a, b] of PAIRS) {
            [q.landmarkOrigins[a], q.landmarkOrigins[b]] = [q.landmarkOrigins[b], q.landmarkOrigins[a]];
            [q.scoreEligible[a], q.scoreEligible[b]] = [q.scoreEligible[b], q.scoreEligible[a]];
          }
          q.landmarkOrigins.fill("edited");
          q.scoreEligible.fill(false);
          q.reviewed = false;
        }
        if (op.type === "exclude") q.scoreEligible.fill(false);
        if (op.type === "approve") {
          q.scoreEligible.fill(true);
          q.reviewed = true;
        }
        if (op.type === "smooth" && before) {
          const neighbors: Pose[] = [];
          for (let n = si; n >= 0; n--) {
            if (time - before[n].songTimeMs > op.windowMs / 2) break;
            const v = before[n].poses.find((v) => v.playerId === pose.playerId);
            if (!v) break;
            neighbors.push(v);
          }
          for (let n = si + 1; n < before.length; n++) {
            if (before[n].songTimeMs - time > op.windowMs / 2) break;
            const v = before[n].poses.find((v) => v.playerId === pose.playerId);
            if (!v) break;
            neighbors.push(v);
          }
          pose.landmarks.forEach((j, index) => {
            for (const key of AXES)
              j[key] =
                neighbors.reduce((sum, v) => sum + v.landmarks[index][key], 0) /
                neighbors.length;
          });
          q.landmarkOrigins.fill("edited");
          q.scoreEligible.fill(false);
          q.reviewed = false;
        }
      }
    }
  }
  // Exclusions always override approvals, irrespective of edit command order.
  for (const s of samples)
    for (const q of s.quality)
      if (
        ops.some(
          (o) =>
            o.type === "exclude" &&
            (o.playerId === null || o.playerId === q.playerId) &&
            s.songTimeMs >= o.startMs &&
            s.songTimeMs < o.endMs,
        )
      )
        q.scoreEligible.fill(false);
  const sources: TrackSources[] =
    p.schemaVersion === 2
      ? p.tracks.map((t) => {
          const data = t.dataId ? trackAsset(takes, t.dataId) : null;
          return {
            track: t,
            inputs: data ? [data.input] : [],
            calibration: data?.calibration,
            adaptiveDistance: Boolean(data && data.sources.length &&
              data.sources.every(s => s.source === "webcam")),
            exclusions: data
              ? data.exclusions.map((o) => ({
                  ...o,
                  startMs: o.startMs + t.offsetMs,
                  endMs: o.endMs + t.offsetMs,
                  type: "exclude" as const,
                  playerId: t.playerId,
                }))
              : [],
          };
        })
      : p.tracks.map((t) => {
          const clipTakes = t.clips.map((c) => takeAsset(takes, c.takeId));
          return {
            track: t,
            inputs: clipTakes.map((take) => take.input),
            adaptiveDistance: clipTakes.length > 0 && clipTakes.every(take => take.source === "webcam"),
            exclusions: [],
          };
        });
  const tracks: SongTrack[] = sources.map(({ track: t, inputs, calibration, adaptiveDistance, exclusions }) => {
    const input = inputs[0] || { width: 640, height: 480 };
    assert(
      inputs.every((v) => v.width === input.width && v.height === input.height),
      "Replacement takes must use the same camera dimensions",
    );
    return {
      playerId: t.playerId,
      label: t.label,
      calibration: calibration
        ? copy(calibration) : calibratePoses(
        samples.flatMap((s) =>
          s.poses.filter((v) => v.playerId === t.playerId),
        ),
        input,
        { adaptiveDistance },
      ),
      unscorableIntervals: [...exclusions, ...ops.filter(isExclusion)]
        .filter(
          (o) =>
            (o.playerId === null || o.playerId === t.playerId) &&
            o.endMs > start &&
            o.startMs < end,
        )
        .map((o) => ({
          startMs: Math.max(start, o.startMs),
          endMs: Math.min(end, o.endMs),
          reason: o.reason,
        })),
    };
  });
  const result: CompiledChoreography = {
    schema: "aerodance.choreography",
    schemaVersion: 1,
    songId: p.songId,
    durationMs: p.durationMs,
    playableStartMs: start,
    playableEndMs: end,
    coordinates: {
      kind: "mediapipe-image",
      landmarkCount: 33,
      ordering: "mediapipe-pose-33",
      xAxis: "right",
      yAxis: "down",
      zAxis: "away-from-camera",
      mirrored: false,
      depthUnit: "relative-image-width",
    },
    sampling: {
      targetRateHz: 30,
      maxInterpolationGapMs: 200,
      confidenceThreshold: 0.5,
    },
    tracks,
    samples,
    markers: p.markers,
    provenance: {
      compilerVersion: COMPILER_VERSION,
      projectRevision: p.revision,
      qualityPolicyVersion: 1,
      sources:
        p.schemaVersion === 2
          ? [
              ...new Map(
                p.tracks
                  .flatMap((t) => (t.dataId ? trackAsset(takes, t.dataId).sources : []))
                  .map((source) => [source.takeId, source] as const),
              ).values(),
            ]
          : p.takes.map((t) => {
              const take = takes.get(t.takeId), stored = isTake(take) ? take : undefined;
              return {
                takeId: t.takeId,
                source: t.source,
                sha256: stored?.sha256 || null,
                provenance: stored?.provenance || null,
              };
            }),
    },
  };
  // Stored exclusions always win, including after an explicit approval.
  for (const sample of result.samples)
    for (const q of sample.quality)
      if (
        tracks[q.playerId].unscorableIntervals.some(
          (o) => sample.songTimeMs >= o.startMs && sample.songTimeMs < o.endMs,
        )
      )
        q.scoreEligible.fill(false);
  if (!fullTimeline) assertChoreography(result);
  return result;
}
// Whether the intervals together cover [startMs, endMs]; adjacent or overlapping reviews count jointly.
// Compiled sample times are rounded to the microsecond and review bounds aren't, so allow that much.
const COVER_TOLERANCE_MS = 0.001;
export function intervalsCover(intervals: readonly { startMs: number; endMs: number }[], startMs: number, endMs: number): boolean {
  let reached = startMs;
  for (const x of [...intervals].sort((a, b) => a.startMs - b.startMs)) {
    if (x.startMs > reached + COVER_TOLERANCE_MS) break;
    reached = Math.max(reached, x.endMs);
    if (reached + COVER_TOLERANCE_MS >= endMs) return true;
  }
  return reached + COVER_TOLERANCE_MS >= endMs;
}
export function reviewReport(project: Project, data: CompiledChoreography): ReviewReport {
  const blockers: string[] = [],
    warnings: string[] = [],
    coverage: TrackCoverage[] = [];
  if (!project.audio) blockers.push("Import song audio");
  if (!project.metadata.artist.trim() || !project.metadata.title.trim())
    blockers.push("Add song title and artist");
  if (!project.alignmentReviewed)
    blockers.push("Review and confirm audio alignment");
  if (data.provenance.sources.some((s) => s.provenance?.synthetic === true))
    blockers.push(
      "Synthetic tracking takes cannot be published as song choreography",
    );
  for (const k of ["audio", "choreography"] as const)
    if (
      !project.metadata.rights?.[k]?.license?.trim() ||
      project.metadata.rights[k].license === "unknown"
    )
      blockers.push(`Resolve ${k} distribution rights`);
  for (const id of [0, 1]) {
    let missing = 0,
      eligible = 0,
      edited = 0,
      gapStart: number | null = null,
      unreviewedGap = 0;
    const excludes = data.tracks[id].unscorableIntervals;
    for (let i = 0; i < data.samples.length - 1; i++) {
      const s = data.samples[i],
        dt = data.samples[i + 1].songTimeMs - s.songTimeMs,
        pose = s.poses.find((v) => v.playerId === id),
        q = s.quality.find((v) => v.playerId === id);
      if (!pose) {
        missing += dt;
        if (gapStart === null) gapStart = s.songTimeMs;
        if (!intervalsCover(excludes, s.songTimeMs, s.songTimeMs + dt))
          unreviewedGap += dt;
      } else {
        if (
          gapStart !== null &&
          s.songTimeMs - gapStart > 200 &&
          unreviewedGap > 0
        )
          blockers.push(
            `Player ${id + 1}: review/exclude missing interval ${Math.round(gapStart)}–${Math.round(s.songTimeMs)} ms`,
          );
        gapStart = null;
        unreviewedGap = 0;
        assert(q, "Missing pose quality");
        if (q.scoreEligible.filter(Boolean).length >= 8) eligible += dt;
        if (q.landmarkOrigins.includes("edited")) edited += dt;
      }
    }
    if (
      gapStart !== null &&
      data.playableEndMs - gapStart > 200 &&
      unreviewedGap > 0
    )
      blockers.push(
        `Player ${id + 1}: review/exclude trailing missing interval`,
      );
    if (!eligible)
      blockers.push(
        `Player ${id + 1}: no eligible reference poses; review/approve references`,
      );
    coverage.push({
      playerId: id,
      missingMs: Math.round(missing),
      eligibleMs: Math.round(eligible),
      editedMs: Math.round(edited),
    });
    if (edited)
      warnings.push(
        `Player ${id + 1}: edited coordinates require visual review`,
      );
  }
  if (data.provenance.sources.some((t) => t.source === "legacy-demo"))
    warnings.push(
      "Legacy confidence fields cannot be reconstructed; approvals are explicit reference decisions",
    );
  if (
    data.provenance.sources.some(
      (s) => s.provenance?.alignmentMethod === "receipt-estimate",
    )
  )
    warnings.push(
      "Legacy capture timing is manually aligned; calibrated device-to-audio mapping is unavailable",
    );
  return { blockers: [...new Set(blockers)], warnings, coverage };
}
export function replaceRange(
  project: ProjectV1,
  playerId: number,
  take: Pick<Take, "takeId">,
  start: number,
  end: number,
  sourceStart: number,
  sourceEnd: number,
): ProjectV1 {
  assert(
    end > start && sourceEnd > sourceStart,
    "Choose nonempty source and destination ranges",
  );
  const p = copy(project),
    track = p.tracks[playerId],
    clips: Clip[] = [];
  for (const c of track.clips) {
    const cend =
      c.songStartMs + (c.sourceEndMs - c.sourceStartMs) * c.timeScale;
    if (cend <= start || c.songStartMs >= end) {
      clips.push(c);
      continue;
    }
    if (c.songStartMs < start)
      clips.push({
        ...c,
        clipId: crypto.randomUUID(),
        sourceEndMs: c.sourceStartMs + (start - c.songStartMs) / c.timeScale,
      });
    if (cend > end)
      clips.push({
        ...c,
        clipId: crypto.randomUUID(),
        sourceStartMs: c.sourceStartMs + (end - c.songStartMs) / c.timeScale,
        songStartMs: end,
      });
  }
  clips.push({
    clipId: crypto.randomUUID(),
    takeId: take.takeId,
    sourcePlayerId: playerId,
    sourceStartMs: sourceStart,
    sourceEndMs: sourceEnd,
    songStartMs: start,
    timeScale: (end - start) / (sourceEnd - sourceStart),
  });
  track.clips = clips.sort((a, b) => a.songStartMs - b.songStartMs);
  p.alignmentReviewed = false;
  return p;
}

// Track snapshots have no dependency on a library take. History only stores refs.
function assertTrackRefs(tracks: unknown, ordered = true): asserts tracks is Track[] {
  assert(
    isArray(tracks) && (!ordered || tracks.length === 2),
    "Invalid track state",
  );
  tracks.forEach((t, i) => {
    assert(
      isObject(t) &&
        isPlayerId(t.playerId) &&
        (!ordered || t.playerId === i) &&
        finite(t.offsetMs) &&
        Math.abs(t.offsetMs) <= 3600000 &&
        [t.dataId, t.originalDataId].every((id) => id === null || isId(id)),
      "Invalid track reference/offset",
    );
  });
}
export function trackDataIds(project: Project): string[] {
  if (project.schemaVersion !== 2) return [];
  return [
    ...new Set(
      [
        project.tracks,
        ...project.operations.flatMap((o) => [o.beforeTracks, o.afterTracks]),
      ]
        .flatMap((tracks) =>
          tracks.flatMap((t) => [t.dataId, t.originalDataId]),
        )
        .filter((id): id is string => Boolean(id)),
    ),
  ];
}
export function assertTrackData(data: unknown): asserts data is TrackData {
  assert(
    isObject(data) &&
      data.schema === "aerodance.track" &&
      data.schemaVersion === 1 &&
      isId(data.dataId) &&
      isPlayerId(data.playerId),
    "Invalid track snapshot",
  );
  const take = validateTake({
    ...data,
    schema: "aerodance.take",
    takeId: data.dataId,
    offsetMs: 0,
    timeScale: 1,
  });
  if (data.calibration !== undefined) {
    const c = data.calibration;
    assert(isObject(c) && c.profileVersion === 2 && c.cameraScaleMode === 'body-relative' &&
      c.inputWidth === take.input.width && c.inputHeight === take.input.height &&
      finite(c.torsoLength) && c.torsoLength > 0 && finite(c.bodyTorsoLength) && c.bodyTorsoLength > 0 &&
      finite(c.floorY) && point3(c.baseHip), 'Invalid track calibration');
  }
  const player = data.playerId;
  for (const sample of take.samples) {
    assert(
      sample.poses.every((p) => p.playerId === player),
      "Track contains another player",
    );
    const quality: unknown = sample.quality;
    assert(
      isArray(quality) && quality.length === sample.poses.length,
      "Missing track quality",
    );
    for (const q of quality)
      assert(
        isObject(q) &&
          q.playerId === player &&
          isArray(q.landmarkOrigins) &&
          q.landmarkOrigins.length === 33 &&
          q.landmarkOrigins.every((v) => oneOf(ORIGINS, v)) &&
          isArray(q.scoreEligible) &&
          q.scoreEligible.length === 33 &&
          q.scoreEligible.every((v) => typeof v === "boolean") &&
          typeof q.reviewed === "boolean",
        "Invalid track quality",
      );
  }
  assert(
    isArray(data.sources) &&
      data.sources.every((s) => isObject(s) && isId(s.takeId)),
    "Invalid track provenance",
  );
  assert(
    isArray(data.exclusions) &&
      data.exclusions.every(
        (o) =>
          isObject(o) &&
          finite(o.startMs) &&
          finite(o.endMs) &&
          o.endMs >= o.startMs &&
          typeof o.reason === "string",
      ),
    "Invalid track exclusions",
  );
}
export function validateTrackData(data: unknown): TrackData {
  assertTrackData(data);
  return data;
}
function trackSnapshot(
  playerId: number,
  input: CaptureInput,
  samples: TrackSample[],
  sources: SourceRef[],
  exclusions: ScoreExclusion[] = [],
  calibration?: TrackCalibration,
): TrackData {
  return validateTrackData({
    schema: "aerodance.track",
    schemaVersion: 1,
    dataId: crypto.randomUUID(),
    playerId,
    input: copy(input),
    samples,
    sources: copy(sources),
    exclusions: copy(exclusions),
    ...(calibration ? { calibration: copy(calibration) } : {}),
  });
}
function recordTrackChange(project: ProjectV2, tracks: Track[], operation: TrackCommand): ProjectV2 {
  const p = copy(project);
  p.operations = p.operations.slice(0, p.operationCursor);
  p.operations.push({
    ...operation,
    operationId: crypto.randomUUID(),
    beforeTracks: copy(p.tracks),
    afterTracks: copy(tracks),
  });
  p.operationCursor = p.operations.length;
  p.tracks = tracks;
  if (operation.type !== "approve" && operation.type !== "exclude")
    p.alignmentReviewed = false;
  return p;
}
export function historyStep<P extends Project>(project: P, delta: number): P {
  const p = copy(project),
    q: Project = p,
    cursor = clamp(q.operationCursor + delta, 0, q.operations.length);
  if (q.schemaVersion === 2 && cursor !== q.operationCursor)
    q.tracks = copy(
      delta < 0
        ? q.operations[cursor].beforeTracks
        : q.operations[cursor - 1].afterTracks,
    );
  q.operationCursor = cursor;
  q.alignmentReviewed = false;
  return p;
}
export function overwriteTracks(project: ProjectV2, take: Take, playerIds: readonly number[], assets: StudioAssets): ProjectV2 {
  assertTake(take);
  assert(
    playerIds.length > 0 &&
      playerIds.every(
        (id) =>
          isPlayerId(id) &&
          take.samples.some((s) => s.poses.some((p) => p.playerId === id)),
      ),
    "Take has no poses for the requested player",
  );
  const tracks = copy(project.tracks);
  for (const id of playerIds) {
    const samples = take.samples.map((s) => ({
      takeTimeMs: s.takeTimeMs * take.timeScale,
      poses: copy(s.poses.filter((p) => p.playerId === id)),
      quality: copy(
        (s.quality || qualityFor(s.poses)).filter((q) => q.playerId === id),
      ),
    }));
    const data = trackSnapshot(id, take.input, samples, [
      {
        takeId: take.takeId,
        name: take.name,
        source: take.source,
        sha256: take.sha256 || null,
        provenance: take.provenance || null,
      },
    ], [], take.calibrationFrame ? takeCalibration(take, id) : undefined);
    assets.set(data.dataId, data);
    tracks[id] = {
      ...tracks[id],
      dataId: data.dataId,
      originalDataId: data.dataId,
      offsetMs: take.offsetMs,
    };
  }
  return recordTrackChange(project, tracks, {
    type: "overwrite",
    playerId: playerIds.length === 2 ? null : playerIds[0],
  });
}
export function clearTrack(project: ProjectV2, playerId: number): ProjectV2 {
  const tracks = copy(project.tracks);
  tracks[playerId] = {
    ...tracks[playerId],
    dataId: null,
    originalDataId: null,
    offsetMs: 0,
  };
  return recordTrackChange(project, tracks, { type: "clear", playerId });
}
export function offsetTrack(project: ProjectV2, playerId: number, offsetMs: number): ProjectV2 {
  assert(
    finite(offsetMs) && Math.abs(offsetMs) <= 3600000,
    "Offset must be finite and within one hour",
  );
  const tracks = copy(project.tracks);
  tracks[playerId].offsetMs = offsetMs;
  return recordTrackChange(project, tracks, { type: "offset", playerId });
}
function projectBounds(project: Project, assets: StudioAssets): [number, number] {
  let start = 0,
    end = project.durationMs;
  if (project.schemaVersion === 2) {
    for (const t of project.tracks)
      if (t.dataId) {
        const data = trackAsset(assets, t.dataId);
        start = Math.min(start, data.samples[0].takeTimeMs + t.offsetMs);
        end = Math.max(end, lastOf(data.samples).takeTimeMs + t.offsetMs);
      }
  } else
    for (const t of project.tracks)
      for (const c of t.clips) {
        start = Math.min(start, c.songStartMs);
        end = Math.max(
          end,
          c.songStartMs + (c.sourceEndMs - c.sourceStartMs) * c.timeScale,
        );
      }
  return [start, end];
}
function storeEditedTracks(
  project: ProjectV2,
  assets: StudioAssets,
  data: CompiledChoreography,
  playerIds: readonly number[],
  operation: TrackCommand,
): ProjectV2 {
  const tracks = copy(project.tracks);
  for (const id of playerIds) {
    const track = tracks[id],
      stored = track.dataId ? assets.get(track.dataId) : undefined,
      previous = isTrackData(stored) ? stored : undefined;
    const samples = data.samples.map((s) => ({
      takeTimeMs: s.songTimeMs - track.offsetMs,
      poses: copy(s.poses.filter((p) => p.playerId === id)),
      quality: copy(s.quality.filter((q) => q.playerId === id)),
    }));
    const sources =
      operation.type === "swap"
        ? [
            ...new Map(
              project.tracks
                .flatMap((t) => (t.dataId ? trackAsset(assets, t.dataId).sources : []))
                .map((s) => [s.takeId, s] as const),
            ).values(),
          ]
        : previous?.sources || [];
    const input = previous?.input || {
      width: 640,
      height: 480,
      mirrored: false,
    };
    const snapshot = trackSnapshot(
      id,
      input,
      samples,
      sources,
      data.tracks[id].unscorableIntervals.map((o) => ({
        ...o,
        startMs: o.startMs - track.offsetMs,
        endMs: o.endMs - track.offsetMs,
      })),
      previous?.calibration,
    );
    assets.set(snapshot.dataId, snapshot);
    track.dataId = snapshot.dataId;
  }
  return recordTrackChange(project, tracks, operation);
}
function editTracks(project: ProjectV2, operation: EditCommand, assets: StudioAssets | undefined): ProjectV2 {
  assert(assets instanceof Map, "Track assets are required for editing");
  // Apply the existing editing algorithms to the entire retained timeline, then
  // save independent snapshots. Negative/out-of-range poses remain recoverable.
  const data = compileProject(project, assets, {
    fullTimeline: true,
    editOperation: operation,
  });
  return storeEditedTracks(
    project,
    assets,
    data,
    operation.playerId === null ? [0, 1] : [operation.playerId],
    operation,
  );
}
export function missingIntervals(project: Project, assets: StudioAssets, playerId: number): Interval[] {
  const data = compileProject(project, assets),
    gaps: Interval[] = [];
  let left: number | null = null,
    missing = false;
  for (const s of data.samples) {
    const present = s.poses.some((p) => p.playerId === playerId);
    if (present) {
      if (missing && left !== null)
        gaps.push({ startMs: left, endMs: s.songTimeMs });
      left = s.songTimeMs;
      missing = false;
    } else missing = true;
  }
  return gaps;
}
export function interpolateTrack(project: ProjectV2, assets: StudioAssets, playerId: number): { project: ProjectV2; filled: number } {
  const gaps = missingIntervals(project, assets, playerId);
  assert(gaps.length, "No bounded missing intervals to interpolate");
  const data = compileProject(project, assets, { fullTimeline: true });
  for (const gap of gaps) {
    const left = rawSample(project, assets, gap.startMs).poses.find(
      (p) => p.playerId === playerId,
    );
    const right = rawSample(project, assets, gap.endMs).poses.find(
      (p) => p.playerId === playerId,
    );
    assert(left && right, "No bounded missing intervals to interpolate");
    for (const s of data.samples) {
      if (
        s.songTimeMs <= gap.startMs ||
        s.songTimeMs >= gap.endMs ||
        s.poses.some((p) => p.playerId === playerId)
      )
        continue;
      const alpha = (s.songTimeMs - gap.startMs) / (gap.endMs - gap.startMs);
      s.poses.push({
        playerId,
        landmarks: left.landmarks.map((j, i) => ({
          x: j.x + (right.landmarks[i].x - j.x) * alpha,
          y: j.y + (right.landmarks[i].y - j.y) * alpha,
          z: j.z + (right.landmarks[i].z - j.z) * alpha,
          confidence: null,
        })),
      });
      s.quality.push({
        playerId,
        landmarkOrigins: Array<LandmarkOrigin>(33).fill("gap-repaired"),
        scoreEligible: Array<boolean>(33).fill(false),
        reviewed: false,
      });
      s.poses.sort((a, b) => a.playerId - b.playerId);
      s.quality.sort((a, b) => a.playerId - b.playerId);
    }
  }
  return {
    project: storeEditedTracks(project, assets, data, [playerId], {
      type: "interpolate",
      playerId,
    }),
    filled: gaps.length,
  };
}
export function migrateProject(project: Project, assets: StudioAssets): ProjectV2 {
  if (project.schemaVersion === 2) return project;
  const p = copy(project);
  const raw =
    project.durationMs > 0
      ? compileProject({ ...p, operations: [], operationCursor: 0 }, assets, {
          fullTimeline: true,
        })
      : null;
  const current =
    project.durationMs > 0
      ? compileProject(p, assets, { fullTimeline: true })
      : null;
  const next: ProjectV2 = {
    ...p,
    schemaVersion: 2,
    operations: [],
    operationCursor: 0,
    tracks: project.tracks.map((t) => {
      const track: Track = {
        playerId: t.playerId,
        label: t.label,
        dataId: null,
        originalDataId: null,
        offsetMs: 0,
      };
      if (!t.clips.length) return track;
      const input = takeAsset(assets, t.clips[0].takeId).input;
      for (const [key, data] of [
        ["originalDataId", raw],
        ["dataId", current],
      ] as const) {
        assert(data, "Import a recording or audio first");
        const snapshot = trackSnapshot(
          t.playerId,
          input,
          data.samples.map((s) => ({
            takeTimeMs: s.songTimeMs,
            poses: copy(s.poses.filter((p) => p.playerId === t.playerId)),
            quality: copy(s.quality.filter((q) => q.playerId === t.playerId)),
          })),
          data.provenance.sources,
          data.tracks[t.playerId].unscorableIntervals,
        );
        assets.set(snapshot.dataId, snapshot);
        track[key] = snapshot.dataId;
      }
      return track;
    }),
  };
  assertProject(next);
  return next;
}
