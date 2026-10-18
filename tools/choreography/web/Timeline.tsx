import { useMemo } from "react";
import type { PoseSourceView } from "../../../packages/pose/browser/PoseSourceController.ts";
import type { PoseEditor } from "./usePoseEditor.ts";
import { clamp } from "../../../packages/pose/choreography.ts";
import { historyStep, isTrackData } from "../core.ts";
import type { ProjectV3, Take } from "../core.ts";
import { timeLabel } from "./format.ts";
import type { Compiled } from "./useCompiled.ts";
import type { StudioProject } from "./useStudioProject.ts";
import type { Workspace } from "./useWorkspace.ts";

export interface TimelineProps { project: ProjectV3; studio: StudioProject; workspace: Workspace; compiled: Compiled; editor: PoseEditor; connection: PoseSourceView; onConfigure: () => void; }
const SPEEDS = [0.25, 0.5, 1];
const KEY_STEPS: Readonly<Record<string, number>> = {
  ArrowLeft: -10,
  ArrowRight: 10,
  ArrowDown: -10,
  ArrowUp: 10,
};
// Take sample times from the start of the take, on the song clock.
const takeTimes = (take: Take) =>
  take.samples.map((s) => ({
    songTimeMs:
      (s.takeTimeMs -
        take.samples[0].takeTimeMs) *
      take.timeScale,
  }));

// The transport, waveform, player track lanes and the selected range.
export default function Timeline({ project, studio, workspace, compiled, editor, connection, onConfigure }: TimelineProps) {
  const { takes, peaks, busy, edit } = studio;
  const {
    recording, readOnly, showingLive, showingTake, selectedTake, takeDuration, cursor, takeCursor, playing, loop, setLoop, speed, setSpeed,
    selection, setSelection, seek, play, countdown, recordCount, startRecording, stopRecording,
  } = workspace;
  const displayCursor = showingTake ? takeCursor : cursor;
  const duration = (showingTake ? takeDuration : project.durationMs) || 1000,
    percent = clamp((displayCursor / duration) * 100, 0, 100),
    rangeValid = selection[1] > selection[0];
  const samples = () => showingTake && selectedTake ? takeTimes(selectedTake) : compiled.data?.samples || [];
  const tracks = project.tracks, compiledSamples = compiled.data?.samples,
    selectedPlayer = editor.playerId, selectPlayer = editor.selectPlayer;
  const trackLanes = useMemo(() => (
    tracks.map((t) => {
      const asset = t.dataId ? takes.get(t.dataId) : undefined;
      const data = isTrackData(asset) ? asset : undefined;
      const start = data
        ? data.samples[0].takeTimeMs + t.offsetMs
        : 0;
      const end = data
        ? data.samples[data.samples.length - 1].takeTimeMs + t.offsetMs
        : 0;
      return (
        <div
          className={`track-lane track-${t.playerId} ${selectedPlayer === t.playerId ? "selected-track" : ""}`}
          key={t.playerId}
        >
          <button className="lane-label" aria-label={`Select P${t.playerId + 1} timeline track`} aria-pressed={selectedPlayer === t.playerId} onClick={() => selectPlayer(t.playerId)}>P{t.playerId + 1}</button>
          {data && (
            <div
              className="clip"
              style={{
                left: `${(Math.max(0, start) / duration) * 100}%`,
                width: `${(Math.max(0, Math.min(duration, end) - Math.max(0, start)) / duration) * 100}%`,
              }}
            >
              {data.sources
                .map((s) => s.name || s.source)
                .join(", ")}
            </div>
          )}
          {compiledSamples
            ?.filter(
              (s, i) =>
                i % 5 === 0 &&
                !s.poses.some((p) => p.playerId === t.playerId),
            )
            .map((s) => (
              <i
                key={s.songTimeMs}
                className="gap-mark"
                title="Missing pose"
                style={{
                  left: `${(s.songTimeMs / duration) * 100}%`,
                }}
              />
            ))}
        </div>
      );
    })
  ), [tracks, takes, compiledSamples, duration, selectedPlayer, selectPlayer]);
  return (
    <section className="timeline panel">
      <div className="transport">
        <div className="transport-left">
          <button
            aria-label="Previous sample"
            disabled={recording || busy}
            onClick={() => {
              seek(
                [...samples()]
                  .reverse()
                  .find((s) => s.songTimeMs < displayCursor - 0.001)
                  ?.songTimeMs ??
                  (showingTake ? 0 : project.playableStartMs),
              );
            }}
          >
            ❮
          </button>
          <button
            className="play-button"
            aria-label={playing ? "Pause playback" : "Play playback"}
            disabled={
              recording || (showingTake ? !selectedTake : !project.audio)
            }
            onClick={play}
          >
            {playing ? "Ⅱ" : "▶"}
          </button>
          <button
            aria-label="Next sample"
            disabled={recording || busy}
            onClick={() =>
              seek(
                samples().find((s) => s.songTimeMs > displayCursor + 0.001)
                  ?.songTimeMs ??
                  (showingTake ? takeDuration : project.playableEndMs),
              )
            }
          >
            ❯
          </button>
          <span className="timecode">
            {timeLabel(displayCursor)}{" "}
            <small>/ {timeLabel(duration)}</small>
          </span>
        </div>
        <div className="transport-right">
          {showingLive && <>
            <button className={`record-button ${recording ? "recording" : ""}`}
              disabled={busy || (!recording && (!project.audio || connection.status !== "connected" || !connection.snapshot))}
              title={!project.audio ? "Import song audio first" : connection.status !== "connected" ? "Start the camera in Configuration" : undefined}
              onClick={() => recording ? stopRecording() : startRecording()}>
              {recording ? countdown ? "Cancel countdown" : "Stop recording" : "Record new take"}
            </button>
            {!recording && connection.status !== "connected" && <button onClick={onConfigure}>Camera setup</button>}
            {recording && <span className="capture-status" role="status">{countdown ? `Recording in ${countdown}s` : `${recordCount} records captured`}</span>}
          </>}

          <label className="check">
            <input
              type="checkbox"
              checked={loop}
              disabled={recording || showingTake}
              onChange={(e) => setLoop(e.target.checked)}
            />
            Loop selection
          </label>
          <select
            aria-label="Playback speed"
            value={speed}
            disabled={recording || busy}
            onChange={(e) => {
              seek(displayCursor);
              setSpeed(Number(e.target.value));
            }}
          >
            {SPEEDS.map((v) => (
              <option key={v} value={v}>
                {v}×
              </option>
            ))}
          </select>
          <button
            disabled={readOnly || busy || !project.operationCursor}
            onClick={() => edit((p) => historyStep(p, -1))}
          >
            ↶ Undo
          </button>
          <button
            disabled={
              readOnly ||
              busy ||
              project.operationCursor >= project.operations.length
            }
            onClick={() => edit((p) => historyStep(p, 1))}
          >
            ↷ Redo
          </button>
        </div>
      </div>
      <div className="ruler">
        {Array.from({ length: 7 }, (_, i) => (
          <span key={i}>{timeLabel((duration * i) / 6).slice(0, 5)}</span>
        ))}
      </div>
      <div className="timeline-content">
        {!showingTake && project.durationMs > 0 && <div className="playable-overlay" aria-label="Playable range on timeline">
          <div className="outside-playable" style={{ left: 0, width: `${project.playableStartMs / duration * 100}%` }} />
          <div className="outside-playable" style={{ left: `${project.playableEndMs / duration * 100}%`, right: 0 }} />
          <i className="playable-boundary" title={`Playable start ${timeLabel(project.playableStartMs)}`} style={{ left: `clamp(0px, ${project.playableStartMs / duration * 100}%, calc(100% - 2px))` }} />
          <i className="playable-boundary" title={`Playable end ${timeLabel(project.playableEndMs)}`} style={{ left: `clamp(0px, ${project.playableEndMs / duration * 100}%, calc(100% - 2px))` }} />
        </div>}
        <div
          className="timeline-playhead"
          style={{ left: `${percent}%` }}
        />
        <div
          className="selected-range"
          hidden={showingTake}
          style={{
            left: `calc(${(selection[0] / duration) * 100}% + 6px)`,
            width: `max(0px, calc(${((selection[1] - selection[0]) / duration) * 100}% - 12px))`,
          }}
        />
        {!showingTake &&
          [0, 1].map((bound) => (
            <button
              key={bound}
              className={`range-handle range-handle-${bound}`}
              role="slider"
              aria-label={
                bound === 0 ? "Selection start" : "Selection end"
              }
              aria-valuemin={bound === 0 ? 0 : selection[0]}
              aria-valuemax={bound === 0 ? selection[1] : duration}
              aria-valuenow={selection[bound]}
              aria-valuetext={timeLabel(selection[bound])}
              disabled={recording || busy}
              style={{ left: `${(selection[bound] / duration) * 100}%` }}
              onPointerDown={(e) => {
                e.preventDefault();
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                if (!e.currentTarget.hasPointerCapture(e.pointerId))
                  return;
                const rect =
                  e.currentTarget.parentElement?.getBoundingClientRect();
                if (!rect) return;
                const time = Math.round(
                  clamp((e.clientX - rect.left) / rect.width, 0, 1) *
                    duration,
                );
                setSelection((s) =>
                  bound === 0
                    ? [Math.min(time, s[1]), s[1]]
                    : [s[0], Math.max(time, s[0])],
                );
              }}
              onPointerUp={(e) =>
                e.currentTarget.releasePointerCapture(e.pointerId)
              }
              onKeyDown={(e) => {
                const delta = Object.hasOwn(KEY_STEPS, e.key) ? KEY_STEPS[e.key] : undefined;
                if (
                  delta === undefined &&
                  !["Home", "End"].includes(e.key)
                )
                  return;
                e.preventDefault();
                setSelection((s) => {
                  const min = bound === 0 ? 0 : s[0],
                    max = bound === 0 ? s[1] : duration;
                  const time =
                    e.key === "Home"
                      ? min
                      : e.key === "End" || delta === undefined
                        ? max
                        : clamp(
                            s[bound] + delta * (e.shiftKey ? 10 : 1),
                            min,
                            max,
                          );
                  return bound === 0 ? [time, s[1]] : [s[0], time];
                });
              }}
              title={
                bound === 0
                  ? "Drag selection start"
                  : "Drag selection end"
              }
            ></button>
          ))}
        <svg
          className="waveform"
          viewBox="0 0 900 55"
          preserveAspectRatio="none"
          aria-label="Audio waveform"
        >
          {peaks.map((peak, i) => (
            <line
              key={i}
              x1={i * 3}
              x2={i * 3}
              y1={27 - peak * 25}
              y2={27 + peak * 25}
              stroke="#a4cdb8"
              strokeWidth="1.5"
            />
          ))}
        </svg>
        {!showingTake &&
          trackLanes}

        <input
          className="scrubber"
          aria-label={showingTake ? "Take cursor" : "Song cursor"}
          type="range"
          min="0"
          max={duration}
          step="1"
          value={clamp(displayCursor, 0, duration)}
          disabled={recording || busy}
          onChange={(e) => seek(Number(e.target.value))}
        />
      </div>
      <div className="playable-readout" aria-live="polite">
        <strong>{showingTake ? "Song playable" : "Playable"}</strong>
        <span>{timeLabel(project.playableStartMs)} – {timeLabel(project.playableEndMs)}</span>
      </div>
      <div className="range-controls">
        <span>Selection</span>
        <span aria-live="polite">
          {timeLabel(selection[0])} – {timeLabel(selection[1])}
        </span>
        <button
          disabled={recording || showingTake}
          onClick={() =>
            setSelection([project.playableStartMs, project.playableEndMs])
          }
        >
          Select all
        </button>
        <button
          disabled={readOnly || busy || !rangeValid}
          onClick={() =>
            edit((p) => ({
              ...p,
              playableStartMs: selection[0],
              playableEndMs: selection[1],
              alignmentReviewed: false,
            }))
          }
        >
          Set playable range
        </button>
      </div>
    </section>
  );
}
