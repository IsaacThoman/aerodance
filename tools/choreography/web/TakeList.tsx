import { useEffect } from "react";
import type { MouseEvent } from "react";
import { finite } from "../../../packages/pose/choreography.ts";
import { overwriteTracks } from "../core.ts";
import type { ProjectV3, Take, TakeSummary } from "../core.ts";
import type { StudioProject } from "./useStudioProject.ts";
import { takeById } from "./useWorkspace.ts";
import type { Workspace } from "./useWorkspace.ts";
import { playerList } from "./players.ts";

export interface TakeListProps { project: ProjectV3; studio: StudioProject; workspace: Workspace; }
const closeMenu = (e: MouseEvent<HTMLElement>) => {
  const menu = e.currentTarget.closest("details");
  if (menu) menu.open = false;
};
/** One way to copy a take onto tracks: its dancers `from` onto the tracks `to`. */
interface Assignment { from: number[]; to: number[]; label: string; enabled: boolean; }
/**
 * A take menu's track actions for a song with tracks `tracks`: each track from the take's
 * dancer of the same number, a solo take's dancer onto any other track, and every track the
 * take has a dancer for at once.
 */
function assignments(tracks: readonly number[], dancers: readonly number[]): Assignment[] {
  const has = (id: number) => dancers.includes(id);
  const list: Assignment[] = tracks.map(id => ({ from: [id], to: [id], label: `Overwrite P${id + 1} track`, enabled: has(id) }));
  const [solo] = dancers;
  if (dancers.length === 1) for (const id of tracks) if (id !== solo)
    list.push({ from: [solo], to: [id], label: `Copy P${solo + 1} to P${id + 1} track`, enabled: true });
  if (tracks.length > 1) {
    const both = tracks.filter(has), all = both.length === tracks.length || both.length < 2;
    list.push({ from: both, to: both, enabled: both.length > 1,
      label: all ? tracks.length === 2 ? "Overwrite both tracks" : "Overwrite all tracks" : `Overwrite ${playerList(both)} tracks` });
  }
  return list;
}

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
        `Delete take “${take.name}”? Assigned ${playerList(project.tracks.map((t) => t.playerId))} track data will remain intact.`,
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
  function assignTake(take: Take, { from, to }: Assignment) {
    pause();
    modifyTracks((p, assets) => overwriteTracks(p, take, from, assets, to));
    setView("playback");
    setCursor(
      Math.max(0, take.offsetMs + take.samples[0].takeTimeMs * take.timeScale),
    );
    setNotice(
      `Overwrote ${to.length === project.tracks.length && to.length > 1 ? to.length === 2 ? "both tracks" : "all tracks"
        : to.length > 1 ? `${playerList(to)} tracks` : `P${to[0] + 1} track${from[0] === to[0] ? "" : ` with P${from[0] + 1}`}`}. Review alignment before export.`,
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
          const dancers = [...new Set(take?.samples.flatMap((s) => s.poses.map((p) => p.playerId)) ?? [])].sort((a, b) => a - b);
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
                    {t.source} · {take?.samples.length || 0} samples
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
                  {assignments(project.tracks.map((track) => track.playerId), dancers).map((a) => (
                    <button
                      key={a.label}
                      role="menuitem"
                      disabled={recording || busy || !a.enabled}
                      onClick={(e) => {
                        closeMenu(e);
                        void execute(async () => {
                          if (take) assignTake(take, a);
                        });
                      }}
                    >
                      {a.label}
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
            No takes yet. Import a recording or record a take.
          </p>
        )}
      </div>
    </>
  );
}
