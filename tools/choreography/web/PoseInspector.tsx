import { JOINT_NAMES } from "../../../packages/pose/choreography.ts";
import type { ProjectV3 } from "../core.ts";
import { timeLabel } from "./format.ts";
import { POINT_GROUPS, isPointSelection } from "./pointGroups.ts";
import type { PoseEditor } from "./usePoseEditor.ts";
import type { Workspace } from "./useWorkspace.ts";

export interface PoseInspectorProps { project: ProjectV3; busy: boolean; workspace: Workspace; editor: PoseEditor; }
const AXES = ["x", "y", "z"] as const;

// The selected landmark and its coordinates.
export default function PoseInspector({ project, busy, workspace, editor }: PoseInspectorProps) {
  const { readOnly, showingTake, cursor, playing, seek, setDraftJoint } = workspace;
  const { playerId, joint, setJoint, pointGroup, setPointGroup, selectedJoint, jointEdit } = editor;
  return (
    <>
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
            Confidence{" "}
            <strong>
              {selectedJoint?.confidence === null
                ? "unknown"
                : selectedJoint?.confidence?.toFixed(2) || "—"}
            </strong>
          </span>
        </div>
      </div>
    </>
  );
}
