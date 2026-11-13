// Recording: the camera's tracked poses, stamped with the song position that was audible when
// each picture was taken, as the game stamps its players' (so a routine and the people who
// dance it share the same timing). A looped section gives one capture per pass.
import type { PoseSourceController } from '../../../../../packages/pose/browser/PoseSourceController.ts';
import type { Landmark } from '../../../../../packages/pose/choreography.ts';
import type { TrackedFrame } from '../../../../../packages/dance/takes.ts';
import type { Transport } from './transport.ts';

export interface Capture {
  /** Which time round the loop this was (0 without a loop). */
  pass: number;
  /** Poses in song time (`videoMs` is the song position), one slot per tracked person. */
  frames: TrackedFrame[];
  width: number; height: number; slots: number;
  /** Poses per second, measured. */
  fps: number;
  /** The share of frames in which each slot was tracked. */
  coverage: number[];
}
export interface RecorderOptions {
  /** People to capture: slot n is the camera's player n. */
  slots: number;
  /** Only poses whose song time is inside this range are kept (e.g. the section, without its count-in). */
  range?: readonly [number, number] | null;
  /** Called as each loop pass ends, with that pass's capture. */
  onPass?: (capture: Capture) => void;
}
const finish = (pass: number, frames: TrackedFrame[], size: { width: number; height: number }, slots: number): Capture => {
  const span = frames.length > 1 ? frames[frames.length - 1].videoMs - frames[0].videoMs : 0;
  return { pass, frames, ...size, slots, fps: span > 0 ? Math.round((frames.length - 1) / span * 10000) / 10 : 0,
    coverage: Array.from({ length: slots }, (_, s) => frames.length ? frames.filter(f => f.poses[s]).length / frames.length : 0) };
};

/** Records the camera against the transport from start() to stop(). */
export class TakeRecorder {
  private readonly source: PoseSourceController;
  private readonly transport: Transport;
  private unsubscribe: (() => void) | null = null;
  private frames: TrackedFrame[] = [];
  private pass = 0;
  private size = { width: 640, height: 480 };
  private options: RecorderOptions = { slots: 1 };
  private done: Capture[] = [];
  constructor(source: PoseSourceController, transport: Transport) { this.source = source; this.transport = transport; }
  get recording() { return this.unsubscribe !== null; }
  /** Poses kept so far in the current pass. */
  get count() { return this.frames.length; }
  start(options: RecorderOptions) {
    this.stop();
    this.options = options; this.frames = []; this.done = []; this.pass = 0;
    this.unsubscribe = this.source.subscribeRecords(event => {
      if (!('record' in event) || !this.transport.state.playing) return;
      const { record } = event, at = event.captureBrowserTimeMs;
      const songMs = Math.round(this.transport.songTimeAt(at) * 10) / 10, pass = this.transport.passAt(at);
      if (pass !== this.pass) { this.flush(); this.pass = pass; }
      const { range } = this.options;
      if (range && (songMs < range[0] || songMs > range[1])) return;
      if (songMs < 0) return;
      // Song time only moves forward within a pass; a late straggler from before a seek is dropped.
      if (this.frames.length && songMs <= this.frames[this.frames.length - 1].videoMs) return;
      this.size = { width: record.input.width, height: record.input.height };
      const poses: (Landmark[] | null)[] = Array.from({ length: this.options.slots }, () => null);
      for (const pose of record.poses) if (pose.playerId < poses.length) poses[pose.playerId] = pose.landmarks;
      this.frames.push({ videoMs: songMs, poses });
    });
  }
  private flush() {
    if (this.frames.length > 1) {
      const capture = finish(this.pass, this.frames, this.size, this.options.slots);
      this.done.push(capture);
      this.options.onPass?.(capture);
    }
    this.frames = [];
  }
  /** Stops and returns every capture: one per completed pass, and the pass in progress. */
  stop(): Capture[] {
    if (!this.unsubscribe) return [];
    this.unsubscribe(); this.unsubscribe = null;
    this.flush();
    return this.done;
  }
}
