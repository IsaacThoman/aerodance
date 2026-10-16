import { useEffect, useState } from "react";
import type { PoseSourceController, PoseSourceView } from "../../../packages/pose/browser/PoseSourceController.ts";
import { LiveCalibration } from "../../../packages/character/liveCalibration.ts";
import type { LiveTrackCalibration } from "../../../packages/character/liveCalibration.ts";

export type LiveCapture = ReturnType<typeof useLiveCapture>;

// The webcam connection and each dancer's body calibration from its live frames.
export function useLiveCapture(source: PoseSourceController) {
  const [connection, setConnection] = useState<PoseSourceView>(() => source.view);
  const [liveTracks, setLiveTracks] = useState<LiveTrackCalibration[] | null>(null);
  const [calibrationCounts, setCalibrationCounts] = useState<number[]>([0, 0]);
  const [history] = useState(() => new LiveCalibration());
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
      setCalibrationCounts([0, 0]);
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
  return { connection, liveTracks, calibrationCounts, recalibrate };
}
