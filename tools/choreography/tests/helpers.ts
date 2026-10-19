// Shared by the Dance Studio tests (not a test file itself).
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { Locator, Page } from "playwright";
import { isObject, qualityFor } from "../../../packages/pose/choreography.ts";
import type { Pose, TimedPoses, TrackCalibration } from "../../../packages/pose/choreography.ts";
import { DEFAULT_POSITION_STEP, EXTENSION, buildFrames, decodePoseFile, encodePoseFile, framesToPoses } from "../../../packages/pose/binary.ts";
import type { FrameInput, PoseFrames, PoseHeaderInput } from "../../../packages/pose/binary.ts";
import { isPoseModelId } from "../../../packages/pose/browser/models.ts";
import { validateProject, validateTake } from "../core.ts";
import type { CalibrationFrame, ProjectV3 } from "../core.ts";
import { WEBCAM_EXTENSIONS, captureHead, decodeCaptureBatch } from "../poseFiles.ts";

/** Waits for a locator to match exactly `count` elements: the UI renders after the action that triggers it. */
export async function expectCount(locator: Locator, count: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let actual = await locator.count();
  while (actual !== count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    actual = await locator.count();
  }
  assert.equal(actual, count);
}

/** The value, failing the test when it is missing. */
export function found<T>(value: T | null | undefined): T {
  assert.ok(value != null);
  return value;
}
/** The value at a path inside untrusted JSON, or undefined. */
export function read(value: unknown, ...keys: (string | number)[]): unknown {
  for (const key of keys) value = isObject(value) ? value[key] : undefined;
  return value;
}
/** A test double for a DOM or platform type: only the members the code under test uses are provided. */
export const fake = <T>(value: object) => value as T;

/** The origin of a server listening on 127.0.0.1. */
export function baseUrl(server: Server): string {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}
/** A project the API returned; the server always returns format 3. */
export async function projectOf(response: Response): Promise<ProjectV3> {
  const p = validateProject(await response.json());
  assert.ok(p.schemaVersion === 3);
  return p;
}
export const takeOf = async (response: Response) => validateTake(await response.json());
/** A JSON file from an exported ZIP. */
export const zipJson = (files: ReadonlyMap<string, Buffer>, name: string): unknown => JSON.parse(found(files.get(name)).toString());
/** The song ID of an exported bundle: its one top-level folder. */
export const songFolder = (files: ReadonlyMap<string, unknown>): string => found([...files.keys()][0]).split("/")[0];
/** An .adpose file from an exported ZIP, decoded. */
export const zipPose = (files: ReadonlyMap<string, Buffer>, name: string) => decodePoseFile(found(files.get(name)));
/** A calibration as a pose file stores it: its measurements are f32. */
export const storedCalibration = (c: TrackCalibration): TrackCalibration => ({ ...c, torsoLength: Math.fround(c.torsoLength), floorY: Math.fround(c.floorY),
  baseHip: { x: Math.fround(c.baseHip.x), y: Math.fround(c.baseHip.y), z: Math.fround(c.baseHip.z) },
  ...(c.bodyTorsoLength === undefined ? {} : { bodyTorsoLength: Math.fround(c.bodyTorsoLength) }) });
/** A capture record fixture: a webcam or video tracking result with its upload timing. */
export interface CaptureRecord {
  receivedBrowserTimeMs?: number; audioPositionAtReceiptMs?: number; audioPositionAtFrameMs?: number; audioPlaybackRate?: number;
  record: {
    sessionId: string; seq: number; playerCount: number; input: { width: number; height: number }; modelId: string;
    mediaTimeMs: number; frameBrowserTimeMs?: number; resultBrowserTimeMs?: number; timingMethod: string; poses: Pose[];
  };
}
/** Capture records as a decoded capture file, as the recorder or video importer would have uploaded them. */
export function captureOf(records: readonly CaptureRecord[], sourceKind: "webcam" | "video", calibrationFrame?: CalibrationFrame): PoseFrames {
  const first = records[0], r0 = first.record, webcam = sourceKind === "webcam";
  assert.ok(isPoseModelId(r0.modelId) && (r0.playerCount === 1 || r0.playerCount === 2));
  const header: PoseHeaderInput = { kind: "capture", playerSlots: r0.playerCount, input: { width: r0.input.width, height: r0.input.height },
    modelId: r0.modelId, ...(webcam ? { extensionIds: WEBCAM_EXTENSIONS } : {}),
    capture: { sourceKind, sessionId: r0.sessionId, audioPlaybackRate: webcam ? first.audioPlaybackRate ?? 1 : null } };
  const frames = records.map(({ record: r, ...e }): FrameInput => ({
    timeMs: r.mediaTimeMs, poses: r.poses, seq: r.seq, seekTime: r.timingMethod === "seek-time",
    ...(webcam ? { extensions: {
      [EXTENSION.frameBrowserTimeMs]: r.frameBrowserTimeMs ?? 0, [EXTENSION.resultBrowserTimeMs]: r.resultBrowserTimeMs ?? 0,
      [EXTENSION.receivedBrowserTimeMs]: e.receivedBrowserTimeMs ?? 0, [EXTENSION.audioPositionAtFrameMs]: e.audioPositionAtFrameMs ?? 0,
      [EXTENSION.audioPositionAtReceiptMs]: e.audioPositionAtReceiptMs ?? 0,
    } } : {}),
  }));
  return decodePoseFile(encodePoseFile(buildFrames(header, frames,
    calibrationFrame ? { calibrationFrame: { timeMs: calibrationFrame.mediaTimeMs, poses: calibrationFrame.poses } } : {})));
}
/** The capture envelopes as the NDJSON records.ndjson earlier editors stored. */
export const ndjson = (records: readonly unknown[]) => new TextEncoder().encode(records.map((r) => JSON.stringify(r) + "\n").join(""));
/**
 * Asserts two sample lists hold the same poses up to storage quantization: positions within
 * a position step, confidence within 1/254, the same quality.
 */
export function assertSamplesClose<S extends TimedPoses<"songTimeMs"> | TimedPoses<"takeTimeMs">>(actual: readonly S[], expected: readonly S[]) {
  assert.equal(actual.length, expected.length);
  actual.forEach((a, i) => {
    const e = expected[i];
    assert.equal("songTimeMs" in a ? a.songTimeMs : a.takeTimeMs, "songTimeMs" in e ? e.songTimeMs : e.takeTimeMs);
    // Stored frames keep no "resampled" origin; readers see it as measured.
    const quality = (s: S) => (s.quality ?? qualityFor(s.poses)).map((v) => ({ ...v, landmarkOrigins: v.landmarkOrigins.map((o) => o === "resampled" ? "measured" : o) }));
    assert.deepEqual(quality(a), quality(e));
    assert.deepEqual(a.poses.map((p) => p.playerId), e.poses.map((p) => p.playerId));
    a.poses.forEach((p, k) => p.landmarks.forEach((j, n) => {
      const x = e.poses[k].landmarks[n];
      for (const axis of ["x", "y", "z"] as const) assert.ok(Math.abs(j[axis] - x[axis]) <= DEFAULT_POSITION_STEP, `sample ${i} joint ${n} ${axis}`);
      assert.ok(j.confidence === x.confidence || (j.confidence !== null && x.confidence !== null && Math.abs(j.confidence - x.confidence) <= 1 / 254));
    }));
  });
}
/** A pose as a pose file stores it: quantized positions and confidence. */
export const storedPose = (pose: Pose): Pose =>
  framesToPoses(buildFrames({ kind: "take", playerSlots: 2, input: { width: 1, height: 1 }, modelId: null }, [{ timeMs: 0, poses: [pose] }]), 0).poses[0];
/** A request a recorder or importer made: its URL and body. */
export interface Call { url: string; body: unknown; }
/** The capture frames each batch upload held, decoded with the header the capture started with. */
export function uploadedFrames(calls: readonly Call[]): PoseFrames[] {
  const start = found(calls.find((c) => /\/takes$/.test(c.url)));
  const head = captureHead(read(start.body, "header"));
  return calls.filter((c) => c.url.includes("/batches")).map((c) => {
    assert.ok(c.body instanceof Uint8Array);
    return decodeCaptureBatch(head, c.body);
  });
}

/** Navigate the dedicated sidebar without depending on the previous panel. */
export async function openSidebar(page: Page, name: "Project" | "Track options" | "Import" | "Configuration" | "History") {
  const sidebar = page.locator(".library");
  if (await sidebar.getByRole("heading", { name, exact: true }).count()) return;
  const back = sidebar.getByRole("button", { name: "Back to project", exact: true });
  if (await back.count()) await back.click();
  if (name === "Track options") await page.getByRole("button", { name: /^P[12] track options$/ }).click();
  else if (name !== "Project") await sidebar.getByRole("button", { name, exact: true }).click();
  await sidebar.getByRole("heading", { name, exact: true }).waitFor();
}
