import { clearTrack, interpolateTrack, offsetTrack } from "../core.ts";
import type { ProjectV3 } from "../core.ts";
import type { StudioProject } from "./useStudioProject.ts";
import { timeLabel } from "./format.ts";
import type { PoseEditor } from "./usePoseEditor.ts";
import type { Workspace } from "./useWorkspace.ts";

export interface TrackToolsProps {
  project: ProjectV3;
  studio: StudioProject;
  workspace: Workspace;
  /** Bounded missing intervals per player. */
  fillable: number[];
  editor: PoseEditor;
}

// Per-player track offset, gap interpolation and deletion.
export default function TrackTools({ project, studio, workspace, fillable, editor }: TrackToolsProps) {
  const { busy, execute, modifyTracks, setNotice } = studio;
  const { readOnly, recording, pause } = workspace;
  const { playerId, apply } = editor;
  const rangeValid = workspace.selection[1] > workspace.selection[0];
  return (
    <>
      <h3>P{playerId + 1} track</h3>
      <div className="track-tools">
        {project.tracks.filter(t => t.playerId === playerId).map((t) => (
          <div
            className={`track-controls track-${t.playerId}`}
            key={t.playerId}
          >
            <label>
              Offset (seconds)
              <input
                aria-label={`P${t.playerId + 1} offset (seconds)`}
                type="number"
                step=".01"
                disabled={readOnly || busy || !t.dataId}
                key={`${t.playerId}-${t.offsetMs}`}
                defaultValue={t.offsetMs / 1000}
                onBlur={(e) => {
                  const text = e.currentTarget.value;
                  if (
                    text.trim() &&
                    Number.isFinite(Number(text)) &&
                    Number(text) * 1000 !== t.offsetMs
                  )
                    void execute(async () =>
                      modifyTracks((p) =>
                        offsetTrack(p, t.playerId, Number(text) * 1000),
                      ),
                    );
                }}
              />
            </label>
            <button
              disabled={readOnly || busy || !fillable[t.playerId]}
              onClick={() =>
                execute(async () => {
                  let count = 0;
                  modifyTracks((p, assets) => {
                    const result = interpolateTrack(p, assets, t.playerId);
                    count = result.filled;
                    return result.project;
                  });
                  setNotice(
                    `Interpolated ${count} missing interval${count === 1 ? "" : "s"} for P${t.playerId + 1}. Missing starts/ends remain unchanged; review generated poses before scoring.`,
                  );
                })
              }
            >
              Interpolate P{t.playerId + 1} missing intervals
            </button>
            <button
              className="danger"
              disabled={recording || busy || !t.dataId}
              onClick={() => {
                if (
                  window.confirm(
                    `Delete P${t.playerId + 1} track data? Its poses and edits will be cleared. Library takes and the other track will remain.`,
                  )
                ) {
                  pause();
                  modifyTracks((p) => clearTrack(p, t.playerId));
                }
              }}
            >
              Delete P{t.playerId + 1} track
            </button>
          </div>
        ))}
      </div>
      <h3>Selected range</h3>
      <p className="muted">P{playerId + 1} · {timeLabel(workspace.selection[0])}–{timeLabel(workspace.selection[1])}</p>
      <div className="edit-actions">
        <button disabled={readOnly || busy || !rangeValid} onClick={() => apply("smooth")}>Smooth P{playerId + 1}</button>
        <button disabled={readOnly || busy || !rangeValid || workspace.selection[1] - workspace.selection[0] > 1000}
          onClick={() => apply("repair")}>Repair P{playerId + 1} short gap</button>
        <button disabled={readOnly || busy || !rangeValid} onClick={() => apply("swap")}>Swap both player tracks</button>
      </div>
    </>
  );
}
