import { useMemo } from "react";
import { compileProject, missingIntervalsFromTimeline, reviewReport, reviewTimeline } from "../core.ts";
import type { CompiledChoreography, ProjectV3, ReviewReport, StudioAssets } from "../core.ts";
import { errorMessage } from "./api.ts";

export interface Compiled { data: CompiledChoreography | null; report: ReviewReport | null; error?: string; }

// Cache pose work independently of song details and save acknowledgements.
export function useCompiled(project: ProjectV3 | null, takes: StudioAssets) {
  const tracks = project?.tracks, projectId = project?.projectId, markers = project?.markers,
    playableStartMs = project?.playableStartMs, playableEndMs = project?.playableEndMs,
    durationMs = project?.durationMs;
  const timeline = useMemo(() => {
    if (!project || !takes.size) return { data: null, error: undefined };
    try { return { data: compileProject({ ...project, metadata: { ...project.metadata, bpm: null } }, takes), error: undefined }; }
    catch (e) { return { data: null, error: errorMessage(e) }; }
    // BPM can be temporarily invalid while typing; only save/export validate metadata.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, tracks, takes, markers, playableStartMs, playableEndMs, durationMs]);
  const analysis = useMemo(() => timeline.data ? reviewTimeline(timeline.data) : null, [timeline.data]);
  const revision = project?.revision;
  const data = useMemo(() => timeline.data ? {
    ...timeline.data,
    provenance: { ...timeline.data.provenance, projectRevision: revision ?? 0 },
  } : null, [timeline.data, revision]);
  const report = useMemo(() => project && data && analysis ? reviewReport(project, data, analysis) : null, [project, data, analysis]);
  const original = useMemo(() => {
    if (!project || !takes.size) return null;
    try {
      return compileProject({ ...project, metadata: { ...project.metadata, bpm: null },
        tracks: project.tracks.map(t => ({ ...t, dataId: t.originalDataId })),
        operations: [], operationCursor: 0,
      }, takes);
    } catch { return null; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, tracks, takes, markers, playableStartMs, playableEndMs, durationMs]);
  const fillable = useMemo(() => [0, 1].map(id => timeline.data ? missingIntervalsFromTimeline(timeline.data, id).length : 0), [timeline.data]);
  return { compiled: { data, report, error: timeline.error } satisfies Compiled, original, fillable };
}
