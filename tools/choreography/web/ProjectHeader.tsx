import { useEffect, useRef } from "react";
import type { ProjectV3 } from "../core.ts";
import { downloadName } from "../storage/store.ts";
import { projectSummaries, request, workspace as storage, errorMessage } from "./api.ts";
import type { StudioProject } from "./useStudioProject.ts";
import type { Workspace } from "./useWorkspace.ts";

export interface ProjectHeaderProps {
  project: ProjectV3;
  studio: StudioProject;
  workspace: Workspace;
  /** Whether the project compiles, so a song bundle can be exported. */
  canExport: boolean;
}
const unsupported = (schemaVersion: unknown) => schemaVersion !== 3;

// The project picker, project actions and saving.
export default function ProjectHeader({ project, studio, workspace, canExport }: ProjectHeaderProps) {
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: Event) => {
      const node = menu.current;
      if (!node?.open) return;
      if (event instanceof KeyboardEvent) {
        if (event.key !== "Escape") return;
        node.open = false;
        node.querySelector("summary")?.focus();
      } else if (event.target instanceof Node && !node.contains(event.target)) node.open = false;
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", close); };
  }, []);
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
      a.download = await downloadName(p, kind, bytes);
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
      </div>
      <details className="project-menu" ref={menu}>
        <summary>Project actions</summary>
        <div className="project-menu-items" onClick={event => {
          if (event.target instanceof Element && event.target.closest("button") && menu.current) {
            menu.current.open = false;
            menu.current.querySelector("summary")?.focus();
          }
        }}>
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
          <button disabled={busy || recording} onClick={() => download("backup")}>Backup</button>
          <button
            className="danger"
            disabled={recording || busy}
            onClick={deleteProject}
          >
            Delete project/song
          </button>
        </div>
      </details>
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
