// The people in front of the camera, ready to draw as characters: their latest poses, and how
// each is sized and placed (measured from their first steady, whole-body poses).
import { useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { calibratePoses, reliableBodyPose } from '../../../../../packages/character/calibration.ts';
import type { Pose, TrackCalibration } from '../../../../../packages/pose/choreography.ts';
import { camera } from './camera.ts';

export interface LivePeople {
  /** The latest pose per camera slot (null where nobody is tracked); read it in a frame loop. */
  poses: RefObject<(Pose | null)[]>;
  /** Each slot's calibration once it has been seen whole, else null. */
  calibrations: (TrackCalibration | null)[];
  /** Forgets the measurements, to take them again (the performer moved the camera or stepped back). */
  recalibrate(): void;
}
const SAMPLES = 20;
/** Follows the camera's tracked people while mounted. */
export function useLivePeople(): LivePeople {
  const poses = useRef<(Pose | null)[]>([]);
  const frames = useRef<Pose[][]>([]);
  const session = useRef<string | null>(null);
  const [calibrations, setCalibrations] = useState<(TrackCalibration | null)[]>([]);
  useEffect(() => {
    const off = camera().subscribe(view => {
    const snapshot = view.snapshot;
    if (!snapshot) { poses.current = []; return; }
    if (snapshot.sessionId !== session.current) { session.current = snapshot.sessionId; frames.current = []; setCalibrations([]); }
    const latest: (Pose | null)[] = [];
    let changed = false;
    for (const pose of snapshot.poses) {
      latest[pose.playerId] = pose;
      const kept = frames.current[pose.playerId] ??= [];
      if (kept.length < SAMPLES && reliableBodyPose(pose)) { kept.push(pose); changed = true; }
    }
    for (let i = 0; i < latest.length; i++) latest[i] ??= null;
    poses.current = latest;
    if (changed) setCalibrations(frames.current.map(f => f?.length ? calibratePoses(f, snapshot.input, { adaptiveDistance: true }) : null));
    });
    return () => { off(); };
  }, []);
  return useMemo(() => ({ poses, calibrations, recalibrate: () => { frames.current = []; setCalibrations([]); } }), [calibrations]);
}
