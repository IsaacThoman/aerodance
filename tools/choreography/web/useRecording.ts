import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { PoseSourceController, PoseSourceView } from "../../../packages/pose/browser/PoseSourceController.ts";
import { errorMessage, request } from "./api.ts";
import type { AudioTransport } from "./audio.ts";
import { Recorder } from "./recorder.ts";
import type { StudioProject } from "./useStudioProject.ts";
import type { PreviewMode, View } from "./useWorkspace.ts";

export interface RecordingOptions {
  transport: AudioTransport;
  source: PoseSourceController;
  connection: PoseSourceView;
  studio: StudioProject;
  /** Stops song and take playback. */
  pause: () => void;
  setView: Dispatch<SetStateAction<View>>;
  setPlaying: Dispatch<SetStateAction<boolean>>;
  setCursor: Dispatch<SetStateAction<number>>;
  setMode: Dispatch<SetStateAction<PreviewMode>>;
  /** Adds a finished take (as the server returned it) to the project. */
  attachTake: (take: unknown) => void;
}
export type Recording = ReturnType<typeof useRecording>;

// Records a webcam take against the song: a countdown, then pose records anchored to the audio clock.
export function useRecording({ transport, source, connection, studio, pause, setView, setPlaying, setCursor, setMode, attachTake }: RecordingOptions) {
  const { project, projectRef, execute, saveProject, setBusy, setError, setNotice } = studio;
  const [recording, setRecording] = useState(false),
    [recordCount, setRecordCount] = useState(0),
    [recordDelay, setRecordDelay] = useState<number | "">(3),
    [countdown, setCountdown] = useState<number | null>(null);
  const recorder = useRef<Recorder | null>(null),
    recordStopping = useRef(false),
    recordingRef = useRef(recording),
    recordEnd = useRef(0);
  recordingRef.current = recording;
  const stopRecording = useCallback(async (reason: string | null = null) => {
    const active = recorder.current;
    if (!active?.running || recordStopping.current) return;
    recordStopping.current = true;
    transport.pause();
    recordingRef.current = false;
    setRecording(false);
    setCountdown(null);
    setBusy(true);
    try {
      const take = await active.stop(reason);
      if (!take) {
        setCursor(projectRef.current?.playableStartMs ?? 0);
        setNotice(
          "Recording cancelled before enough movement was captured. No take added.",
        );
        if (reason) setError(reason);
        return;
      }
      attachTake(take);
      if (reason)
        setError(
          `Take interrupted: ${reason}. Review the saved prefix before use.`,
        );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      recordStopping.current = false;
      recorder.current = null;
    }
  }, [attachTake, projectRef, setBusy, setCursor, setError, setNotice, transport]);
  const startRecording = () =>
    execute(async () => {
      if (!transport.buffer) throw Error("Import music before recording");
      if (connection.status !== "connected")
        throw Error("Connect a pose source before recording");
      if (!connection.snapshot) throw Error('Wait for fresh camera frames before recording');
      if (!project) return;
      pause();
      setView("live");
      await saveProject();
      recordEnd.current = project.playableEndMs;
      if (typeof recordDelay !== "number" || !Number.isFinite(recordDelay) || recordDelay < 0 || recordDelay > 60)
        throw Error("Recording delay must be between 0 and 60 seconds");
      await transport.play(project.playableStartMs, recordDelay, 1);
      const r = new Recorder({
        source,
        transport,
        request,
        projectId: project.projectId,
        onFailure: (message) => void stopRecording(message),
      });
      recorder.current = r;
      try {
        await r.start();
      } catch (e) {
        transport.pause();
        throw e;
      }
      recordStopping.current = false;
      recordingRef.current = true;
      setRecording(true);
      setCountdown(recordDelay > 0 ? Math.ceil(recordDelay) : null);
      setPlaying(false);
      setMode("both");
      setRecordCount(0);
      setNotice(
        'Webcam frames use a browser/audio clock anchor. Review remaining camera buffering and audio output delay before export.',
      );
    });
  /** Follows the song clock each frame while it plays; returns whether a recording owns it. */
  const tick = useCallback((now: number) => {
    const context = transport.context;
    setCountdown(
      recordingRef.current && context &&
        context.currentTime < transport.startTime
        ? Math.ceil(transport.startTime - context.currentTime)
        : null,
    );
    if (!recordingRef.current) return false;
    setRecordCount(recorder.current?.ordinal || 0);
    if (now >= recordEnd.current) void stopRecording();
    return true;
  }, [stopRecording, transport]);
  useEffect(() => {
    if (recording && connection.status !== "connected")
      void stopRecording("Pose source connection interrupted");
  }, [recording, connection.status, stopRecording]);
  return {
    recording, recordingRef, recordCount, recordDelay, setRecordDelay, countdown, setCountdown,
    startRecording, stopRecording, tick,
  };
}
