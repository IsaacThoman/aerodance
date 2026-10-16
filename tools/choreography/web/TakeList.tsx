import { useEffect } from "react";
import type { MouseEvent } from "react";
import { finite } from "../../../packages/pose/choreography.ts";
import { overwriteTracks, sourceLabel } from "../core.ts";
import type { ProjectV2, Take, TakeSummary } from "../core.ts";
import type { StudioProject } from "./useStudioProject.ts";
import { takeById } from "./useWorkspace.ts";
import type { Workspace } from "./useWorkspace.ts";

export interface TakeListProps { project: ProjectV2; studio: StudioProject; workspace: Workspace; }
const closeMenu = (e: MouseEvent<HTMLElement>) => {
  const menu = e.currentTarget.closest("details");
  if (menu) menu.open = false;
};

// The project's take library: view a take, copy it onto player tracks, or delete it.
export default function TakeList({ project, studio, workspace }: TakeListProps) {
  const { takes, busy, execute, modifyTracks, refresh, setNotice } = studio;
  const { recording, activeTake, pause, selectTake, setActiveTake, setTakeCursor, setView, setCursor } = workspace;
  useEffect(() => {
    const closeMenus = (e: Event) =>
      document.querySelectorAll<HTMLDetailsElement>(".take-menu[open]").forEach((menu) => {
        if ((e instanceof KeyboardEvent && e.key === "Escape") || !(e.target instanceof Node && menu.contains(e.target))) menu.open = false;
      });
    document.addEventListener("pointerdown", closeMenus);
    document.addEventListener("keydown", closeMenus);
    return () => {
      document.removeEventListener("pointerdown", closeMenus);
      document.removeEventListener("keydown", closeMenus);
    };
  }, []);
  async function deleteTake(take: TakeSummary) {
    if (
      !window.confirm(
        `Delete take “${take.name}”? Assigned P1 and P2 track data will remain intact.`,
      )
    )
      return;
    await execute(async () => {
      pause();
      await studio.deleteTake(take);
      if (activeTake === take.takeId) {
        setActiveTake("");
        setTakeCursor(0);
        setView("playback");
      }
      await refresh();
      setNotice("Take deleted. Assigned tracks were preserved.");
    });
  }
  function assignTake(take: Take, ids: number[]) {
    pause();
    modifyTracks((p, assets) => overwriteTracks(p, take, ids, assets));
    setView("playback");
    setCursor(
      Math.max(0, take.offsetMs + take.samples[0].takeTimeMs * take.timeScale),
    );
    setNotice(
      `Overwrote ${ids.length === 2 ? "both tracks" : `P${ids[0] + 1} track`}. Review alignment before export.`,
    );
  }
  return (
    <>
      <div className="section-heading">
        TAKES <span>{project.takes.length}</span>
      </div>
      <div className="takes">
        {project.takes.map((t) => {
          const take = takeById(takes, t.takeId);
          const hasPlayer = (id: number) =>
            take?.samples.some((s) =>
              s.poses.some((p) => p.playerId === id),
            );
          return (
            <div
              className={`take ${activeTake === t.takeId ? "active" : ""}`}
              key={t.takeId}
            >
              <button
                className="take-select"
                disabled={recording || busy}
                onClick={() => selectTake(t.takeId)}
                aria-label={`View take: ${t.name}`}
              >
                <span className="take-icon">⌁</span>
                <span>
                  <strong>{t.name}</strong>
                  <small>
                    {sourceLabel(t.source)} · {take?.samples.length || 0} samples
                     {t.modelId ? ` · ${t.modelId}${finite(t.sourceRateHz) ? ` · ${t.sourceRateHz.toFixed(1)} poses/s` : ""}` : ""}
                  </small>
                </span>
              </button>
              <details className="take-menu">
                <summary
                  aria-label={`Take actions: ${t.name}`}
                  aria-haspopup="menu"
                >
                  ⋯
                </summary>
                <div role="menu">
                  {[[0], [1], [0, 1]].map((ids) => (
                    <button
                      key={ids.join()}
                      role="menuitem"
                      disabled={recording || busy || !ids.every(hasPlayer)}
                      onClick={(e) => {
                        closeMenu(e);
                        void execute(async () => {
                          if (take) assignTake(take, ids);
                        });
                      }}
                    >
                      {ids.length === 2
                        ? "Overwrite both tracks"
                        : `Overwrite P${ids[0] + 1} track`}
                    </button>
                  ))}
                  <button
                    role="menuitem"
                    className="danger"
                    disabled={recording || busy}
                    onClick={(e) => {
                      closeMenu(e);
                      void deleteTake(t);
                    }}
                  >
                    Delete
                  </button>
                </div>
              </details>
            </div>
          );
        })}
        {!project.takes.length && (
          <p className="empty-note">
            Import a recording or create a new take below.
          </p>
        )}
      </div>
    </>
  );
}
