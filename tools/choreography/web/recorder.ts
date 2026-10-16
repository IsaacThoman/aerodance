import type { WebcamRecordEvent } from "../../../packages/pose/browser/WebcamPoseSource.ts";
import type { FrameSize } from "../../../packages/pose/choreography.ts";
import type { PoseEnvelope, WebcamEnvelope } from "../core.ts";
import type { AudioTransport } from "./audio.ts";
import { takeIdOf } from "./api.ts";
import type { ApiRequest } from "./api.ts";

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
}
export class Recorder {
  source: RecorderSource;
  transport: RecorderTransport;
  request: ApiRequest;
  projectId: string;
  onFailure: (message: string) => void;
  pending: WebcamEnvelope[] = [];
  batchId = 0;
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
  unsubscribe?: () => void;
  timer?: ReturnType<typeof setInterval>;
  startedAt = 0;
  lastAck = 0;
  captureStartedAt?: number;
  constructor({ source, transport, request, projectId, onFailure }: RecorderOptions) {
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
    this.takeId = takeIdOf(await this.request(
      `/api/projects/${this.projectId}/takes`,
      {
        method: "POST",
        body: {
          name: `Take · ${new Date().toLocaleTimeString()}`,
          sourceKind: this.sourceKind,
          status: { ...this.source.view.modelConfig, audioAnchor: this.transport.audioAnchor },
        },
      },
    ));
    this.running = true;
    this.pending.push({
      ordinal: this.ordinal++,
      receivedBrowserTimeMs: performance.now(),
      audioPositionAtReceiptMs: this.transport.current(),
      event: {
        type: "audio-start-scheduled",
        audioContextStartTime: this.transport.startTime,
        positionMs: this.transport.positionMs,
        rate: this.transport.rate,
      },
    });
    this.unsubscribe = this.source.subscribeRecords((e) => {
      if (!this.running) return;
      if ("event" in e) {
        this.pending.push({ ordinal: this.ordinal++, receivedBrowserTimeMs: e.receivedBrowserTimeMs,
          audioPositionAtReceiptMs: this.transport.current(), event: e.event });
        if (e.event.type === 'source-stopped') this.onFailure(e.event.reason || 'Pose source stopped');
        return;
      }
      if (
        e.record.sessionId !== this.session ||
        e.record.schema !== 'aerodance.webcam-record' ||
        e.record.modelId !== this.modelId ||
        (e.record.type === "pose" &&
          (e.record.playerCount !== 2 ||
            e.record.input.width !== this.input?.width ||
            e.record.input.height !== this.input?.height ||
            e.record.input.mirrored !== false))
      ) {
        this.onFailure("Capture source, session, model, player mode or geometry changed");
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
      if (e.record.type === "pose") this.poseCount++;
      const envelope: PoseEnvelope = {
        ordinal: this.ordinal++,
        receivedBrowserTimeMs: e.receivedBrowserTimeMs,
        audioPositionAtReceiptMs,
        audioPlaybackRate: this.transport.rate,
        audioPositionAtFrameMs,
        record: e.record,
      };
      this.pending.push(envelope);
      this.bytes += JSON.stringify(envelope).length;
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
  flush() {
    if (!this.pending.length || this.failure) return;
    const records = this.pending.splice(0),
      batchId = this.batchId++;
    this.chain = this.chain
      .then(async () => {
        const options = { method: "POST", body: { batchId, records } };
        try {
          await this.request(
            `/api/projects/${this.projectId}/takes/${this.takeId}/batches`,
            options,
          );
        } catch {
          await this.request(
            `/api/projects/${this.projectId}/takes/${this.takeId}/batches`,
            options,
          );
        }
        this.lastAck = performance.now();
        this.bytes -= JSON.stringify(records).length;
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
    this.pending.push({
      ordinal: this.ordinal++,
      receivedBrowserTimeMs: performance.now(),
      audioPositionAtReceiptMs: this.transport.current(),
      event: { type: "audio-stop", reason },
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
