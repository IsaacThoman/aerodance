import type { WebcamRecordEvent } from "../../../packages/pose/browser/WebcamPoseSource.ts";
import type { FrameSize } from "../../../packages/pose/choreography.ts";
import { EXTENSION, PoseFileWriter, strideOf } from "../../../packages/pose/binary.ts";
import type { FrameInput, TimedCaptureEvent } from "../../../packages/pose/binary.ts";
import { captureHeader, concatBytes } from "../poseFiles.ts";
import type { CaptureStart } from "../poseFiles.ts";
import type { AudioTransport } from "./audio.ts";
import { takeIdOf } from "./api.ts";
import type { ApiRequest } from "./api.ts";
import { capturePoses, detectionCount } from './captureMode.ts';
import type { CaptureMode } from './captureMode.ts';

/** The part of the pose source a recording reads (PoseSourceController). */
export interface RecorderSource {
  view: {
    sourceKind?: string; model?: string; modelConfig?: object;
    snapshot: { sessionId?: string; input?: FrameSize } | null;
  };
  subscribeRecords(listener: (event: WebcamRecordEvent) => void): () => void;
}
export type RecorderTransport = Pick<AudioTransport, "active" | "rate" | "positionMs" | "startTime" | "audioAnchor" | "current" | "atBrowserTime">;
export interface RecorderOptions {
  source: RecorderSource;
  transport: RecorderTransport;
  request: ApiRequest;
  projectId: string;
  onFailure: (message: string) => void;
  captureMode?: CaptureMode;
}
/** A pose frame or a lifecycle event waiting for upload, in capture order. */
export type PendingRecord = { frame: FrameInput } | { event: TimedCaptureEvent };
export class Recorder {
  captureMode: CaptureMode;
  source: RecorderSource;
  transport: RecorderTransport;
  request: ApiRequest;
  projectId: string;
  onFailure: (message: string) => void;
  pending: PendingRecord[] = [];
  batchId = 0;
  /** Frames and events captured, for finalize's completeness check. */
  ordinal = 0;
  poseCount = 0;
  bytes = 0;
  chain: Promise<void> = Promise.resolve();
  failure: Error | null = null;
  running = false;
  sourceKind?: string;
  modelId?: string;
  session?: string;
  input?: FrameSize;
  takeId?: string;
  rate = 1;
  writer?: PoseFileWriter;
  frameBytes = 0;
  unsubscribe?: () => void;
  timer?: ReturnType<typeof setInterval>;
  startedAt = 0;
  lastAck = 0;
  captureStartedAt?: number;
  constructor({ source, transport, request, projectId, onFailure, captureMode = 'both' }: RecorderOptions) {
    this.captureMode = captureMode;
    this.source = source;
    this.transport = transport;
    this.request = request;
    this.projectId = projectId;
    this.onFailure = onFailure;
  }
  async start() {
    this.sourceKind = this.source.view.sourceKind;
    this.modelId = this.source.view.model;
    // Freshness can clear the preview while the take request is in flight.
    // Retain the capture identity observed when recording starts.
    const snapshot = this.source.view.snapshot;
    this.session = snapshot?.sessionId;
    this.input = snapshot?.input;
    if (!this.session || !this.input || !this.modelId) throw Error("Start the camera before recording");
    this.rate = this.transport.rate;
    // Browser clocks count from now and audio clocks from the start position, in microseconds.
    const now = performance.now(), position = this.transport.positionMs;
    const header: Partial<CaptureStart> = {
      sourceKind: "webcam", sessionId: this.session, input: this.input && { width: this.input.width, height: this.input.height },
      playerCount: 2, modelId: this.modelId as CaptureStart["modelId"], audioPlaybackRate: this.rate,
      extensionBases: [now, now, now, position, position],
    };
    this.writer = new PoseFileWriter(captureHeader(header));
    this.frameBytes = strideOf(2, false, this.writer.header.extensionIds.length);
    this.takeId = takeIdOf(await this.request(
      `/api/projects/${this.projectId}/takes`,
      {
        method: "POST",
        body: {
          name: `Take · ${new Date().toLocaleTimeString()}`,
          sourceKind: this.sourceKind,
          status: { ...this.source.view.modelConfig, audioAnchor: this.transport.audioAnchor, captureMode: this.captureMode },
          header,
        },
      },
    ));
    this.running = true;
    this.pushEvent({
      receivedBrowserTimeMs: performance.now(),
      audioPositionAtReceiptMs: this.transport.current(),
      type: "audio-start-scheduled",
      audioContextStartTime: this.transport.startTime,
      positionMs: this.transport.positionMs,
      rate: this.transport.rate,
    });
    this.unsubscribe = this.source.subscribeRecords((e) => {
      if (!this.running) return;
      if ("event" in e) {
        this.pushEvent({ ...e.event, receivedBrowserTimeMs: e.receivedBrowserTimeMs,
          audioPositionAtReceiptMs: this.transport.current() });
        if (e.event.type === 'source-stopped') this.onFailure(e.event.reason || 'Pose source stopped');
        return;
      }
      if (
        this.transport.rate !== this.rate ||
        e.record.sessionId !== this.session ||
        e.record.schema !== 'aerodance.webcam-record' ||
        e.record.modelId !== this.modelId ||
        (e.record.type === "pose" &&
          (e.record.playerCount !== detectionCount(this.captureMode) ||
            e.record.input.width !== this.input?.width ||
            e.record.input.height !== this.input?.height ||
            e.record.input.mirrored !== false))
      ) {
        this.onFailure("Capture source, session, model, player mode, geometry or playback rate changed");
        return;
      }
      const audioPositionAtReceiptMs =
        this.transport.current() -
        (this.transport.active
          ? Math.max(0, performance.now() - e.receivedBrowserTimeMs) * this.transport.rate
          : 0);
      // Ignore the lead-in, including late inference results for frames that
      // arrived before music started.
      const audioPositionAtFrameMs = this.transport.atBrowserTime(e.record.frameBrowserTimeMs);
      if (audioPositionAtFrameMs < this.transport.positionMs)
        return;
      this.captureStartedAt ??= performance.now();
      const r = e.record;
      this.poseCount++;
      this.ordinal++;
      this.pending.push({ frame: { timeMs: r.mediaTimeMs, poses: capturePoses(r.poses, this.captureMode), seq: r.seq, extensions: {
        [EXTENSION.frameBrowserTimeMs]: r.frameBrowserTimeMs,
        [EXTENSION.resultBrowserTimeMs]: r.resultBrowserTimeMs,
        [EXTENSION.receivedBrowserTimeMs]: e.receivedBrowserTimeMs,
        [EXTENSION.audioPositionAtFrameMs]: audioPositionAtFrameMs,
        [EXTENSION.audioPositionAtReceiptMs]: audioPositionAtReceiptMs,
      } } });
      this.bytes += this.frameBytes;
      if (
        this.bytes > 8 * 1024 * 1024 ||
        performance.now() - Math.max(this.lastAck || this.startedAt, this.captureStartedAt) > 5000
      ) {
        this.onFailure("Recording stopped: disk uploads are falling behind");
        return;
      }
      if (this.pending.length >= 150) this.flush();
    });
    this.startedAt = performance.now();
    this.lastAck = this.startedAt;
    this.timer = setInterval(() => this.flush(), 500);
  }
  pushEvent(event: TimedCaptureEvent) {
    this.ordinal++;
    this.pending.push({ event });
  }
  /** The pending records as chunk bytes: each run of frames one FRMS chunk, each run of events one EVNT. */
  encode(records: readonly PendingRecord[]): Uint8Array {
    const writer = this.writer!, chunks: Uint8Array[] = [];
    const frames: FrameInput[] = [], events: TimedCaptureEvent[] = [];
    // At most one of the runs is non-empty, so chunks keep the capture order.
    const emit = () => {
      if (frames.length) chunks.push(writer.frames(frames.splice(0)));
      if (events.length) chunks.push(writer.events(events.splice(0)));
    };
    for (const r of records) {
      if ("frame" in r) { if (events.length) emit(); frames.push(r.frame); }
      else { if (frames.length) emit(); events.push(r.event); }
    }
    emit();
    return concatBytes(chunks);
  }
  flush() {
    if (!this.pending.length || this.failure) return;
    const records = this.pending.splice(0),
      batchId = this.batchId++,
      sent = records.filter(r => "frame" in r).length * this.frameBytes;
    let body: Uint8Array;
    try { body = this.encode(records); }
    catch (error) {
      this.failure = error instanceof Error ? error : Error(String(error));
      this.onFailure(this.failure.message);
      return;
    }
    this.chain = this.chain
      .then(async () => {
        const url = `/api/projects/${this.projectId}/takes/${this.takeId}/batches?batchId=${batchId}`;
        const options = { method: "POST", body };
        try {
          await this.request(url, options);
        } catch {
          await this.request(url, options);
        }
        this.lastAck = performance.now();
        this.bytes -= sent;
      })
      .catch((error: unknown) => {
        const failure = error instanceof Error ? error : Error(String(error));
        this.failure = failure;
        this.onFailure(failure.message);
      });
  }
  /** Resolves with the finalized take (unvalidated), or null when nothing was captured. */
  async stop(reason: string | null = null): Promise<unknown> {
    if (!this.running) throw Error("No recording is active");
    this.running = false;
    this.unsubscribe?.();
    clearInterval(this.timer);
    this.pushEvent({
      receivedBrowserTimeMs: performance.now(),
      audioPositionAtReceiptMs: this.transport.current(),
      type: "audio-stop",
      reason,
    });
    this.flush();
    await this.chain;
    if (this.failure)
      throw Error(`Incomplete take retained on disk: ${this.failure.message}`);
    // A cancelled countdown has no pose samples to finalize into a take.
    if (this.poseCount < 2) return null;
    return this.request(
      `/api/projects/${this.projectId}/takes/${this.takeId}/finalize`,
      {
        method: "POST",
        body: {
          batchCount: this.batchId,
          recordCount: this.ordinal,
          interruptionReason: reason,
        },
      },
    );
  }
}
