import type { PoseSourceController } from "../../../packages/pose/browser/PoseSourceController.ts";
import { importMotion } from "../core.ts";
import type { ProjectV2 } from "../core.ts";
import { request } from "./api.ts";
import type { AudioTransport } from "./audio.ts";
import CapturePanel from "./CapturePanel.tsx";
import TakeList from "./TakeList.tsx";
import TrackTools from "./TrackTools.tsx";
import type { LiveCapture } from "./useLiveCapture.ts";
import type { StudioProject } from "./useStudioProject.ts";
import type { Workspace } from "./useWorkspace.ts";

export interface LibraryProps {
  project: ProjectV2;
  studio: StudioProject;
  workspace: Workspace;
  live: LiveCapture;
  source: PoseSourceController;
  transport: AudioTransport;
  fillable: number[];
  /** Opens the video import dialog. */
  onImportVideo: (file: File) => void;
}
const AUDIO_TYPES: Readonly<Record<string, string>> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  flac: "audio/flac",
};

// The project's assets: song audio, imported and recorded takes, and player tracks.
export default function Library({ project, studio, workspace, live, source, transport, fillable, onImportVideo }: LibraryProps) {
  const { busy, execute, saveProject, refresh, setNotice } = studio;
  const { recording, openProject, attachTake, pause } = workspace;
  async function importFile(file: File | undefined) {
    if (!file) return;
    await execute(async () => {
      if (file.name.endsWith(".zip")) {
        await saveProject();
        const p = await request("/api/restore", {
          method: "POST",
          body: file,
          headers: { "Content-Type": "application/zip" },
        });
        await openProject(p);
        await refresh();
        return;
      }
      const data: unknown = JSON.parse(await file.text());
      const take = importMotion(data, file.name);
      await request(`/api/projects/${project.projectId}/import`, {
        method: "POST",
        body: take,
      }).then(attachTake);
    });
  }
  async function importAudio(file: File | undefined) {
    if (!file) return;
    await execute(async () => {
      const p = await saveProject();
      const decoded = await transport.load(await file.arrayBuffer());
      let type = file.type;
      const ext = file.name.split(".").at(-1)?.toLowerCase() ?? "";
      if (!type || type === "application/octet-stream")
        type = Object.hasOwn(AUDIO_TYPES, ext) ? AUDIO_TYPES[ext] : "";
      const next = await request(
        `/api/projects/${p.projectId}/audio?durationMs=${decoded.durationMs}&revision=${p.revision}&name=${encodeURIComponent(file.name)}`,
        { method: "POST", body: file, headers: { "Content-Type": type } },
      );
      await openProject(next);
      setNotice(
        "Audio imported. Confirm alignment after reviewing the start and end.",
      );
    });
  }
  return (
    <aside className="library panel">
      <div className="panel-title">
        <span>PROJECT ASSETS</span>
        <span className="pill">LOCAL</span>
      </div>
      <h2>{project.metadata.title}</h2>
      <p className="muted">
        {project.metadata.artist || "Add artist in Song details"}
      </p>
      <label className={`upload-button ${recording ? "disabled" : ""}`}>
        <span>♫</span>
        <div>
          {project.audio ? "Replace song audio" : "Import song audio"}
          <small>
            {project.audio?.name || "MP3, WAV, Ogg, M4A or FLAC"}
          </small>
        </div>
        <input
          type="file"
          accept="audio/*,.m4a,.flac"
          disabled={recording || busy}
          aria-label="Import song audio"
          onChange={(e) => {
            void importAudio(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </label>
      <label className={`upload-button ${recording ? "disabled" : ""}`}>
        <span>⌁</span>
        <div>
          Import pose recording
          <small>JSON or project ZIP</small>
        </div>
        <input
          type="file"
          accept=".json,.zip"
          disabled={recording || busy}
          aria-label="Import pose recording"
          onChange={(e) => {
            void importFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </label>
      <label className={`upload-button ${recording ? "disabled" : ""}`}>
        <span>▷</span>
        <div>Import video<small>Video → pose take · choose a calibration frame</small></div>
        <input type="file" accept="video/*,.mp4,.webm,.mov,.m4v" aria-label="Import video"
          disabled={recording || busy} onChange={e => {
            const file = e.target.files?.[0]; e.target.value = '';
            if (file) {
              pause();
              source.disconnect();
              onImportVideo(file);
            }
          }} />
      </label>
      <TakeList project={project} studio={studio} workspace={workspace} />
      <TrackTools project={project} studio={studio} workspace={workspace} fillable={fillable} />
      <CapturePanel source={source} live={live} studio={studio} workspace={workspace} />
    </aside>
  );
}
