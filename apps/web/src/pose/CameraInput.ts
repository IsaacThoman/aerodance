import { PoseSourceController } from '../../../../packages/pose/browser/PoseSourceController.ts';
import { WebcamPoseSource } from '../../../../packages/pose/browser/WebcamPoseSource.ts';
import { inApp } from '../host.ts';
import type { CameraInfo, WebcamConfigureOptions, WebcamStatus } from '../../../../packages/pose/browser/WebcamPoseSource.ts';
import type { FrameSize, PlayerCount } from '../../../../packages/pose/choreography.ts';
import { PhonePoseSource } from './PhonePoseSource.ts';
import type { PhonePairing } from './PhonePoseSource.ts';
import type { PoseInputView, PoseSource, PoseSourceEvent } from './PoseSource.ts';

/*
 * The game's camera: this computer's webcam, a phone paired as the camera, or none at all.
 * The phone and No camera are more entries in the camera picker (PHONE_CAMERA and NO_CAMERA,
 * after the webcams), so the calibration screen chooses between them with the same arrows.
 * Only the chosen one runs, and only its poses reach the game; with No camera nothing runs.
 *
 * const camera = new CameraInput();
 * camera.configure({ cameraId: PHONE_CAMERA.deviceId }); camera.connect();  // pairing starts
 */

export const PHONE_CAMERA: CameraInfo = { deviceId: 'phone', label: 'Phone camera' };
export const NO_CAMERA: CameraInfo = { deviceId: 'none', label: 'No camera' };

export interface CameraInputView extends PoseInputView {
  sourceKind: 'webcam' | 'phone';
  cameraId: string;
  /** This computer's cameras, then PHONE_CAMERA and NO_CAMERA. */
  cameras: CameraInfo[];
  /** The phone's pairing code and link, while pairing (phone only). */
  pairing: PhonePairing | null;
  /** The phone's frame size, for a preview without video (phone only). */
  frame: FrameSize | null;
}
export interface CameraInputOptions {
  webcam?: PoseSourceController;
  phone?: PhonePoseSource;
  /** Whether this host can use a webcam at all (the Apple TV app can't: it starts on the phone). */
  webcamSupported?: boolean;
}
type Listener<T> = (value: T) => void;

const ACTIVE: readonly WebcamStatus[] = ['connecting', 'initializing', 'connected'];
const KEY = 'aerodance-camera';
const saved = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
const save = (value: string) => { try { localStorage.setItem(KEY, value); } catch { /* Private browsing. */ } };

export class CameraInput implements PoseSource {
  webcam: PoseSourceController;
  phone: PhonePoseSource;
  mode: 'webcam' | 'phone' | 'none';
  listeners = new Set<Listener<CameraInputView>>();
  recordListeners = new Set<Listener<PoseSourceEvent>>();
  view: CameraInputView;
  // In the iPhone/iPad app, a muted camera is iOS holding it for a call: wait for it to come back.
  // The app also looks for three or four players in the whole picture: strips (tiles.ts) work in
  // its WebKit, but each costs a landmarker, about 100 MB more in the process the game runs in (and
  // 160-215 MB in all, measured in the iOS simulator), which hasn't been tried on a device.
  constructor({ webcam = new PoseSourceController({ webcam: new WebcamPoseSource({ interruptedTimeoutMs: inApp() ? Infinity : undefined, tiles: !inApp() }) }), phone = new PhonePoseSource(),
    webcamSupported = !!globalThis.navigator?.mediaDevices?.getUserMedia }: CameraInputOptions = {}) {
    this.webcam = webcam; this.phone = phone;
    const choice = saved();
    this.mode = choice === 'phone' || choice === 'none' ? choice : webcamSupported ? 'webcam' : 'phone';
    this.view = this.compose();
    webcam.subscribe(() => this.update());
    phone.subscribe(() => this.update());
    webcam.subscribeRecords((event) => { if (this.mode === 'webcam') this.emit(event); });
    phone.subscribeRecords((event) => { if (this.mode === 'phone') this.emit(event); });
  }

  /** The camera feed for the setup preview: this computer's webcam, or the phone's picture while it sends one. */
  get video() { return this.mode === 'webcam' ? this.webcam.video : this.mode === 'phone' ? this.phone.video : null; }
  get playerCount() { return this.webcam.playerCount; }
  /** The chosen camera's source (null for No camera). */
  get active() { return this.mode === 'webcam' ? this.webcam : this.mode === 'phone' ? this.phone : null; }

  compose(): CameraInputView {
    const cameras = [...this.webcam.view.cameras, PHONE_CAMERA, NO_CAMERA];
    if (this.mode === 'phone') return { ...this.phone.view, cameraId: PHONE_CAMERA.deviceId, cameras };
    const view: CameraInputView = { ...this.webcam.view, sourceKind: 'webcam', cameras, pairing: null, frame: null };
    // No camera: the webcam's settings (its model) with nothing running.
    if (this.mode === 'none') return { ...view, cameraId: NO_CAMERA.deviceId, status: 'disconnected', message: '', snapshot: null };
    return view;
  }
  update() {
    this.view = this.compose();
    for (const listener of this.listeners) listener(this.view);
  }
  subscribe(listener: Listener<CameraInputView>) { this.listeners.add(listener); listener(this.view); return () => { this.listeners.delete(listener); }; }
  subscribeRecords(listener: Listener<PoseSourceEvent>) { this.recordListeners.add(listener); return () => { this.recordListeners.delete(listener); }; }
  emit(event: PoseSourceEvent) { for (const listener of this.recordListeners) listener(event); }

  /** Starts the chosen camera (for a phone: pairing). */
  async connect() { await this.active?.connect(); }
  disconnect() { this.active?.disconnect(); }

  /** Picks a camera (PHONE_CAMERA's id for the phone, NO_CAMERA's for none) or a tracking model; a running camera restarts with it. */
  async configure({ modelId, cameraId }: WebcamConfigureOptions = {}) {
    const mode = cameraId === undefined ? this.mode : cameraId === PHONE_CAMERA.deviceId ? 'phone' : cameraId === NO_CAMERA.deviceId ? 'none' : 'webcam';
    if (mode === this.mode) {
      if (mode === 'phone') return this.phone.configure({ modelId });
      // No camera keeps the webcam's model for when one is chosen again.
      return this.webcam.configure(mode === 'none' ? { modelId } : { modelId, cameraId });
    }
    const running = ACTIVE.includes(this.view.status);
    this.active?.disconnect();
    this.mode = mode;
    save(mode);
    if (mode === 'phone') await this.phone.configure({ modelId });
    else if (mode === 'webcam') await this.webcam.configure({ modelId, cameraId });
    else await this.webcam.configure({ modelId });
    this.update();
    if (running) await this.connect();
  }

  async setPlayerCount(count: PlayerCount) {
    await this.phone.setPlayerCount(count);
    return this.webcam.setPlayerCount(count);
  }
  refreshCameras() { return this.webcam.refreshCameras(); }
  /** Whether a song is on (a paired phone dims while one plays). */
  setPlaying(playing: boolean) { this.phone.setPlaying(playing); }
  /** Whether a setup preview is on screen (a phone sends its picture only then). */
  setPreview(on: boolean) { this.phone.setPreview(on); }
}
