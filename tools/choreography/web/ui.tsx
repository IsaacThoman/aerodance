import StorageStatus from "./StorageStatus.tsx";
import { request } from "./api.ts";
import type { StudioProject } from "./useStudioProject.ts";
import type { Workspace } from "./useWorkspace.ts";

/** A status light; `color` is green, red, cyan, violet or empty. */
export function Dot({ color }: { color: string }) {
  return <i className={`dot ${color}`} />;
}

export interface LoadingScreenProps { studio: StudioProject; openProject: Workspace["openProject"]; }
// Shown until a project opens, with recovery when none of the saved ones can.
export function LoadingScreen({ studio, openProject }: LoadingScreenProps) {
  const { error, busy, execute, refresh } = studio;
  return (
    <div className="loading">
      <span className="brand-orb" />
      {error ? 'Unable to open saved projects.' : 'Opening Dance Studio…'}
      {error && <>
        <p role="alert">{error}</p>
        <button disabled={busy} onClick={() => execute(async () => {
          await openProject(await request('/api/projects',{method:'POST',body:{}}));
          await refresh();
        })}>Create new project</button>
        <small>Existing projects are preserved.</small>
      </>}
    </div>
  );
}

export interface MessageBarProps { error: string; notice: string; compileError?: string; onDismiss: () => void; }
export function MessageBar({ error, notice, compileError, onDismiss }: MessageBarProps) {
  if (!(error || notice || compileError)) return null;
  return (
    <div
      className={`message ${error || compileError ? "error" : ""}`}
      role={error || compileError ? "alert" : "status"}
    >
      {error || compileError || notice}
      <button
        aria-label="Dismiss message"
        onClick={onDismiss}
      >
        ×
      </button>
    </div>
  );
}

export function StatusBar({ busy, revision }: { busy: boolean; revision: number }) {
  return (
    <footer className="statusbar">
      <span>
        <i className="dot green" />
        LOCAL WORKSPACE · {busy ? "Working…" : "Ready"}
      </span>
      <span>
        Saved in this browser · Download backups to keep your work
      </span>
      <StorageStatus revision={revision} busy={busy} />
    </footer>
  );
}
