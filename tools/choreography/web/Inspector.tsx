import type { ProjectV2 } from "../core.ts";
import PoseInspector from "./PoseInspector.tsx";
import ReviewPanel from "./ReviewPanel.tsx";
import SongDetails from "./SongDetails.tsx";
import type { Compiled } from "./useCompiled.ts";
import type { InspectorTab, PoseEditor } from "./usePoseEditor.ts";
import type { StudioProject } from "./useStudioProject.ts";
import type { Workspace } from "./useWorkspace.ts";

export interface InspectorProps { project: ProjectV2; studio: StudioProject; workspace: Workspace; editor: PoseEditor; compiled: Compiled; }
const TABS: readonly (readonly [InspectorTab, string])[] = [
  ["joint", "Pose inspector"],
  ["song", "Song details"],
  ["review", "Review"],
];

export default function Inspector({ project, studio, workspace, editor, compiled }: InspectorProps) {
  const { tab, setTab } = editor;
  return (
    <aside className="inspector panel">
      <div className="inspector-tabs">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            className={tab === id ? "selected" : ""}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "joint" && (
        <PoseInspector project={project} busy={studio.busy} workspace={workspace} editor={editor} />
      )}
      {tab === "song" && (
        <SongDetails project={project} studio={studio} recording={workspace.recording} />
      )}
      {tab === "review" && (
        <ReviewPanel project={project} busy={studio.busy} workspace={workspace} editor={editor} compiled={compiled} />
      )}
    </aside>
  );
}
