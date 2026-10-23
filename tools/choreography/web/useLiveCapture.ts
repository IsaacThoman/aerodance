import { useEffect, useMemo, useRef, useState } from "react";
import { MAX_DANCERS } from "../../../packages/pose/choreography.ts";
import type { PlayerCount } from "../../../packages/pose/choreography.ts";
import { capturePoses, detectionCount, fittingMode } from './captureMode.ts';
import type { CaptureMode } from './captureMode.ts';
import type { PoseSourceController, PoseSourceView } from "../../../packages/pose/browser/PoseSourceController.ts";
import { LiveCalibration } from "../../../packages/character/liveCalibration.ts";
import type { LiveTrackCalibration } from "../../../packages/character/liveCalibration.ts";

export type LiveCapture = ReturnType<typeof useLiveCapture>;
const NONE = Array<number>(MAX_DANCERS).fill(0);

// The webcam connection and each dancer's body calibration from its live frames, for a song
// with `dancers` dancers (the capture mode follows it).
export function useLiveCapture(source: PoseSourceController, dancers = 2) {
  const [rawConnection, setConnection] = useState<PoseSourceView>(() => source.view);
  const [chosenMode, setMode] = useState<CaptureMode>('all');
  const captureMode = fittingMode(chosenMode, dancers);
  const connection = useMemo<PoseSourceView>(() => ({ ...rawConnection,
    snapshot: rawConnection.snapshot ? { ...rawConnection.snapshot, playerCount: dancers as PlayerCount,
      poses: capturePoses(rawConnection.snapshot.poses, captureMode) } : null,
  }), [rawConnection, captureMode, dancers]);
  const [liveTracks, setLiveTracks] = useState<LiveTrackCalibration[] | null>(null);
  const [calibrationCounts, setCalibrationCounts] = useState<number[]>(NONE);
  const [history] = useState(() => new LiveCalibration(20, MAX_DANCERS));
  useEffect(() => {
    const unsubscribe = source.subscribe(setConnection);
    return () => {
      unsubscribe();
    };
  }, [source]);
  useEffect(() => {
    const s = connection.snapshot;
    if (!s) {
      history.reset();
      setCalibrationCounts(NONE);
      setLiveTracks(null); return;
    }
    const previousSession=history.session;
    const changed=history.accept(s);
    if(changed || previousSession!==history.session) {
      setLiveTracks(history.tracks); setCalibrationCounts(history.counts);
    }
  }, [connection.snapshot, history]);
  const recalibrate = () => {
    history.reset();
    if(connection.snapshot) history.accept(connection.snapshot);
    setLiveTracks(history.tracks);
    setCalibrationCounts(history.counts);
  };
  const setCaptureMode = async (mode: CaptureMode) => {
    const connected = ['connected', 'connecting', 'initializing'].includes(source.view.status);
    source.disconnect();
    setMode(mode);
    await source.setPlayerCount(detectionCount(fittingMode(mode, dancers), dancers));
    if (connected) await source.connect();
  };
  // A new number of dancers restarts tracking for as many people (or the solo dancer, if the
  // song still has them).
  const tracked = useRef(dancers);
  useEffect(() => {
    if (tracked.current === dancers) return;
    tracked.current = dancers;
    if (detectionCount(captureMode, dancers) !== source.playerCount) void setCaptureMode(captureMode).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dancers]);
  return { connection, liveTracks, calibrationCounts, recalibrate, captureMode, setCaptureMode, dancers };
}
