// Raw capture records earlier editors stored as records.ndjson (JSON envelopes), read only to
// convert them to capture files when a project or backup is opened.
import { EXTENSION, buildFrames, decodePoseFile, encodePoseFile } from "../../packages/pose/binary.ts";
import type { FileCaptureEvent, FrameInput, PoseHeaderInput } from "../../packages/pose/binary.ts";
import { assertPoses, isObject, oneOf } from "../../packages/pose/choreography.ts";
import type { CaptureInput, Pose } from "../../packages/pose/choreography.ts";
import { poseModel } from "../../packages/pose/browser/models.ts";
import type { PoseModelId } from "../../packages/pose/browser/models.ts";
import { validateWebcamRecord } from "../../packages/pose/webcamRecord.ts";
import type { CalibrationFrame } from "./core.ts";
import { WEBCAM_EXTENSIONS } from "./poseFiles.ts";

/** One video-import tracking result, as earlier editors uploaded it. */
export interface VideoRecord {
  schema: "aerodance.video-record"; schemaVersion: 1; type: "pose";
  sessionId: string; seq: number; playerCount: 2;
  /** Always unmirrored. */
  input: CaptureInput;
  modelId: PoseModelId;
  mediaTimeMs: number; timingMethod: "decoded-frame" | "seek-time";
  poses: Pose[];
}
const TIMING_METHODS: readonly VideoRecord["timingMethod"][] = ["decoded-frame", "seek-time"];
const atLeast = (n: unknown, min: number) => typeof n === "number" && Number.isSafeInteger(n) && n >= min;
function assertVideoRecord(record: unknown): asserts record is VideoRecord {
  if (!isObject(record) || record.schema !== "aerodance.video-record" || record.schemaVersion !== 1 || record.type !== "pose" ||
      typeof record.sessionId !== "string" || !record.sessionId.trim() ||
      !atLeast(record.seq, 1) || record.playerCount !== 2 ||
      !isObject(record.input) || !atLeast(record.input.width, 1) ||
      !atLeast(record.input.height, 1) || record.input.mirrored !== false ||
      typeof record.mediaTimeMs !== "number" || !Number.isFinite(record.mediaTimeMs) || record.mediaTimeMs < 0 || record.mediaTimeMs > 3600000 ||
      !oneOf(TIMING_METHODS, record.timingMethod)) throw Error("Invalid video capture record");
  poseModel(record.modelId);
  assertPoses(record.poses);
}
export function validateVideoRecord(record: unknown): VideoRecord {
  assertVideoRecord(record);
  return record;
}
const frameSize = (input: { width: number; height: number }) => ({ width: input.width, height: input.height });

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
