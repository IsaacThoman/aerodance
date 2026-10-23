import { useMemo } from "react";
import { sampleSnapshot } from "../../../packages/pose/choreography.ts";
import { takeCalibration } from "../core.ts";
import { takeSlots } from "../poseFiles.ts";
import type { CompiledChoreography } from "../core.ts";
import Preview from "./Preview.tsx";
import type { PreviewTrack } from "./Preview.tsx";
import { groupIndices } from "./pointGroups.ts";
import { Dot } from "./ui.tsx";
import type { Compiled } from "./useCompiled.ts";
import type { LiveCapture } from "./useLiveCapture.ts";
import type { PoseEditor } from "./usePoseEditor.ts";
import type { PreviewMode, Workspace } from "./useWorkspace.ts";

export interface PreviewPanelProps {
  workspace: Workspace;
  editor: PoseEditor;
  live: LiveCapture;
  compiled: Compiled;
  /** The project compiled from its unedited tracks. */
  original: CompiledChoreography | null;
  busy: boolean;
  trackOptionsOpen: boolean;
  onTrackOptions: () => void;
}
const MODES: readonly PreviewMode[] = ["skeleton", "characters", "both"];
// Placeholder dancers until a take or the song provides calibrations.
const FALLBACK_TRACKS: readonly PreviewTrack[] = [0, 1].map((playerId) => ({
  playerId,
  calibration: {
    inputWidth: 640,
    inputHeight: 480,
    torsoLength: 0.2,
    baseHip: { x: playerId === 0 ? 0.75 : 0.25, y: 0.55, z: 0 },
    floorY: 0.9,
    profileVersion: 1,
  },
}));

// The pose preview, what it shows (song, take or live camera) and how.
export default function PreviewPanel({ workspace, editor, live, compiled, original, busy, trackOptionsOpen, onTrackOptions }: PreviewPanelProps) {
  const { recording, countdown, view, mode, setMode, cursor, readOnly, showingLive, showingTake, selectedTake, changeView } = workspace;
  const { connection, liveTracks } = live;
  const { snapshot, selectedPose, playerId, joint, pointGroup, dancers } = editor;
  // A take's dancers: a capture's one or two, or every dancer of a song imported as a take.
  const previewTracks = useMemo(
    () =>
      selectedTake
        ? Array.from({ length: takeSlots(selectedTake) }, (_, playerId) => ({
            playerId,
            calibration: takeCalibration(selectedTake, playerId),
          }))
        : null,
    [selectedTake],
  );
  return (
    <>
      <div className="preview-bar">
        <h1>Preview</h1>
        <div className="segmented" aria-label="Preview mode">
          {MODES.map((v) => (
            <button
              key={v}
              className={mode === v ? "selected" : ""}
              aria-pressed={mode === v}
              onClick={() => setMode(v)}
            >
              {v === "characters"
                ? "Frutiger"
                : v[0].toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
      </div>
      <div className="preview-controls">
        <div className="preview-source segmented" aria-label="Preview source">
          <button
            className={!readOnly ? "selected" : ""}
            aria-pressed={!readOnly}
            disabled={recording || busy}
            onClick={() => {
              changeView("playback");
            }}
          >
            Playback
          </button>
          <button
            className={showingTake ? "selected" : ""}
            aria-pressed={showingTake}
            disabled={recording || !selectedTake}
            onClick={() => changeView("take")}
          >
            Take view
          </button>
          <button
            className={showingLive ? "selected" : ""}
            aria-pressed={showingLive}
            disabled={recording || busy}
            onClick={() => {
              changeView("live");
            }}
          >
            Live view
          </button>
        </div>
        <div className="player-selector" role="group" aria-label="Selected player">
          {Array.from({ length: dancers }, (_, id) => <div key={id} className={`player-control player-${id} ${playerId === id ? "selected" : ""}`}>
            <button className="player-button" aria-label={`Select P${id + 1}`} aria-pressed={playerId === id}
              onClick={() => editor.selectPlayer(id)}>P{id + 1}</button>
            {playerId === id && <button className="player-options" aria-label={`P${id + 1} track options`}
              aria-expanded={trackOptionsOpen} aria-controls="project-sidebar" onClick={onTrackOptions}>Options</button>}
          </div>)}
          <span>{readOnly ? "Viewing" : "Editing"} P{playerId + 1}</span>
        </div>
      </div>
      <Preview
        snapshot={snapshot}
        raw={
          !readOnly && original
            ? sampleSnapshot(original.samples, cursor)
            : null
        }
        tracks={
          showingLive
            ? liveTracks || []
            : showingTake
              ? previewTracks || FALLBACK_TRACKS
              : compiled.data?.tracks || FALLBACK_TRACKS
        }
        mode={mode}
        playerId={playerId}
        joint={joint}
        selectedJoints={groupIndices(pointGroup) || [joint]}
        readOnly={readOnly || busy}
        readOnlyLabel={
          showingTake ? "Take pose skeleton" : "Live pose skeleton"
        }
        mirrored
        emptyMessage={
          showingLive
            ? connection.status === "connected"
              ? "Waiting for live poses"
              : "Live view · " + connection.status
            : showingTake
              ? "No take pose at this time"
              : undefined
        }
        emptyHint={
          showingLive
            ? connection.status === "disconnected"
              ? "Start the camera in Configuration."
              : connection.message || "Step into the camera view."
            : undefined
        }
        onSelect={editor.select}
        onEdit={editor.jointEdit}
      />
      <div className="preview-footer">
        <span>
          {recording ? (
            <>
              <Dot color={countdown ? "" : "red"} />
              {countdown ? `GET READY · ${countdown}s` : "LIVE CAPTURE"}
            </>
          ) : showingTake ? (
            <>TAKE VIEW · {selectedTake?.name} · Read-only</>
          ) : view === "live" ? (
            <>
              <Dot color={connection.status === "connected" ? "green" : ""} />
              LIVE VIEW · Read-only
            </>
          ) : (
            <>↗ Drag a skeleton joint to refine its pose</>
          )}
        </span>
        <span>
          {selectedPose
            ? "33 landmarks · image space"
            : showingLive
              ? "No live tracking"
              : "No tracking at cursor"}
        </span>
      </div>
    </>
  );
}
