import type { ProjectV2 } from "../core.ts";
import { projectSummaries, request, workspace as storage, errorMessage } from "./api.ts";
import type { StudioProject } from "./useStudioProject.ts";
import type { Workspace } from "./useWorkspace.ts";

export interface ProjectHeaderProps {
  project: ProjectV2;
  studio: StudioProject;
  workspace: Workspace;
  /** Whether the project compiles, so a song bundle can be exported. */
  canExport: boolean;
}
const unsupported = (schemaVersion: unknown) => schemaVersion != null && schemaVersion !== 1 && schemaVersion !== 2;

// The project picker, project actions and saving.
export default function ProjectHeader({ project, studio, workspace, canExport }: ProjectHeaderProps) {
  const { projects, busy, dirty, saveStatus, execute, saveProject, refresh, setNotice } = studio;
  const { recording, pause, openProject } = workspace;
  async function download(kind: "backup" | "export") {
    await execute(async () => {
      let p = project;
      try { p = await saveProject(); }
      catch (error) {
        if (kind !== "backup") throw error;
        studio.setError(`${errorMessage(error)} Backup contains the last saved revision; current unsaved edits are not included.`);
      }
      const bytes = await storage.download(p.projectId, kind);
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" })),
        a = document.createElement("a");
      a.href = url;
      a.download = `${p.songId}${kind === "backup" ? ".aerodance-project.zip" : `-r${p.revision}.aerodance-song.zip`}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }
  async function deleteProject() {
    if (
      !window.confirm(
        `Delete project/song “${project.metadata.title}”? Its music, tracks, takes, and saved project data will be permanently removed.`,
      )
    )
      return;
    await execute(async () => {
      pause();
      await studio.deleteProject();
      const list = projectSummaries(await request("/api/projects"));
      const next = list.length
        ? await request(`/api/projects/${list[0].projectId}`)
        : await request("/api/projects", { method: "POST", body: {} });
      await openProject(next);
      await refresh();
      setNotice("Project/song deleted.");
    });
  }
  return (
    <header className="topbar">
      <a className="brand" href="/" aria-label="Dance Studio">
        <span className="brand-orb" />
        <div>
          AERODANCE <strong>Dance Studio</strong>
        </div>
      </a>
      <div className="project-picker">
        <select
          aria-label="Open project"
          value={project.projectId}
          disabled={recording || busy}
          onChange={(e) => {
            const projectId = e.currentTarget.value;
            return execute(async () => {
              await saveProject();
              await openProject(
                await request(`/api/projects/${projectId}`),
              );
            });
          }}
        >
          {projects.map((p) => (
            <option value={p.projectId} key={p.projectId} disabled={unsupported(p.schemaVersion)}>
              {p.title}{unsupported(p.schemaVersion) ? ` (unsupported project format ${p.schemaVersion})` : ''}
            </option>
          ))}
        </select>
        <button
          disabled={recording || busy}
          onClick={() =>
            execute(async () => {
              await saveProject();
              await openProject(
                await request("/api/projects", { method: "POST", body: {} }),
              );
              await refresh();
            })
          }
        >
          ＋ New
        </button>
      </div>
      <button
        className="danger"
        disabled={recording || busy}
        onClick={deleteProject}
      >
        Delete project/song
      </button>
      <div className="header-actions">
        <span className={`save-state ${dirty ? "unsaved" : ""}`}>
          {saveStatus}
        </span>
        <button
          disabled={busy || recording}
          onClick={() => execute(saveProject)}
        >
          Save
        </button>
        <button
          disabled={busy || recording}
          onClick={() => download("backup")}
        >
          Backup
        </button>
        <button
          className="primary"
          disabled={busy || recording || !canExport}
          onClick={() => download("export")}
        >
          Export song ↗
        </button>
      </div>
    </header>
  );
}
