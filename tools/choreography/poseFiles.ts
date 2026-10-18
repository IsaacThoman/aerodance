// Studio's stored pose data as .adpose files: library takes, track snapshots and raw captures.
// Take metadata that isn't skeletal lives in the project's TakeSummary (docs/pose-binary-format.md).
import {
  EXTENSION,
  PoseFileWriter,
  buildFrames,
  decodePoseFile,
  encodePoseFile,
  framesFromSamples,
  framesToPoses,
  framesToSamples,
  sparseSamples,
} from "../../packages/pose/binary.ts";
import type { FileCaptureEvent, FrameInput, PoseFrames, PoseHeaderInput } from "../../packages/pose/binary.ts";
import { finite, isArray, isObject } from "../../packages/pose/choreography.ts";
import type { FrameSize } from "../../packages/pose/choreography.ts";
import { isPoseModelId } from "../../packages/pose/browser/models.ts";
import type { PoseModelId } from "../../packages/pose/browser/models.ts";
import { validateVideoRecord } from "../../packages/pose/videoRecord.ts";
import { validateWebcamRecord } from "../../packages/pose/webcamRecord.ts";
import type { CalibrationFrame, SourceRef, Take, TakeSummary, TrackData } from "./core.ts";

/** Track snapshots drop interpolable frames no further apart than the sampler bridges. */
const TRACK_MAX_GAP_MS = 200;
const WEBCAM_EXTENSIONS = [
  EXTENSION.frameBrowserTimeMs, EXTENSION.resultBrowserTimeMs, EXTENSION.receivedBrowserTimeMs,
  EXTENSION.audioPositionAtFrameMs, EXTENSION.audioPositionAtReceiptMs,
];
// An empty FRMS chunk, appended so a header plus event-only batch decodes as a file.
const EMPTY_FRAMES = new Uint8Array([0x46, 0x52, 0x4d, 0x53, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { result.set(p, at); at += p.length; }
  return result;
}
const frameSize = (input: FrameSize) => ({ width: input.width, height: input.height });
const captureInput = (f: PoseFrames) => ({ width: f.input.width, height: f.input.height, mirrored: false as const });
const modelOf = (provenance: unknown): PoseModelId | null =>
  isObject(provenance) && isPoseModelId(provenance.modelId) ? provenance.modelId : null;
function decodeKind(bytes: Uint8Array, kind: PoseFrames["kind"]): PoseFrames {
  const f = decodePoseFile(bytes);
  if (f.kind !== kind) throw Error(`Expected a ${kind} file, not a ${f.kind}`);
  return f;
}

export function encodeTake(take: Take): Uint8Array<ArrayBuffer> {
  const frame = take.calibrationFrame;
  return encodePoseFile(framesFromSamples({
    kind: "take", playerSlots: 2, input: frameSize(take.input), modelId: modelOf(take.provenance),
    ...(take.provenance == null ? {} : { provenance: take.provenance }),
  }, take.samples, "takeTimeMs", frame ? { calibrationFrame: { timeMs: frame.mediaTimeMs, poses: frame.poses } } : {}));
}
/** The take a file holds, with the metadata its project summary keeps; unvalidated. */
export function decodeTake(bytes: Uint8Array, summary: TakeSummary): Take {
  const f = decodeKind(bytes, "take"), calibration = f.calibrationFrame;
  return {
    schema: "aerodance.take", schemaVersion: 1,
    takeId: summary.takeId, name: summary.name, source: summary.source,
    input: captureInput(f),
    samples: framesToSamples(f, "takeTimeMs"),
    offsetMs: summary.offsetMs, timeScale: summary.timeScale,
    ...(summary.createdAt === undefined ? {} : { createdAt: summary.createdAt }),
    ...(calibration ? { calibrationFrame: { mediaTimeMs: calibration.times[0], poses: framesToPoses(calibration, 0).poses } } : {}),
    ...(summary.status === undefined ? {} : { status: summary.status }),
    ...(summary.interruptionReason === undefined ? {} : { interruptionReason: summary.interruptionReason }),
    provenance: isObject(f.provenance) ? f.provenance : null,
    sha256: summary.sha256,
  };
}

export function encodeTrack(data: TrackData): Uint8Array<ArrayBuffer> {
  return encodePoseFile(framesFromSamples({
    kind: "track", playerSlots: 1, input: frameSize(data.input), modelId: null,
    tracks: [{ slot: 0, playerId: data.playerId, label: "", calibration: data.calibration ?? null, exclusions: data.exclusions }],
    provenance: { dataId: data.dataId, sources: data.sources },
  }, sparseSamples(data.samples, "takeTimeMs", TRACK_MAX_GAP_MS), "takeTimeMs"));
}
/** The track snapshot a file holds; unvalidated. */
export function decodeTrack(bytes: Uint8Array): TrackData {
  const f = decodeKind(bytes, "track"), track = f.tracks![0], prov = f.provenance;
  if (!isObject(prov) || typeof prov.dataId !== "string" || !isArray(prov.sources)) throw Error("Track file has no snapshot provenance");
  return {
    schema: "aerodance.track", schemaVersion: 1,
    dataId: prov.dataId, playerId: track.playerId, input: captureInput(f),
    samples: framesToSamples(f, "takeTimeMs"),
    sources: prov.sources as SourceRef[],
    exclusions: track.exclusions,
    ...(track.calibration ? { calibration: track.calibration } : {}),
  };
}
/** The stored form of a snapshot: quantized, with interpolable frames dropped. */
export const storedTrack = (data: TrackData): TrackData => decodeTrack(encodeTrack(data));

/** What a recorder or video importer declares when a capture starts; constant for the whole capture. */
export interface CaptureStart {
  sourceKind: "webcam" | "video";
  sessionId: string;
  input: FrameSize;
  playerCount: 1 | 2;
  modelId: PoseModelId;
  /** Webcam: the song playback rate. */
  audioPlaybackRate: number | null;
  /** Webcam: the clock values the extension fields count from, in WEBCAM_EXTENSIONS order. */
  extensionBases: number[];
}
const dimension = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 0xffff;
/** The capture file header for a validated start request. */
export function captureHeader(start: unknown): PoseHeaderInput {
  if (!isObject(start) || (start.sourceKind !== "webcam" && start.sourceKind !== "video") ||
    typeof start.sessionId !== "string" || !start.sessionId.trim() || start.sessionId.length > 200 ||
    !isObject(start.input) || !dimension(start.input.width) || !dimension(start.input.height) ||
    !isPoseModelId(start.modelId)) throw Error("Invalid capture header");
  const webcam = start.sourceKind === "webcam", bases = start.extensionBases;
  if (webcam
    ? !(start.playerCount === 1 || start.playerCount === 2) || !finite(start.audioPlaybackRate) || start.audioPlaybackRate <= 0 ||
      !isArray(bases) || bases.length !== WEBCAM_EXTENSIONS.length || !bases.every(finite)
    : start.playerCount !== 2 || start.audioPlaybackRate !== null || !isArray(bases) || bases.length)
    throw Error("Invalid capture header");
  return {
    kind: "capture", playerSlots: start.playerCount as 1 | 2, input: { width: start.input.width as number, height: start.input.height as number },
    modelId: start.modelId,
    extensionIds: webcam ? WEBCAM_EXTENSIONS : [], extensionBases: bases as number[],
    capture: { sourceKind: start.sourceKind, sessionId: start.sessionId, audioPlaybackRate: webcam ? start.audioPlaybackRate as number : null },
  };
}
/** The header chunks of a capture file; a video capture adds its calibration frame when finalized. */
export function captureHead(start: unknown, calibrationFrame?: CalibrationFrame): Uint8Array<ArrayBuffer> {
  return new PoseFileWriter(captureHeader(start)).start(calibrationFrame && { timeMs: calibrationFrame.mediaTimeMs, poses: calibrationFrame.poses });
}
/** The chunk tags in a run of chunks, without validating their contents. */
export function chunkTags(bytes: Uint8Array): string[] {
  const tags: string[] = [], view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 0; at < bytes.length;) {
    if (bytes.length - at < 8) throw Error("Invalid pose file: truncated");
    const length = view.getUint32(at + 4, true);
    tags.push(String.fromCharCode(...bytes.subarray(at, at + 4)));
    at += 8 + length + (8 - length % 8) % 8;
  }
  return tags;
}
/** Decodes an upload batch, checking it holds only frame and event chunks valid after the capture header. */
export function decodeCaptureBatch(head: Uint8Array, batch: Uint8Array): PoseFrames {
  if (!batch.length || chunkTags(batch).some(tag => tag !== "FRMS" && tag !== "EVNT")) throw Error("Invalid record batch");
  return decodePoseFile(concatBytes([head, batch, EMPTY_FRAMES]));
}

/**
 * Converts a capture stored by earlier editors (records.ndjson of JSON envelopes) to a capture
 * file. Throws when the records can't be represented, such as a rate change mid-capture.
 */
export function legacyCaptureFile(text: string, sourceKind: unknown, calibrationFrame?: CalibrationFrame): Uint8Array<ArrayBuffer> {
  const envelopes: unknown[] = text.split("\n").filter(line => line.trim()).map(line => JSON.parse(line));
  const frames: FrameInput[] = [], events: FileCaptureEvent[] = [];
  let header: PoseHeaderInput | undefined;
  for (const e of envelopes) {
    if (!isObject(e)) throw Error("Invalid capture record");
    if (sourceKind === "video") {
      const r = validateVideoRecord(e.record);
      header ??= { kind: "capture", playerSlots: 2, input: frameSize(r.input), modelId: r.modelId,
        capture: { sourceKind: "video", sessionId: r.sessionId, audioPlaybackRate: null } };
      frames.push({ timeMs: r.mediaTimeMs, poses: r.poses, seq: r.seq, seekTime: r.timingMethod === "seek-time" });
      continue;
    }
    if (sourceKind !== "webcam") throw Error("Unsupported capture source");
    const timing = { receivedBrowserTimeMs: Number(e.receivedBrowserTimeMs), audioPositionAtReceiptMs: Number(e.audioPositionAtReceiptMs) };
    if (!e.record) {
      if (!isObject(e.event)) throw Error("Invalid capture event");
      events.push({ ...e.event, ...timing, frameIndex: frames.length } as FileCaptureEvent);
      continue;
    }
    const r = validateWebcamRecord(e.record);
    header ??= { kind: "capture", playerSlots: r.playerCount, input: frameSize(r.input), modelId: r.modelId,
      extensionIds: WEBCAM_EXTENSIONS, capture: { sourceKind: "webcam", sessionId: r.sessionId, audioPlaybackRate: Number(e.audioPlaybackRate) } };
    if (e.audioPlaybackRate !== header.capture?.audioPlaybackRate || r.sessionId !== header.capture?.sessionId)
      throw Error("Capture rate or session changed");
    frames.push({ timeMs: r.mediaTimeMs, poses: r.poses, seq: r.seq, extensions: {
      [EXTENSION.frameBrowserTimeMs]: r.frameBrowserTimeMs, [EXTENSION.resultBrowserTimeMs]: r.resultBrowserTimeMs,
      [EXTENSION.receivedBrowserTimeMs]: timing.receivedBrowserTimeMs, [EXTENSION.audioPositionAtFrameMs]: Number(e.audioPositionAtFrameMs),
      [EXTENSION.audioPositionAtReceiptMs]: timing.audioPositionAtReceiptMs,
    } });
  }
  if (!header) throw Error("Capture has no pose records");
  const frame = sourceKind === "video" ? calibrationFrame : undefined;
  const bytes = encodePoseFile(buildFrames(header, frames, {
    events, ...(frame ? { calibrationFrame: { timeMs: frame.mediaTimeMs, poses: frame.poses } } : {}),
  }));
  decodePoseFile(bytes);
  return bytes;
}

/** A take or song choreography file imported into the library; unvalidated. */
export function importedPoseFile(bytes: Uint8Array, name: string, takeId: string = crypto.randomUUID()): Take {
  const f = decodePoseFile(bytes), createdAt = new Date().toISOString();
  if (f.kind === "take") {
    // The menu capture keeps the legacy demo's provenance, so review still flags it.
    const source = isObject(f.provenance) && f.provenance.legacySmoothed === true ? "legacy-demo" : "imported";
    return decodeTake(bytes, { takeId, name, source, input: captureInput(f), offsetMs: 0, timeScale: 1, createdAt });
  }
  if (f.kind !== "choreography") throw Error("Import a take or choreography .adpose file");
  return {
    schema: "aerodance.take", schemaVersion: 1, takeId, name, source: "choreography", input: captureInput(f),
    samples: framesToSamples(f, "songTimeMs").map(({ songTimeMs, ...s }) => ({ takeTimeMs: songTimeMs, ...s })),
    offsetMs: 0, timeScale: 1, createdAt,
    provenance: { songId: f.song!.songId, compiled: f.provenance ?? null },
  };
}
