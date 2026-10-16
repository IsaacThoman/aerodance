import { WebcamPoseSource } from './WebcamPoseSource.ts';
import type { Listener, WebcamConfigureOptions, WebcamRecordEvent, WebcamSnapshot, WebcamView } from './WebcamPoseSource.ts';
import type { PlayerCount } from '../choreography.ts';

/** A webcam snapshot with the clock its times are on. */
export interface PoseSourceSnapshot extends WebcamSnapshot {
  timing: { clockKind: 'browser'; frameTimeMs: number; resultTimeMs: number };
}
export interface PoseSourceView extends Omit<WebcamView, 'snapshot'> { snapshot: PoseSourceSnapshot | null; }
export interface PoseSourceControllerOptions { webcam?: WebcamPoseSource; }

const controllerView = (view: WebcamView): PoseSourceView => ({ ...view, sourceKind: 'webcam', snapshot: view.snapshot ? {
  ...view.snapshot, sourceKind: 'webcam', frameId: view.snapshot.seq,
  timing: { clockKind: 'browser', frameTimeMs: view.snapshot.frameBrowserTimeMs, resultTimeMs: view.snapshot.resultBrowserTimeMs },
} : null });

// The live pose input the game and Dance Studio share: the browser webcam, tracked in a worker.
export class PoseSourceController {
  source: WebcamPoseSource;
  playerCount: PlayerCount;
  listeners = new Set<Listener<PoseSourceView>>();
  recordListeners = new Set<Listener<WebcamRecordEvent>>();
  view: PoseSourceView;
  constructor({ webcam = new WebcamPoseSource() }: PoseSourceControllerOptions = {}) {
    this.source = webcam; this.playerCount = 1;
    this.view = controllerView(this.source.view);
    this.source.subscribe(view => {
      this.view = controllerView(view);
      for (const listener of this.listeners) listener(this.view);
    });
    this.source.subscribeRecords(event => { for (const listener of this.recordListeners) listener(event); });
    void this.refreshCameras().catch(() => {});
  }
  get video() { return this.source.video; }
  subscribe(listener: Listener<PoseSourceView>) { this.listeners.add(listener); listener(this.view); return () => this.listeners.delete(listener); }
  subscribeRecords(listener: Listener<WebcamRecordEvent>) { this.recordListeners.add(listener); return () => this.recordListeners.delete(listener); }
  connect() { return this.source.connect(); }
  disconnect() { this.source.disconnect(); }
  setPlayerCount(count: PlayerCount) { this.playerCount = count; return this.source.setPlayerCount(count); }
  configure(options?: WebcamConfigureOptions) { return this.source.configure(options); }
  refreshCameras() { return this.source.refreshCameras(); }
}
