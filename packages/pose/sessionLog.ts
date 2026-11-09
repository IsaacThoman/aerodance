import type { WebcamRecord, PoseDetail, HandTracking } from './webcamRecord.ts';

/** Session times are milliseconds on performance.now(); mediaTime is seconds, as rVFC reports it. */
export interface SessionHeader {
  t: number; type: 'header'; format: 'aerodance.session'; version: 1;
  commit: string | null; userAgent: string; game: string; playerCount: number;
  options: Record<string, string>; detail: PoseDetail | null;
  camera: { width?: number; height?: number; frameRate?: number; label: string };
  timeOrigin: number; videoStartTime: number; mimeType: string;
  /** Tracking may turn a phone's native stream upright; the video itself stays native. */
  rotation: number;
}
export interface SessionPose {
  t: number; type: 'pose'; record: WebcamRecord; lined: boolean;
  receivedBrowserTimeMs: number; captureBrowserTimeMs: number;
  timing: { method: string; uncertaintyMs?: number | null };
}
export interface SessionFrame {
  t: number; type: 'frame'; callbackTime: number;
  metadata: { mediaTime: number; presentedFrames: number; expectedDisplayTime: number;
    presentationTime?: number; captureTime?: number; receiveTime?: number; width: number; height: number };
}
export interface SessionStats {
  t: number; type: 'stats'; data: { poseHz: number | null; inferenceMs: number | null; hands: HandTracking | null;
    frameAgeMs?: number; droppedFrames?: number; clockUncertaintyMs?: number };
}
/** Also used by ctx.record(type, data), phases, options, reports and the final end reason. */
export interface SessionEvent { t: number; type: string; data: unknown; }
export type SessionLine = SessionHeader | SessionPose | SessionFrame | SessionStats | SessionEvent;
export interface LogSink { write(text: string): Promise<void>; close(): Promise<void>; }

/** Batches immutable records; the browser supplies a worker serializer to keep JSON off tracking's thread. */
export class SessionLogWriter {
  private batch: SessionLine[] = [];
  private pending = Promise.resolve();
  private queued = 0;
  private ended = false;
  private failure: unknown;
  private sink: LogSink;
  private serialize: (lines: SessionLine[]) => Promise<string>;
  constructor(sink: LogSink, serialize: (lines: SessionLine[]) => Promise<string> = async lines =>
    lines.map(line => JSON.stringify(line)).join('\n') + '\n') { this.sink = sink; this.serialize = serialize; }

  append(line: SessionLine) {
    if (this.ended) return;
    this.batch.push(line);
    if (this.batch.length >= 120) this.flush();
  }
  flush() {
    if (!this.batch.length || this.failure) return;
    if (this.queued >= 8) { this.failure = Error('Session log disk writes cannot keep up'); this.batch = []; return; }
    const batch = this.batch;
    this.batch = [];
    this.queued++;
    this.pending = this.pending.then(async () => {
      if (!this.failure) await this.sink.write(await this.serialize(batch));
    }).catch(error => { this.failure = error; }).finally(() => { this.queued--; });
  }
  get error() { return this.failure; }
  async close() {
    this.ended = true;
    this.flush();
    await this.pending;
    // Close even on failure, so a partial recording is available for diagnosis.
    await this.sink.close();
    if (this.failure) throw this.failure;
  }
}
