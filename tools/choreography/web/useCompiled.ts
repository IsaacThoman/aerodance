import { useMemo } from "react";
import { compileProject, missingIntervals, reviewReport } from "../core.ts";
import type { CompiledChoreography, ProjectV3, ReviewReport, StudioAssets } from "../core.ts";
import { errorMessage } from "./api.ts";

export interface Compiled { data: CompiledChoreography | null; report: ReviewReport | null; error?: string; }

// The project compiled for preview and review, the unedited tracks for comparison, and
// how many bounded gaps each player has to interpolate.
export function useCompiled(project: ProjectV3 | null, takes: StudioAssets) {
  const compiled = useMemo((): Compiled => {
    if (!project || !takes.size) return { data: null, report: null };
    try {
      const data = compileProject(project, takes);
      return { data, report: reviewReport(project, data) };
    } catch (e) {
      return { data: null, report: null, error: errorMessage(e) };
    }
  }, [project, takes]);
  const tracks = project?.tracks, playableStartMs = project?.playableStartMs,
    playableEndMs = project?.playableEndMs, durationMs = project?.durationMs;
  const original = useMemo(() => {
    if (!project || !takes.size) return null;
    try {
      return compileProject(
        {
          ...project,
          tracks: project.tracks.map((t) => ({
            ...t,
            dataId: t.originalDataId,
          })),
          operations: [],
          operationCursor: 0,
        },
        takes,
      );
    } catch {
      return null;
    }
    // Intentionally keyed on the timeline only: the unedited poses don't change with song
    // details, so editing metadata doesn't recompile every original track.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks, takes, playableStartMs, playableEndMs, durationMs]);
  const fillable = useMemo(
    () =>
      [0, 1].map((id) => {
        try {
          return project ? missingIntervals(project, takes, id).length : 0;
        } catch {
          return 0;
        }
      }),
    [project, takes],
  );
  return { compiled, original, fillable };
}
