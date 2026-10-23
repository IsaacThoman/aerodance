import { useEffect, useRef } from "react";
import type { PoseSourceController } from "../../../packages/pose/browser/PoseSourceController.ts";
import { importMotion, validateTake } from "../core.ts";
import { importedPoseFile } from "../poseFiles.ts";
import type { ProjectV3 } from "../core.ts";
import { request } from "./api.ts";
import type { AudioTransport } from "./audio.ts";
import CapturePanel from "./CapturePanel.tsx";
import TakeList from "./TakeList.tsx";
import TrackTools from "./TrackTools.tsx";
import StorageStatus from "./StorageStatus.tsx";
import { OPERATION_NAMES, operationTracks, timeLabel } from "./format.ts";
import type { PoseEditor } from "./usePoseEditor.ts";

import type { LiveCapture } from "./useLiveCapture.ts";
import type { StudioProject } from "./useStudioProject.ts";
import type { Workspace } from "./useWorkspace.ts";

export type LibraryPanel = "assets" | "track" | "import" | "configuration" | "history";
const PANEL_NAMES = { assets: "Project", track: "Track options", import: "Import", configuration: "Configuration", history: "History" } as const;

export interface LibraryProps {
  panel: LibraryPanel;
  setPanel: (panel: LibraryPanel) => void;
  editor: PoseEditor;
  project: ProjectV3;
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
export default function Library({ project, studio, workspace, live, source, transport, fillable, onImportVideo, panel, setPanel, editor }: LibraryProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  const previousPanel = useRef(panel);
  useEffect(() => {
    if (previousPanel.current !== panel) heading.current?.focus();
    previousPanel.current = panel;
  }, [panel]);
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
        setPanel("assets");
        return;
      }
      // .adpose takes and choreography, or the JSON formats earlier tools wrote.
      const take = file.name.endsWith(".adpose")
        ? validateTake(importedPoseFile(new Uint8Array(await file.arrayBuffer()), file.name))
        : importMotion(JSON.parse(await file.text()), file.name);
      await request(`/api/projects/${project.projectId}/import`, {
        method: "POST",
        body: take,
      }).then(attachTake);
      setPanel("assets");
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
      setPanel("assets");
      setNotice(
        "Audio imported. Confirm alignment after reviewing the start and end.",
      );
    });
  }
  return (
    <aside id="project-sidebar" className="library panel">
      <div className="sidebar-heading">
        {panel !== "assets" && <button aria-label="Back to project" onClick={() => setPanel("assets")}>← Back</button>}
        <h2 ref={heading} tabIndex={-1}>{PANEL_NAMES[panel]}</h2>
      </div>
      {panel === "assets" && <>
        <nav className="sidebar-nav" aria-label="Project tools">
          {(["import", "configuration", "history"] as const).map(id =>
            <button key={id} onClick={() => setPanel(id)}>{PANEL_NAMES[id]} <span aria-hidden="true">›</span></button>)}
        </nav>
        <div className="asset-audio"><strong>{project.audio?.name || "No song audio"}</strong>
          {!project.audio && <button onClick={() => setPanel("import")}>Import audio</button>}
        </div>
        <TakeList project={project} studio={studio} workspace={workspace} />
      </>}
      {panel === "import" && <>
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
            <small>.adpose, JSON or project ZIP</small>
          </div>
          <input
            type="file"
            accept=".adpose,.json,.zip"
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
                void execute(async () => {
                  pause();
                  await saveProject();
                  source.disconnect();
                  onImportVideo(file);
                });
              }
            }} />
        </label>
      </>}
      {panel === "track" && <TrackTools project={project} studio={studio} workspace={workspace} fillable={fillable} editor={editor} />}
      {panel === "configuration" && <>
        {workspace.showingLive && <CapturePanel source={source} live={live} studio={studio} workspace={workspace} />}
        <h3>Storage</h3>
        <StorageStatus revision={project.revision} busy={busy} />
      </>}
      {panel === "history" && <>
        <p className="muted">{project.operationCursor} of {project.operations.length} edits applied</p>
        {!project.operations.length && <p className="empty-note">No edits yet.</p>}
        <ol className="history">
          {project.operations.map((op, index) => <li key={op.operationId} className={index >= project.operationCursor ? "undone" : ""}>
            <strong>{OPERATION_NAMES[op.type]}{index >= project.operationCursor ? " (undone)" : ""}</strong>
            <small>{operationTracks(op)}
              {"startMs" in op ? ` · ${timeLabel(op.startMs)}–${timeLabel(op.endMs)}` : ""}</small>
          </li>)}
        </ol>
      </>}
    </aside>
  );
}
