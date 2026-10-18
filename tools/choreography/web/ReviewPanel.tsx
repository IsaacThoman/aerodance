import type { ProjectV3 } from "../core.ts";
import type { Compiled } from "./useCompiled.ts";
import type { PoseEditor } from "./usePoseEditor.ts";
import type { Workspace } from "./useWorkspace.ts";

export interface ReviewPanelProps { project: ProjectV3; busy: boolean; workspace: Workspace; editor: PoseEditor; compiled: Compiled; }

// Reference approvals, score exclusions, coverage and the checks song export must pass.
export default function ReviewPanel({ project, busy, workspace, editor, compiled }: ReviewPanelProps) {
  const { recording, readOnly, selection } = workspace;
  const { reason, setReason, apply } = editor;
  const rangeValid = selection[1] > selection[0];
  return (
    <>
      <div className="panel-title">PUBLICATION REVIEW</div>
      <label>
        Review reason
        <textarea
          aria-label="Review reason"
          value={reason}
          disabled={recording || busy}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      <div className="edit-actions">
        <button
          disabled={readOnly || busy || !rangeValid || !reason.trim()}
          onClick={() => apply("approve")}
        >
          ✓ Approve selected references
        </button>
        <button
          disabled={readOnly || busy || !rangeValid || !reason.trim()}
          onClick={() => apply("exclude")}
        >
          ⊘ Exclude range from scoring
        </button>
      </div>
      <p className="muted small">
        Approval is a reference decision. It does not increase measured
        confidence or relax live-input confidence.
      </p>
      {compiled.report?.coverage.map((c) => (
        <div className="coverage" key={c.playerId}>
          <strong>Player {c.playerId + 1}</strong>
          <span>
            {Math.round(
              (c.eligibleMs /
                Math.max(
                  1,
                  project.playableEndMs - project.playableStartMs,
                )) *
                100,
            )}
            % eligible
          </span>
          <small>
            {(c.missingMs / 1000).toFixed(2)} s missing ·{" "}
            {(c.editedMs / 1000).toFixed(2)} s edited
          </small>
        </div>
      ))}
      <div className="section-heading">EXPORT CHECKS</div>
      <ul className="review-list">
        {compiled.report?.blockers.map((b, i) => (
          <li className="blocker" key={i}>
            ● {b}
          </li>
        ))}
        {compiled.report?.warnings.map((b, i) => (
          <li key={i}>△ {b}</li>
        ))}
        {compiled.report && !compiled.report.blockers.length && (
          <li className="passed">✓ Ready for bundle export</li>
        )}
      </ul>
    </>
  );
}
