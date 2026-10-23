import { calibratePoses, reliableBodyPose } from './calibration.ts';
import type { FrameSize, Pose, TrackCalibration } from '../pose/choreography.ts';

/** What calibration needs from a live snapshot (PoseSourceSnapshot, or a replayed record). */
export interface CalibrationSnapshot { sessionId: string; seq: number; poses: readonly Pose[]; input: FrameSize; sourceKind?: string; }
export interface LiveTrackCalibration { playerId: number; calibration: TrackCalibration; }

// A new camera/framing session owns its own full-body stance samples per player (`players` of them).
export class LiveCalibration {
  sampleLimit: number;
  players: number;
  session: string | null = null;
  seq: number | null = null;
  frames: Pose[][];
  tracks: LiveTrackCalibration[] = [];
  constructor(sampleLimit=20, players=2) { this.sampleLimit=sampleLimit; this.players=players; this.frames=this.empty(); }
  empty() { return Array.from({length:this.players},(): Pose[]=>[]); }
  reset() { this.session=null; this.seq=null; this.frames=this.empty(); this.tracks=[]; }
  accept(snapshot: CalibrationSnapshot | null | undefined) {
    if(!snapshot) { this.reset(); return false; }
    if(snapshot.sessionId!==this.session) { this.reset(); this.session=snapshot.sessionId; }
    if(snapshot.seq===this.seq) return false;
    this.seq=snapshot.seq;
    let changed=false;
    for(const pose of snapshot.poses) {
      // A player beyond `players` has no track here.
      if(!this.frames[pose.playerId] || this.frames[pose.playerId].length>=this.sampleLimit ||
        snapshot.sourceKind==='webcam' && !reliableBodyPose(pose)) continue;
      this.frames[pose.playerId].push(pose); changed=true;
    }
    if(!changed) return false;
    this.tracks=this.frames.flatMap((frames,playerId)=>frames.length ? [playerId] : []).map(playerId=>({ playerId,
      calibration:calibratePoses(this.frames[playerId],snapshot.input,{adaptiveDistance:snapshot.sourceKind==='webcam'}),
    }));
    return true;
  }
  get counts() { return this.frames.map(frames=>frames.length); }
}
