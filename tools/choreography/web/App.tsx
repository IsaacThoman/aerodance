import { useState } from "react";
import { PoseSourceController } from "../../../packages/pose/browser/PoseSourceController.ts";
import { request } from "./api.ts";
import { AudioTransport } from "./audio.ts";
import Inspector from "./Inspector.tsx";
import Library from "./Library.tsx";
import PreviewPanel from "./PreviewPanel.tsx";
import ProjectHeader from "./ProjectHeader.tsx";
import Timeline from "./Timeline.tsx";
import { LoadingScreen, MessageBar, StatusBar } from "./ui.tsx";
import { useCompiled } from "./useCompiled.ts";
import { useLiveCapture } from "./useLiveCapture.ts";
import { usePoseEditor } from "./usePoseEditor.ts";
import { useStudioProject } from "./useStudioProject.ts";
import { useWorkspace } from "./useWorkspace.ts";
import VideoImportPanel from "./VideoImportPanel.tsx";

export default function App() {
  const [source] = useState(() => new PoseSourceController()),
    [transport] = useState(() => new AudioTransport());
  const studio = useStudioProject(transport);
  const live = useLiveCapture(source);
  const workspace = useWorkspace({ transport, source, connection: live.connection, studio });
  const { compiled, original, fillable } = useCompiled(studio.project, studio.takes);
  const editor = usePoseEditor({ studio, workspace, compiled, connection: live.connection });
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const { project, error, notice, setError, setNotice } = studio;
  if (!project)
    return <LoadingScreen studio={studio} openProject={workspace.openProject} />;
  return (
    <div className="studio">
      {videoFile && <VideoImportPanel key={`${videoFile.name}-${videoFile.lastModified}-${videoFile.size}`} file={videoFile} projectId={project.projectId} request={request}
        onBusy={studio.setBusy} onImported={workspace.attachTake} onClose={() => setVideoFile(null)} />}
      <ProjectHeader project={project} studio={studio} workspace={workspace} canExport={Boolean(compiled.data)} />
      <MessageBar
        error={error}
        notice={notice}
        compileError={compiled.error}
        onDismiss={() => {
          setError("");
          setNotice("");
        }}
      />
      <div className="workspace">
        <Library project={project} studio={studio} workspace={workspace} live={live} source={source}
          transport={transport} fillable={fillable} onImportVideo={setVideoFile} />
        <main className="editor">
          <PreviewPanel workspace={workspace} editor={editor} live={live} compiled={compiled} original={original} busy={studio.busy} />
          <Timeline project={project} studio={studio} workspace={workspace} compiled={compiled} />
        </main>
        <Inspector project={project} studio={studio} workspace={workspace} editor={editor} compiled={compiled} />
      </div>
      <StatusBar busy={studio.busy} revision={project.revision} />
    </div>
  );
}
