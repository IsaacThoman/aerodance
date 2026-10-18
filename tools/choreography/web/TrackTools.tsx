import { clearTrack, interpolateTrack, offsetTrack } from "../core.ts";
import type { ProjectV3 } from "../core.ts";
import type { StudioProject } from "./useStudioProject.ts";
import type { Workspace } from "./useWorkspace.ts";

export interface TrackToolsProps {
  project: ProjectV3;
  studio: StudioProject;
  workspace: Workspace;
  /** Bounded missing intervals per player. */
  fillable: number[];
}

// Per-player track offset, gap interpolation and deletion.
export default function TrackTools({ project, studio, workspace, fillable }: TrackToolsProps) {
  const { busy, execute, modifyTracks, setNotice } = studio;
  const { readOnly, recording, pause } = workspace;
  return (
    <>
      <div className="section-heading">PLAYER TRACKS</div>
      <div className="track-tools">
        {project.tracks.map((t) => (
          <div
            className={`track-controls track-${t.playerId}`}
            key={t.playerId}
          >
            <strong>P{t.playerId + 1} track</strong>
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
    </>
  );
}
