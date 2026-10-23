import { useCallback, useEffect, useRef, useState } from "react";
import type { PoseSourceController, PoseSourceView } from "../../../packages/pose/browser/PoseSourceController.ts";
import { clamp } from "../../../packages/pose/choreography.ts";
import { isTake, validateTake } from "../core.ts";
import type { JointTarget, StudioAssets, Take } from "../core.ts";
import { errorMessage, projectSummaries, request } from "./api.ts";
import type { AudioTransport } from "./audio.ts";
import { useRecording } from "./useRecording.ts";
import { editableProject } from "./useStudioProject.ts";
import type { StudioProject } from "./useStudioProject.ts";
import type { CaptureMode } from './captureMode.ts';

/** What the preview shows: the edited song, a library take, or the live camera. */
export type View = "playback" | "take" | "live";
export type PreviewMode = "skeleton" | "characters" | "both";
/** A joint drag in progress, shown before it is committed as an edit. */
export interface DraftJoint { playerId: number; targets: JointTarget[]; }
export type Range = [startMs: number, endMs: number];
interface TakeClock { positionMs: number; startTime: number; speed: number; }
export interface WorkspaceOptions {
  transport: AudioTransport;
  source: PoseSourceController;
  connection: PoseSourceView;
  studio: StudioProject;
  captureMode?: CaptureMode;
  /** The song's dancers, all of whom an 'all' capture records. */
  dancers?: number;
}
export type Workspace = ReturnType<typeof useWorkspace>;

export const takeById = (assets: StudioAssets, takeId: string): Take | undefined => {
  const asset = assets.get(takeId);
  return isTake(asset) ? asset : undefined;
};
/** A take's length on the song clock. */
export const takeLength = (take: Take) =>
  (take.samples[take.samples.length - 1].takeTimeMs - take.samples[0].takeTimeMs) * take.timeScale;

// The song transport and what the preview shows: playback, the take view, the selected range,
// recording, and opening projects (which resets all of it).
export function useWorkspace({ transport, source, connection, studio, captureMode = 'all', dancers = 2 }: WorkspaceOptions) {
  const { project, projectRef, dirtyRef, dirty, busy, takes, execute, refresh, saveProject, load, setError, setNotice, setProjects } = studio;
  const [cursor, setCursor] = useState(0),
    [playing, setPlaying] = useState(false),
    [speed, setSpeed] = useState(1),
    [loop, setLoop] = useState(false),
    [selection, setSelection] = useState<Range>([0, 1000]),
    [mode, setMode] = useState<PreviewMode>("both"),
    [view, setView] = useState<View>("playback"),
    [takeCursor, setTakeCursor] = useState(0),
    [activeTake, setActiveTake] = useState(""),
    [draftJoint, setDraftJoint] = useState<DraftJoint | null>(null);
  const selectedTake = takeById(takes, activeTake);
  const takeClock = useRef<TakeClock | null>(null),
    viewRef = useRef(view),
    takeRef = useRef(selectedTake),
    playingRef = useRef(playing);
  viewRef.current = view;
  takeRef.current = selectedTake;
  playingRef.current = playing;
  const pause = useCallback(() => {
    transport.pause();
    takeClock.current = null;
    playingRef.current = false;
    setPlaying(false);
  }, [transport]);
  const changeView = useCallback((next: View) => {
    pause();
    setView(next);
    setDraftJoint(null);
  }, [pause]);
  const selectTake = useCallback((takeId: string) => {
    pause();
    setActiveTake(takeId);
    setTakeCursor(0);
    setView("take");
    setDraftJoint(null);
  }, [pause]);
  const { addTakeToProject } = studio;
  /** Adds a new take (as storage returned it) to the project and shows it. */
  const attachTake = useCallback((value: unknown) => {
    const take = validateTake(value);
    addTakeToProject(take);
    selectTake(take.takeId);
    setNotice(
      `Imported ${take.samples.length} samples. Review alignment and confidence before exporting.`,
    );
  }, [addTakeToProject, selectTake, setNotice]);
  const recorder = useRecording({ transport, source, connection, studio, captureMode, dancers, pause, setView, setPlaying, setCursor, setMode, attachTake });
  const { recording, recordingRef, stopRecording, setCountdown, tick: recordingTick } = recorder;
  const openProject = useCallback(async (value: unknown) => {
    // Validate saved projects before installing them into render state.
    const p = editableProject(value);
    if (recordingRef.current)
      throw Error("Stop recording before switching projects");
    transport.pause();
    takeClock.current = null;
    setView("playback");
    setTakeCursor(0);
    setPlaying(false);
    setCountdown(null);
    setCursor(0);
    setDraftJoint(null);
    await load(p);
    setSelection([
      p.playableStartMs,
      Math.min(p.playableEndMs || 1000, p.playableStartMs + 1000),
    ]);
    setActiveTake(p.takes[0]?.takeId || "");
  }, [load, recordingRef, setCountdown, transport]);
  useEffect(() => {
    void execute(async () => {
      const list = projectSummaries(await request("/api/projects"));
      setProjects(list);
      if(!list.length) {
        await openProject(await request('/api/projects',{method:'POST',body:{}}));
      } else {
        const failures=[];
        let opened=false;
        for(const summary of list) {
          try {
            await openProject(await request(`/api/projects/${summary.projectId}`));
            opened=true; break;
          } catch(e) { failures.push(`${summary.title}: ${errorMessage(e)}`); }
        }
        if(!opened) throw Error(`No saved project can be opened. ${failures.join(' ')}`);
        if(failures.length) setNotice(`Opened a compatible project. Skipped incompatible or unavailable projects: ${failures.join(' ')}`);
      }
      await refresh();
    });
    return () => {
      source.disconnect();
      transport.dispose();
    };
  }, [execute, openProject, refresh, setNotice, setProjects, source, transport]);
  useEffect(() => {
    if (!dirty || !project || recording || busy) return;
    const timer = setTimeout(
      () => saveProject().catch((e) => setError(errorMessage(e))),
      1200,
    );
    return () => clearTimeout(timer);
  }, [project, dirty, recording, busy, saveProject, setError]);
  useEffect(() => {
    const unload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current || recordingRef.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, [dirtyRef, recordingRef]);
  useEffect(() => {
    const hidden = () => {
      if (!document.hidden) return;
      if (recordingRef.current) void stopRecording("Tab was hidden");
      else {
        takeClock.current = null;
        const t = transport.pause();
        setPlaying(false);
        if (viewRef.current !== "take") setCursor(Math.max(0, t));
      }
    };
    document.addEventListener("visibilitychange", hidden);
    return () => document.removeEventListener("visibilitychange", hidden);
  }, [recordingRef, stopRecording, transport]);
  useEffect(() => {
    let frame: number;
    const tick = () => {
      const clock = takeClock.current, take = takeRef.current;
      if (viewRef.current === "take" && clock && take) {
        const end = takeLength(take);
        const now =
          clock.positionMs +
          (performance.now() - clock.startTime) *
            clock.speed;
        setTakeCursor(Math.min(end, now));
        if (now >= end) {
          takeClock.current = null;
          transport.pause();
          setPlaying(false);
        }
      } else if (transport.active) {
        const now = transport.current();
        setCursor(Math.max(0, now));
        if (!recordingTick(now) && playingRef.current && projectRef.current) {
          const end = loop ? selection[1] : projectRef.current.playableEndMs;
          if (now >= end) {
            if (loop)
              transport
                .play(selection[0], 0, speed)
                .catch((e) => setError(errorMessage(e)));
            else {
              transport.pause();
              setPlaying(false);
              setCursor(end);
            }
          }
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [loop, selection, speed, projectRef, recordingTick, setError, transport]);
  const showingLive = recording || view === "live";
  const showingTake = !recording && view === "take";
  const readOnly = showingLive || showingTake;
  const takeDuration = selectedTake ? takeLength(selectedTake) : 0;
  const seek = (time: number) => {
    if (recording) return;
    if (showingTake) {
      pause();
      setTakeCursor(clamp(time, 0, takeDuration));
      return;
    }
    transport.seek(time);
    setPlaying(false);
    setCursor(time);
    setDraftJoint(null);
  };
  const play = () =>
    execute(async () => {
      if (recording || !project) return;
      if (showingTake) {
        if (playing) {
          pause();
          return;
        }
        if (!selectedTake) return;
        const positionMs = takeCursor >= takeDuration ? 0 : takeCursor;
        setTakeCursor(positionMs);
        const songPosition =
          selectedTake.offsetMs +
          selectedTake.samples[0].takeTimeMs * selectedTake.timeScale +
          positionMs;
        if (transport.buffer && songPosition < project.durationMs)
          await transport.play(
            Math.max(0, songPosition),
            Math.max(0, -songPosition) / (1000 * speed),
            speed,
          );
        takeClock.current = { positionMs, startTime: performance.now(), speed };
        setPlaying(true);
        return;
      }
      if (playing) {
        seek(transport.current());
        return;
      }
      await transport.play(
        loop
          ? selection[0]
          : cursor >= project.playableEndMs
            ? project.playableStartMs
            : cursor,
        0,
        speed,
      );
      setPlaying(true);
    });
  return {
    ...recorder,
    cursor, setCursor, playing, setPlaying, speed, setSpeed, loop, setLoop, selection, setSelection,
    mode, setMode, view, takeCursor, activeTake, setActiveTake, setTakeCursor, setView, draftJoint, setDraftJoint,
    selectedTake, takeDuration, showingLive, showingTake, readOnly,
    pause, changeView, selectTake, attachTake, openProject, seek, play,
  };
}
