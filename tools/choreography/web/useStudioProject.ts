import { useCallback, useRef, useState } from "react";
import { copy } from "../../../packages/pose/choreography.ts";
import { addTake, trackDataIds, validateProject, validateTake, validateTrackData } from "../core.ts";
import type { ProjectSummary, ProjectV3, StudioAssets, Take, TrackData } from "../core.ts";
import { errorMessage, projectSummaries, request, workspace } from "./api.ts";
import type { AudioTransport } from "./audio.ts";

export type ProjectChange = ProjectV3 | ((project: ProjectV3) => ProjectV3);
export type TrackEdit = (project: ProjectV3, assets: StudioAssets) => ProjectV3;
export type StudioProject = ReturnType<typeof useStudioProject>;

/** Validates a project from storage before it is shown. */
export function editableProject(value: unknown): ProjectV3 {
  return validateProject(copy(value));
}

// The open project, its takes and track snapshots, revision-checked saving and status messages.
export function useStudioProject(transport: AudioTransport) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]),
    [project, setProject] = useState<ProjectV3 | null>(null),
    [takes, setTakes] = useState<StudioAssets>(() => new Map()),
    [dirty, setDirty] = useState(false),
    [saveStatus, setSaveStatus] = useState("Saved"),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [peaks, setPeaks] = useState<number[]>([]);
  const assetsRef = useRef(takes),
    persistedTracks = useRef(new Set<string>()),
    savePromise = useRef<Promise<ProjectV3> | null>(null),
    projectRef = useRef(project),
    dirtyRef = useRef(dirty);
  assetsRef.current = takes;
  projectRef.current = project;
  dirtyRef.current = dirty;
  const edit = useCallback((change: ProjectChange) => {
    setProject((p) => (typeof change === "function" ? p && change(copy(p)) : change));
    setDirty(true);
    setSaveStatus("Unsaved");
    setError("");
  }, []);
  /** Runs a user action: marks the studio busy and shows its error. */
  const execute = useCallback(async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError("");
    try {
      return await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }, []);
  const refresh = useCallback(async () => setProjects(projectSummaries(await request("/api/projects"))), []);
  /** Shows a project storage just saved. */
  const install = useCallback((p: ProjectV3) => {
    projectRef.current = p;
    dirtyRef.current = false;
    setProject(p);
    setDirty(false);
    setSaveStatus("Saved");
  }, []);
  const saveProject = useCallback(async (): Promise<ProjectV3> => {
    if (savePromise.current) await savePromise.current;
    const sent = projectRef.current;
    if (!sent) throw Error("Open a project first");
    if (!dirtyRef.current) return sent;
    setSaveStatus("Saving…");
    const job = (async () => {
      for (const dataId of trackDataIds(sent)) {
        if (persistedTracks.current.has(dataId)) continue;
        await request(`/api/projects/${sent.projectId}/tracks`, {
          method: "POST",
          body: assetsRef.current.get(dataId),
        });
        persistedTracks.current.add(dataId);
      }
      return editableProject(await request(`/api/projects/${sent.projectId}`, {
        method: "PUT",
        body: sent,
      }));
    })();
    savePromise.current = job;
    try {
      const next = await job;
      if (projectRef.current === sent) install(next);
      else
        setProject((p) =>
          p?.projectId === sent.projectId
            ? { ...p, revision: next.revision }
            : p,
        );
      setSaveStatus("Saved");
      await refresh();
      return next;
    } catch (e) {
      setSaveStatus("Save failed");
      throw e;
    } finally {
      if (savePromise.current === job) savePromise.current = null;
    }
  }, [install, refresh]);
  /** Loads a validated project's takes, track snapshots and audio, then shows it. */
  const load = useCallback(async (p: ProjectV3) => {
    const entries = await Promise.all(
      p.takes.map(async (t): Promise<[string, Take | TrackData]> => [
        t.takeId,
        validateTake(await request(`/api/projects/${p.projectId}/takes/${t.takeId}`)),
      ]),
    );
    const trackEntries = await Promise.all(
      trackDataIds(p).map(async (dataId): Promise<[string, Take | TrackData]> => [
        dataId,
        validateTrackData(await request(`/api/projects/${p.projectId}/tracks/${dataId}`)),
      ]),
    );
    entries.push(...trackEntries);
    persistedTracks.current = new Set(trackDataIds(p));
    if (p.audio) {
      const audio = await workspace.audio(p.projectId);
      const decoded = await transport.load(await audio.arrayBuffer());
      setPeaks(decoded.peaks);
    } else {
      transport.buffer = null;
      setPeaks([]);
    }
    install(p);
    setTakes(new Map(entries));
  }, [install, transport]);
  /** Applies a track edit that may add snapshots to the assets. */
  const modifyTracks = (fn: TrackEdit) => {
    if (!project) return;
    const assets = new Map(takes),
      next = fn(project, assets);
    assetsRef.current = assets;
    setTakes(assets);
    edit(next);
  };
  const addTakeToProject = useCallback((take: Take) => {
    setTakes((map) => new Map([...map, [take.takeId, take]]));
    edit((p) => addTake(p, take));
  }, [edit]);
  /** Deletes a library take; assigned track snapshots stay. */
  const deleteTake = async (take: Take | { takeId: string }) => {
    const p = await saveProject();
    const next = editableProject(await request(
      `/api/projects/${p.projectId}/takes/${take.takeId}`,
      { method: "DELETE", body: { revision: p.revision } },
    ));
    install(next);
    setTakes((map) => {
      const result = new Map(map);
      result.delete(take.takeId);
      return result;
    });
  };
  /** Deletes the open project, discarding unsaved edits once storage confirms deletion. */
  const deleteProject = async () => {
    // Wait for outstanding writes without trying to save discarded/invalid edits.
    const wasDirty = dirtyRef.current;
    dirtyRef.current = false;
    setDirty(false);
    try {
      const p = await saveProject();
      await request(`/api/projects/${p.projectId}`, {
        method: "DELETE",
        body: { revision: p.revision },
      });
    } catch (e) {
      if (wasDirty) {
        dirtyRef.current = true;
        setDirty(true);
        setSaveStatus("Unsaved");
      }
      throw e;
    }
    dirtyRef.current = false;
    setDirty(false);
  };
  return {
    projects, setProjects, project, takes, dirty, saveStatus, error, setError, notice, setNotice, busy, setBusy, peaks,
    projectRef, dirtyRef,
    edit, execute, refresh, saveProject, load, modifyTracks, addTakeToProject, deleteTake, deleteProject,
  };
}
