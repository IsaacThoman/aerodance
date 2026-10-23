import type { CameraInfo, PoseRecordEvent, SourceStoppedEvent, WebcamStatus } from '../../../../packages/pose/browser/WebcamPoseSource.ts';
import type { PreviewPicture } from '../../../../packages/pose/browser/preview.ts';
import type { CaptureInput, PlayerCount, Pose } from '../../../../packages/pose/choreography.ts';
import type { Cast, SongBundle } from '../../../../packages/pose/song.ts';

/*
 * The pose input the game plays with, whatever produces it: the webcam
 * (PoseSourceController), a paired phone (PhonePoseSource) or a replay (ReplayPoseSource).
 * GameSession, the recorder and the game's screens only use this contract, so every source
 * is handled the same way.
 */

/** A tracked pose record as sources deliver it; the webcam's capture records carry more timing. */
export interface LivePoseRecord {
  type: 'pose'; sessionId: string; seq: number; playerCount: PlayerCount;
  /** Always unmirrored. */
  input: CaptureInput;
  /** Ascending playerIds below playerCount; an absent player is omitted. */
  poses: Pose[];
}
/** What record listeners hear: a tracked pose, or the source stopping. */
export type PoseSourceEvent = PoseRecordEvent<LivePoseRecord> | SourceStoppedEvent;

/** A source's state, as the menus and the calibration screen show it. */
export interface PoseInputView {
  status: WebcamStatus;
  message: string;
  /** The camera is on but the browser has muted it (iOS took it for a call, or it sends no pictures). */
  interrupted?: boolean;
  /** A live camera (this computer's or a paired phone's), or a replay. */
  sourceKind: 'webcam' | 'phone' | 'replay';
  /** The latest tracked poses, or null while nobody is tracked. */
  snapshot: { poses: readonly Pose[] } | null;
  configuring: boolean;
  /** The tracking model id, or 'replay'. */
  model: string;
  cameraId?: string;
  cameras?: readonly CameraInfo[];
  /** How tracking is keeping up, for the stats overlay: the webcam and a paired phone report it. */
  stats?: { poseHz: number; inferenceMs: number | null; droppedFrames?: number; clockUncertaintyMs?: number } | null;
  /** Where the tracking model runs (GPU or CPU), once it has loaded. */
  delegate?: string;
}

/** The song clock a source can follow while a song plays (GameSession attaches it). */
export interface SongClock {
  bundle: SongBundle;
  /** The dancer each player follows. */
  cast: Cast;
  /** The song position audible at a performance.now() time. */
  songTimeAt(perfMs: number): number;
  /** The performance.now() time a song position is (or was) audible. */
  perfAtSong(ms: number): number;
  playing(): boolean;
}

export interface PoseSource {
  readonly view: PoseInputView;
  /** The camera feed, for the setup preview (a webcam, or a phone's picture while it sends one). */
  readonly video?: PreviewPicture | null;
  subscribeRecords(listener: (event: PoseSourceEvent) => void): () => void;
  /** Sources that play back poses follow the song; the webcam ignores it. */
  attachSong?(song: SongClock | null): void;
}

/** A record event that carries a tracked pose. */
export const isPoseRecordEvent = (event: PoseSourceEvent): event is PoseRecordEvent<LivePoseRecord> => 'record' in event;
