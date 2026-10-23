import { useState } from "react";
import { clearTrack, interpolateTrack, offsetTrack, mirrorTrack, isTrackData, recalibrateTrack, cleanupTrack } from "../core.ts";
import { cleanupMessage } from '../poseCleanup.ts';
import { reliableBodyPose } from "../../../packages/character/calibration.ts";
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

// Picks one of the other tracks, for mirroring onto or swapping with; nothing to pick in a duet.
function OtherTrack({ label, others, value, disabled, onChange }: {
  label: string; others: number[]; value: number; disabled: boolean; onChange: (id: number) => void;
}) {
  if (others.length < 2) return null;
  return <label>{label}<select aria-label={label} value={value} disabled={disabled} onChange={e => onChange(Number(e.target.value))}>
    {others.map(id => <option key={id} value={id}>P{id + 1}</option>)}
  </select></label>;
}

// Per-player track offset, gap interpolation and deletion.
export default function TrackTools({ project, studio, workspace, fillable, editor }: TrackToolsProps) {
  const { busy, execute, modifyTracks, setNotice } = studio;
  const { readOnly, recording, pause } = workspace;
  const { playerId, apply, selectedPose } = editor;
  // The tracks mirroring and swapping can use: every other one, the next by default.
  const others = project.tracks.map(t => t.playerId).filter(id => id !== playerId);
  const [mirrorChoice, setMirrorTo] = useState<number | null>(null), [swapChoice, setSwapWith] = useState<number | null>(null);
  const pick = (choice: number | null) => choice !== null && others.includes(choice) ? choice : others.find(id => id > playerId) ?? others[0];
  const mirrorTo = pick(mirrorChoice), swapWith = pick(swapChoice);
  const canRecalibrate = selectedPose && reliableBodyPose(selectedPose) && !workspace.draftJoint &&
    workspace.cursor >= project.playableStartMs && workspace.cursor <= project.playableEndMs;
  const rangeValid = workspace.selection[1] > workspace.selection[0];
  const sourceData = studio.takes.get(project.tracks[playerId].dataId ?? '');
  const hasPoses = isTrackData(sourceData) && sourceData.samples.some(s => s.poses.length);
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
              disabled={readOnly || busy || !t.dataId || !canRecalibrate}
              onClick={() => void execute(async () => {
                pause();
                modifyTracks((p, assets) => recalibrateTrack(p, assets, playerId, workspace.cursor));
                setNotice(`Recalibrated P${playerId + 1} body from the skeleton at ${timeLabel(workspace.cursor)}. Undo restores the previous calibration.`);
              })}
            >Recalibrate body from current frame</button>
            <small className="muted">Uses P{playerId + 1}'s edited skeleton for the whole track. Choose an upright frame with shoulders, hips and ankles clearly visible. Undo restores the previous calibration.</small>
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
            {mirrorTo !== undefined && <>
              <OtherTrack label="Mirror to" others={others} value={mirrorTo} disabled={readOnly || busy} onChange={setMirrorTo} />
              <button
                disabled={readOnly || busy || !hasPoses}
                onClick={() => void execute(async () => {
                  pause();
                  modifyTracks((p, assets) => mirrorTrack(p, assets, playerId, mirrorTo));
                  setNotice(`Mirrored P${playerId + 1} to P${mirrorTo + 1}. The destination was replaced. Review reflected poses before scoring; Undo restores the previous track.`);
                })}
              >Mirror P{playerId + 1} track to P{mirrorTo + 1}</button>
              <small className="muted">Mirroring replaces the other track with a reflected copy. Undo restores it.</small>
            </>}
            <button
              className="danger"
              disabled={recording || busy || !t.dataId}
              onClick={() => {
                if (
                  window.confirm(
                    `Delete P${t.playerId + 1} track data? Its poses and edits will be cleared. Library takes and the other ${project.tracks.length > 2 ? "tracks" : "track"} will remain.`,
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
        <button disabled={readOnly || busy || !rangeValid || !hasPoses} onClick={() => void execute(async () => {
          pause();
          modifyTracks((p, assets) => {
            const result = cleanupTrack(p, assets, playerId, workspace.selection[0], workspace.selection[1]);
            setNotice(cleanupMessage(result.counts));
            return result.project;
          });
        })}>Clean up selected range</button>
        <button disabled={readOnly || busy || !rangeValid} onClick={() => apply("smooth")}>Smooth P{playerId + 1}</button>
        <button disabled={readOnly || busy || !rangeValid || workspace.selection[1] - workspace.selection[0] > 1000}
          onClick={() => apply("repair")}>Repair P{playerId + 1} short gap</button>
        {swapWith !== undefined && <>
          <OtherTrack label="Swap with" others={others} value={swapWith} disabled={readOnly || busy} onChange={setSwapWith} />
          <button disabled={readOnly || busy || !rangeValid} onClick={() => apply("swap", { withPlayerId: swapWith })}>
            {others.length === 1 ? "Swap both player tracks" : `Swap P${playerId + 1} and P${swapWith + 1} tracks`}</button>
        </>}
      </div>
    </>
  );
}
