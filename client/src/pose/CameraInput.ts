import { PoseSourceController } from '../../../packages/pose/browser/PoseSourceController.ts';
import type { CameraInfo, WebcamConfigureOptions, WebcamStatus } from '../../../packages/pose/browser/WebcamPoseSource.ts';
import type { FrameSize, PlayerCount } from '../../../packages/pose/choreography.ts';
import { PhonePoseSource } from './PhonePoseSource.ts';
import type { PhonePairing } from './PhonePoseSource.ts';
import type { PoseInputView, PoseSource, PoseSourceEvent } from './PoseSource.ts';

/*
 * The game's camera: this computer's webcam, or a phone paired as the camera. The phone is
 * one more entry in the camera picker (PHONE_CAMERA, after the webcams), so Connect Client
 * and the calibration screen choose between them with the same arrows. Only the chosen one
 * runs, and only its poses reach the game.
 *
 * const camera = new CameraInput();
 * camera.configure({ cameraId: PHONE_CAMERA.deviceId }); camera.connect();  // pairing starts
 */

export const PHONE_CAMERA: CameraInfo = { deviceId: 'phone', label: 'Phone camera' };

export interface CameraInputView extends PoseInputView {
  sourceKind: 'webcam' | 'phone';
  cameraId: string;
  /** This computer's cameras, then PHONE_CAMERA. */
  cameras: CameraInfo[];
  /** The phone's pairing code and link, while pairing (phone only). */
  pairing: PhonePairing | null;
  /** The phone's frame size, for a preview without video (phone only). */
  frame: FrameSize | null;
}
export interface CameraInputOptions { webcam?: PoseSourceController; phone?: PhonePoseSource; }
type Listener<T> = (value: T) => void;

const ACTIVE: readonly WebcamStatus[] = ['connecting', 'initializing', 'connected'];
const KEY = 'aerodance-camera';
const saved = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
const save = (value: string) => { try { localStorage.setItem(KEY, value); } catch { /* Private browsing. */ } };

export class CameraInput implements PoseSource {
  webcam: PoseSourceController;
  phone: PhonePoseSource;
  mode: 'webcam' | 'phone';
  listeners = new Set<Listener<CameraInputView>>();
  recordListeners = new Set<Listener<PoseSourceEvent>>();
  view: CameraInputView;
  constructor({ webcam = new PoseSourceController(), phone = new PhonePoseSource() }: CameraInputOptions = {}) {
    this.webcam = webcam; this.phone = phone;
    this.mode = saved() === 'phone' ? 'phone' : 'webcam';
    this.view = this.compose();
    webcam.subscribe(() => this.update());
    phone.subscribe(() => this.update());
    webcam.subscribeRecords((event) => { if (this.mode === 'webcam') this.emit(event); });
    phone.subscribeRecords((event) => { if (this.mode === 'phone') this.emit(event); });
  }

  /** The camera feed for the setup preview: this computer's webcam, or the phone's picture while it sends one. */
  get video() { return this.mode === 'webcam' ? this.webcam.video : this.phone.video; }
  get playerCount() { return this.webcam.playerCount; }
  get active() { return this.mode === 'webcam' ? this.webcam : this.phone; }

  compose(): CameraInputView {
    const cameras = [...this.webcam.view.cameras, PHONE_CAMERA];
    if (this.mode === 'phone') return { ...this.phone.view, cameraId: PHONE_CAMERA.deviceId, cameras };
    return { ...this.webcam.view, sourceKind: 'webcam', cameras, pairing: null, frame: null };
  }
  update() {
    this.view = this.compose();
    for (const listener of this.listeners) listener(this.view);
  }
  subscribe(listener: Listener<CameraInputView>) { this.listeners.add(listener); listener(this.view); return () => { this.listeners.delete(listener); }; }
  subscribeRecords(listener: Listener<PoseSourceEvent>) { this.recordListeners.add(listener); return () => { this.recordListeners.delete(listener); }; }
  emit(event: PoseSourceEvent) { for (const listener of this.recordListeners) listener(event); }

  /** Starts the chosen camera (for a phone: pairing). */
  connect() { return this.active.connect(); }
  disconnect() { this.active.disconnect(); }

  /** Picks a camera (PHONE_CAMERA's id for the phone) or a tracking model; a running camera restarts with it. */
  async configure({ modelId, cameraId }: WebcamConfigureOptions = {}) {
    const mode = cameraId === undefined ? this.mode : cameraId === PHONE_CAMERA.deviceId ? 'phone' : 'webcam';
    if (mode === this.mode) {
      if (mode === 'phone') return this.phone.configure({ modelId });
      return this.webcam.configure({ modelId, cameraId });
    }
    const running = ACTIVE.includes(this.view.status);
    this.active.disconnect();
    this.mode = mode;
    save(mode);
    if (mode === 'phone') await this.phone.configure({ modelId });
    else await this.webcam.configure({ modelId, cameraId });
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
