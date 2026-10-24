import { useEffect } from "react";
import type { MouseEvent, SyntheticEvent } from "react";
import { finite } from "../../../packages/pose/choreography.ts";
import { overwriteTracks } from "../core.ts";
import { takeSlots } from "../poseFiles.ts";
import type { ProjectV3, Take, TakeSummary } from "../core.ts";
import type { StudioProject } from "./useStudioProject.ts";
import { takeById } from "./useWorkspace.ts";
import type { Workspace } from "./useWorkspace.ts";

export interface TakeListProps { project: ProjectV3; studio: StudioProject; workspace: Workspace; }
const closeMenu = (e: MouseEvent<HTMLElement>) => {
  const menu = e.currentTarget.closest("details");
  if (menu) menu.open = false;
};
// A menu that would run past the bottom of the sidebar opens upward when there's more room there.
const placeMenu = (e: SyntheticEvent<HTMLDetailsElement>) => {
  const details = e.currentTarget, menu = details.querySelector<HTMLElement>('[role="menu"]'), sidebar = details.closest(".library");
  details.classList.remove("up");
  if (!details.open || !menu || !sidebar) return;
  const box = details.getBoundingClientRect(), side = sidebar.getBoundingClientRect();
  const below = side.bottom - box.bottom, above = box.top - side.top;
  details.classList.toggle("up", menu.offsetHeight > below && above > below);
};
/** A take menu item: copy the take's dancers `from` onto the song's tracks `to`. */
interface Assignment { from: number[]; to: number[]; label: string; }
const names = (ids: readonly number[]) => ids.map((id) => `P${id + 1}`).join(" and ");
/**
 * What a take with `slots` dancers (those it `has`) can fill in a song with `dancers`: each track
 * from the take's dancer of the same number, all of them at once, any track from a solo take's
 * one dancer, and with more than two dancers, the third and fourth tracks from a duet take's.
 */
function assignments(slots: number, dancers: number, has: (id: number) => boolean): Assignment[] {
  const own = Array.from({ length: Math.min(slots, dancers) }, (_, id) => id);
  const items = own.map((id): Assignment => ({ from: [id], to: [id], label: `Overwrite P${id + 1} track` }));
  if (own.length > 1)
    items.push({ from: own, to: own, label: own.length === 2 && dancers === 2 ? "Overwrite both tracks" : own.length === dancers ? "Overwrite all tracks" : `Overwrite ${names(own)} tracks` });
  const present = Array.from({ length: slots }, (_, id) => id).filter(has);
  for (let to = 0; to < dancers; to++)
    for (const from of present)
      if (from !== to && (to >= slots || present.length === 1)) items.push({ from: [from], to: [to], label: `Overwrite P${to + 1} track with take P${from + 1}` });
  if (slots === 2 && dancers === 4) items.push({ from: [0, 1], to: [2, 3], label: "Overwrite P3 and P4 tracks" });
  return items;
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
        `Delete take “${take.name}”? Assigned track data will remain intact.`,
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
      `Overwrote ${to.length === 2 && project.tracks.length === 2 ? "both tracks" : `${names(to)} track${to.length > 1 ? "s" : ""}`}. Review alignment before export.`,
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
          const slots = take ? takeSlots(take) : 2;
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
              <details className="take-menu" onToggle={placeMenu}>
                <summary
                  aria-label={`Take actions: ${t.name}`}
                  aria-haspopup="menu"
                >
                  ⋯
                </summary>
                <div role="menu">
                  {assignments(slots, project.tracks.length, (id) => !!hasPlayer(id)).map((item) => (
                    <button
                      key={item.label}
                      role="menuitem"
                      disabled={recording || busy || !item.from.every(hasPlayer)}
                      onClick={(e) => {
                        closeMenu(e);
                        void execute(async () => {
                          if (take) assignTake(take, item);
                        });
                      }}
                    >
                      {item.label}
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
