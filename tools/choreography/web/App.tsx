import { useState } from "react";
import { cleanupSummary } from '../poseCleanup.ts';
import { PoseSourceController } from "../../../packages/pose/browser/PoseSourceController.ts";
import { request } from "./api.ts";
import { AudioTransport } from "./audio.ts";
import Inspector from "./Inspector.tsx";
import Library from "./Library.tsx";
import type { LibraryPanel } from "./Library.tsx";
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
import { validateTake } from '../core.ts';

export default function App() {
  const [source] = useState(() => new PoseSourceController()),
    [transport] = useState(() => new AudioTransport());
  const studio = useStudioProject(transport);
  const live = useLiveCapture(source, studio.project?.tracks.length);
  const workspace = useWorkspace({ transport, source, connection: live.connection, studio, captureMode: live.captureMode, dancers: live.dancers });
  const { compiled, original, fillable } = useCompiled(studio.project, studio.takes);
  const editor = usePoseEditor({ studio, workspace, compiled, connection: live.connection });
  const [panel, setPanel] = useState<LibraryPanel>("assets");
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const { project, error, notice, setError, setNotice } = studio;
  if (!project)
    return <LoadingScreen studio={studio} openProject={workspace.openProject} />;
  return (
    <div className="studio">
      {videoFile && <VideoImportPanel key={`${videoFile.name}-${videoFile.lastModified}-${videoFile.size}`} file={videoFile} projectId={project.projectId} dancers={project.tracks.length} request={request}
        onBusy={studio.setBusy} onImported={async (value, audio) => {
          if (audio) {
            const take = validateTake(value), saved = await studio.saveProject();
            const query = new URLSearchParams({ durationMs: String(audio.durationMs), revision: String(saved.revision), name: audio.file.name, takeId: take.takeId });
            const next = await request(`/api/projects/${saved.projectId}/audio?${query}`, { method: 'POST', body: audio.file, headers: { 'Content-Type': 'audio/wav' } });
            await workspace.openProject(next);
            await studio.refresh();
            workspace.selectTake(take.takeId);
            setNotice('Video take and song audio imported. Review alignment and confidence before exporting.');
          } else workspace.attachTake(value);
          const summary = cleanupSummary(validateTake(value).provenance);
          if (summary) setNotice(`${audio ? 'Video take and song audio imported. ' : 'Video take imported. '}${summary}`);
          setPanel("assets");
        }} onClose={() => setVideoFile(null)} />}
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
        <Library panel={panel} setPanel={setPanel} editor={editor} project={project} studio={studio} workspace={workspace} live={live} source={source}
          transport={transport} fillable={fillable} onImportVideo={setVideoFile} />
        <main className="editor">
          <PreviewPanel dancers={project.tracks.length} trackOptionsOpen={panel === "track"} onTrackOptions={() => setPanel(panel === "track" ? "assets" : "track")} workspace={workspace} editor={editor} live={live} compiled={compiled} original={original} busy={studio.busy} />
          <Timeline project={project} studio={studio} workspace={workspace} compiled={compiled} editor={editor} connection={live.connection} onConfigure={() => setPanel("configuration")} />
        </main>
        <Inspector project={project} studio={studio} workspace={workspace} editor={editor} compiled={compiled} />
      </div>
      <StatusBar busy={studio.busy} />
    </div>
  );
}
