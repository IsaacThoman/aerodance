import { useCallback, useState } from "react";
import type { PoseSourceView } from "../../../packages/pose/browser/PoseSourceController.ts";
import { copy, sampleSnapshot } from "../../../packages/pose/choreography.ts";
import type { Point3, Pose } from "../../../packages/pose/choreography.ts";
import { appendOperation } from "../core.ts";
import type { EditCommand, JointTarget } from "../core.ts";
import { groupIndices } from "./pointGroups.ts";
import type { PointSelection } from "./pointGroups.ts";
import type { Compiled } from "./useCompiled.ts";
import type { StudioProject } from "./useStudioProject.ts";
import type { Workspace } from "./useWorkspace.ts";

export type InspectorTab = "joint" | "song" | "review";
/** Range edits the inspector offers. */
export type RangeEditType = "swap" | "smooth" | "repair" | "approve" | "exclude";
/** What the preview draws: poses, with quality when they come from a take or the song. */
export interface PreviewSnapshot { poses: Pose[]; }
export interface PoseEditorOptions {
  studio: StudioProject;
  workspace: Workspace;
  compiled: Compiled;
  connection: PoseSourceView;
}
export type PoseEditor = ReturnType<typeof usePoseEditor>;
const EMPTY: PreviewSnapshot = { poses: [] };

// The pose under the cursor, the selected player/joint/point group and the edits made to them.
export function usePoseEditor({ studio, workspace, compiled, connection }: PoseEditorOptions) {
  const { project, busy, modifyTracks } = studio;
  const { cursor, takeCursor, selection, draftJoint, setDraftJoint, readOnly, showingLive, showingTake, selectedTake } = workspace;
  const [tab, setTab] = useState<InspectorTab>("joint"),
    [chosenPlayer, setPlayerId] = useState(0),
    [joint, setJoint] = useState(15),
    [pointGroup, setPointGroup] = useState<PointSelection>("single"),
    [reason, setReason] = useState("Reviewed against audio and source pose");
  // The song's dancers, one track each; the selected one stays among them.
  const dancers = project?.tracks.length ?? 2;
  const playerId = chosenPlayer < dancers ? chosenPlayer : 0;
  let snapshot: PreviewSnapshot = showingLive
    ? connection.snapshot || EMPTY
    : showingTake
      ? selectedTake
        ? sampleSnapshot(
            selectedTake.samples,
            selectedTake.samples[0].takeTimeMs +
              takeCursor / selectedTake.timeScale,
            "takeTimeMs",
          )
        : EMPTY
      : compiled.data
        ? sampleSnapshot(compiled.data.samples, cursor)
        : EMPTY;
  if (draftJoint && !readOnly) {
    snapshot = copy(snapshot);
    const p = snapshot.poses.find((p) => p.playerId === draftJoint.playerId);
    if (p)
      for (const target of draftJoint.targets)
        Object.assign(p.landmarks[target.joint], target.value);
  }
  const selectedPose = snapshot.poses.find((p) => p.playerId === playerId),
    selectedJoint = selectedPose?.landmarks[joint];
  /** All track selectors clear any unfinished drag. */
  const selectPlayer = useCallback((id: number) => {
    if (!Number.isInteger(id) || id < 0 || id >= dancers) return;
    setPlayerId(id);
    setDraftJoint(null);
  }, [setDraftJoint, dancers]);
  /** Selects a joint in the preview. */
  const select = (id: number, index: number) => {
    setPlayerId(id);
    setJoint(index);
    if (
      id !== playerId ||
      !groupIndices(pointGroup)?.includes(index)
    )
      setPointGroup("single");
    setDraftJoint(null);
    if (!readOnly) setTab("joint");
  };
  /** Applies an edit to the selected range; a swap exchanges the selected track with `other` (P1 and P2 without one). */
  const apply = (type: RangeEditType, other?: number) => {
    if (readOnly || busy) return;
    const range = { startMs: selection[0], endMs: selection[1] };
    const command: EditCommand =
      type === "swap"
        ? other === undefined ? { type, ...range, playerId: null } : { type, ...range, playerId, withPlayerId: other }
        : type === "smooth"
          ? { type, ...range, playerId, windowMs: 120 }
          : type === "exclude" || type === "approve"
            ? { type, ...range, playerId, reason }
            : { type, ...range, playerId };
    modifyTracks((p, assets) => appendOperation(p, command, assets));
  };
  /** Moves a joint (and its point group) to `value`: a draft while dragging, a keyframe on commit. */
  function jointEdit(id: number, index: number, value: Point3, commit: boolean) {
    if (readOnly || busy || !project) return;
    setPlayerId(id);
    setJoint(index);
    const base =
      compiled.data &&
      sampleSnapshot(compiled.data.samples, cursor).poses.find(
        (p) => p.playerId === id,
      );
    if (!base) return;
    const group = groupIndices(pointGroup);
    const indices = group?.includes(index) ? group : [index];
    const shift = (i: number, k: keyof Point3) => base.landmarks[i][k] + value[k] - base.landmarks[index][k];
    const targets: JointTarget[] = indices.map((i) => ({
      joint: i,
      value: { x: shift(i, "x"), y: shift(i, "y"), z: shift(i, "z") },
    }));
    if (!commit) {
      setDraftJoint({ playerId: id, targets });
      return;
    }
    setDraftJoint(null);
    const own = targets.find((t) => t.joint === index);
    if (!own) return;
    const time = Math.min(cursor, project.playableEndMs);
    modifyTracks((p, assets) =>
      appendOperation(
        p,
        {
          type: "joint",
          playerId: id,
          joint: index,
          timeMs: time,
          startMs: Math.max(p.playableStartMs, time - 150),
          endMs: Math.min(p.playableEndMs, time + 150),
          value: own.value,
          targets,
        },
        assets,
      ),
    );
  }
  return {
    tab, setTab, playerId, setPlayerId, selectPlayer, dancers, joint, setJoint, pointGroup, setPointGroup, reason, setReason,
    snapshot, selectedPose, selectedJoint, select, apply, jointEdit,
  };
}
