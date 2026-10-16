import type { CameraInfo, PoseRecordEvent, SourceStoppedEvent, WebcamStatus } from '../../../packages/pose/browser/WebcamPoseSource.ts';
import type { WebcamRecord } from '../../../packages/pose/webcamRecord.ts';
import type { ProtocolPoseRecord } from '../../../packages/pose/protocol.ts';
import type { Pose } from '../../../packages/pose/choreography.ts';
import type { SongBundle } from '../../../packages/pose/song.ts';

/*
 * The pose input the game plays with, whatever produces it: the webcam
 * (PoseSourceController) or a replay (ReplayPoseSource). GameSession, the recorder and the
 * game's screens only use this contract, so both sources are handled the same way.
 */

/** A tracked pose record: the webcam's capture record, or a protocol record replayed. */
export type LivePoseRecord = WebcamRecord | ProtocolPoseRecord;
/** What record listeners hear: a tracked pose, or the source stopping. */
export type PoseSourceEvent = PoseRecordEvent<LivePoseRecord> | SourceStoppedEvent;

/** A source's state, as the menus and the calibration screen show it. */
export interface PoseInputView {
  status: WebcamStatus;
  message: string;
  sourceKind: 'webcam' | 'replay';
  /** The latest tracked poses, or null while nobody is tracked. */
  snapshot: { poses: readonly Pose[] } | null;
  configuring: boolean;
  /** The tracking model id, or 'replay'. */
  model: string;
  cameraId?: string;
  cameras?: readonly CameraInfo[];
}

/** The song clock a source can follow while a song plays (GameSession attaches it). */
export interface SongClock {
  bundle: SongBundle;
  /** The song position audible at a performance.now() time. */
  songTimeAt(perfMs: number): number;
  /** The performance.now() time a song position is (or was) audible. */
  perfAtSong(ms: number): number;
  playing(): boolean;
}

export interface PoseSource {
  readonly view: PoseInputView;
  /** The camera feed, for the setup preview (webcam only). */
  readonly video?: HTMLVideoElement | null;
  subscribeRecords(listener: (event: PoseSourceEvent) => void): () => void;
  /** Sources that play back poses follow the song; the webcam ignores it. */
  attachSong?(song: SongClock | null): void;
}

/** A record event that carries a tracked pose. */
export const isPoseRecordEvent = (event: PoseSourceEvent): event is PoseRecordEvent<LivePoseRecord> => 'record' in event;
