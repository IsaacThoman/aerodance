import { JOINT_NAMES } from "../../../packages/pose/choreography.ts";
import type { ProjectV2 } from "../core.ts";
import { OPERATION_NAMES, timeLabel } from "./format.ts";
import { POINT_GROUPS, isPointSelection } from "./pointGroups.ts";
import type { PoseEditor } from "./usePoseEditor.ts";
import type { Workspace } from "./useWorkspace.ts";

export interface PoseInspectorProps { project: ProjectV2; busy: boolean; workspace: Workspace; editor: PoseEditor; }
const AXES = ["x", "y", "z"] as const;

// The selected landmark's coordinates, range edits and recent edit history.
export default function PoseInspector({ project, busy, workspace, editor }: PoseInspectorProps) {
  const { readOnly, showingTake, cursor, playing, selection, seek, setDraftJoint } = workspace;
  const { playerId, setPlayerId, joint, setJoint, pointGroup, setPointGroup, selectedJoint, jointEdit, apply } = editor;
  const rangeValid = selection[1] > selection[0];
  return (
    <>
      <div className="panel-title">
        LANDMARK EDITOR <span className="pill">RAW XYZ</span>
      </div>
      <label>
        Track
        <select
          aria-label="Selected player"
          value={playerId}
          onChange={(e) => {
            setPlayerId(Number(e.target.value));
            setDraftJoint(null);
          }}
        >
          <option value="0">Player 1 · Cyan</option>
          <option value="1">Player 2 · Violet</option>
        </select>
      </label>
      <label>
        Point group
        <select
          aria-label="Selected point group"
          value={pointGroup}
          onChange={(e) => {
            const group = e.target.value;
            if (!isPointSelection(group)) return;
            setPointGroup(group);
            if (group !== "single")
              setJoint(POINT_GROUPS[group].indices[0]);
            setDraftJoint(null);
          }}
        >
          <option value="single">Single joint</option>
          {Object.entries(POINT_GROUPS).map(([key, group]) => (
            <option key={key} value={key}>
              {group.label}
            </option>
          ))}
        </select>
      </label>
      <small>
        Choose a group, then drag any highlighted point to move it
        together.
      </small>
      <label>
        Joint
        <select
          aria-label="Selected joint"
          value={joint}
          onChange={(e) => {
            setJoint(Number(e.target.value));
            setPointGroup("single");
            setDraftJoint(null);
          }}
        >
          {JOINT_NAMES.map((name, i) => (
            <option key={name} value={i}>
              {i} · {name}
            </option>
          ))}
        </select>
      </label>
      <div className="joint-card">
        <span className="eyebrow">SELECTED LANDMARK</span>
        <h2>{JOINT_NAMES[joint]}</h2>
        <small>
          {readOnly
            ? `${showingTake ? "Take" : "Live"} pose · read-only`
            : `at ${timeLabel(cursor)}`}
        </small>
        <div className="coordinates">
          {AXES.map((k) => (
            <label key={k}>
              {k.toUpperCase()}
              <input
                aria-label={`Landmark ${k.toUpperCase()}`}
                type="number"
                step=".001"
                disabled={!selectedJoint || readOnly || busy}
                key={`${playerId}-${joint}-${cursor}-${project.operationCursor}-${selectedJoint?.[k]}`}
                defaultValue={selectedJoint?.[k]?.toFixed(5) || "0"}
                onFocus={() => {
                  if (playing) seek(cursor);
                }}
                onBlur={(e) => {
                  const text = e.currentTarget.value,
                    v = Number(text);
                  if (
                    text.trim() &&
                    Number.isFinite(v) &&
                    selectedJoint &&
                    Math.abs(v - selectedJoint[k]) > 1e-6
                  )
                    jointEdit(
                      playerId,
                      joint,
                      { ...selectedJoint, [k]: v },
                      true,
                    );
                }}
              />
            </label>
          ))}
        </div>
        <div className="confidence">
          <span>
            Visibility{" "}
            <strong>
              {selectedJoint?.visibility === null
                ? "unknown"
                : selectedJoint?.visibility?.toFixed(2) || "—"}
            </strong>
          </span>
          <span>
            Presence{" "}
            <strong>
              {selectedJoint?.presence === null
                ? "unknown"
                : selectedJoint?.presence?.toFixed(2) || "—"}
            </strong>
          </span>
        </div>
      </div>
      <p className="muted small">
        Edits preserve source confidence. Keyframes blend over 150 ms on
        either side; undo restores the previous track data.
      </p>
      <div className="section-heading">SELECTED RANGE</div>
      <div className="edit-actions">
        <button
          disabled={readOnly || busy || !rangeValid}
          onClick={() => apply("swap")}
        >
          ⇄ Swap player tracks
        </button>
        <button
          disabled={readOnly || busy || !rangeValid}
          onClick={() => apply("smooth")}
        >
          ≈ Smooth selected track
        </button>
        <button
          disabled={
            readOnly ||
            !rangeValid ||
            selection[1] - selection[0] > 1000
          }
          onClick={() => apply("repair")}
        >
          ⌁ Repair short gap
        </button>
      </div>
      <div className="section-heading">
        EDIT HISTORY <span>{project.operationCursor}</span>
      </div>
      <ol className="history">
        {project.operations
          .slice(0, project.operationCursor)
          .slice(-8)
          .map((op) => (
            <li key={op.operationId}>
              <strong>{OPERATION_NAMES[op.type]}</strong>
              <small>
                {"startMs" in op && Number.isFinite(op.startMs)
                  ? `${timeLabel(op.startMs)}–${timeLabel(op.endMs)}`
                  : op.playerId === null
                    ? "Both tracks"
                    : `P${op.playerId + 1}`}
              </small>
            </li>
          ))}
      </ol>
    </>
  );
}
