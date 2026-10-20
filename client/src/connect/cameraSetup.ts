import { FONT, ICONS, drawDisc, ellipsize, text } from '../ui/draw.ts';
import type { Rect } from '../ui/draw.ts';
import type { Widget } from '../ui/useCanvasUI.ts';
import type { WebcamStatus } from '../../../packages/pose/browser/WebcamPoseSource.ts';
import { NO_CAMERA, PHONE_CAMERA } from '../pose/CameraInput.ts';
import { inApp } from '../host.ts';
import type { CameraInput, CameraInputView } from '../pose/CameraInput.ts';
import type { PoseInputView } from '../pose/PoseSource.ts';

/**
 * The calibration screen's camera controls: the camera arrows (this computer's cameras, then
 * the phone and No camera), laid out by CameraLayout. The screen adds cameraWidgets() to its widgets and hands
 * presses to CameraSetup.activate(); the preview starts the camera (CameraSetup.start()).
 *
 * const camera = new CameraSetup(() => ({ source, connection }));
 * widgets: [...cameraWidgets(LAYOUT)]; onActivate: camera.activate(wdg);
 * draw: drawCameraPicker(g, LAYOUT, connection, hover);
 */

export interface CameraLayout {
  /** The camera arrows; the camera's name sits between them. */
  prev: Rect;
  next: Rect;
}
export type CameraWidget = Widget & { cameraDelta?: number };

const DEFAULT_CAMERA = { deviceId: '', label: 'Default camera' };
const ACTIVE: readonly WebcamStatus[] = ['connecting', 'initializing', 'connected'];
const message = (error: unknown) => (error instanceof Error ? error.message : '');

export const cameraWidgets = ({ prev, next }: CameraLayout): CameraWidget[] => [
  { id: 'camera-prev', rect: prev, cameraDelta: -1 },
  { id: 'camera-next', rect: next, cameraDelta: 1 },
];

/** The camera actions, and the error from the last one that failed. */
export class CameraSetup {
  error = '';
  target: () => { source: CameraInput; connection: CameraInputView };
  constructor(target: () => { source: CameraInput; connection: CameraInputView }) { this.target = target; }

  /** The camera is on or on its way. */
  active() { return ACTIVE.includes(this.target().connection.status); }
  /** The phone is the chosen camera. */
  phone() { return this.target().connection.sourceKind === 'phone'; }
  /** No camera is chosen: the song plays without one. */
  none() { return this.target().connection.cameraId === NO_CAMERA.deviceId; }
  /** The code and link to show while waiting for a phone to pair. */
  pairing() {
    const { connection } = this.target();
    return connection.status === 'connecting' ? connection.pairing : null;
  }
  /** The camera is on but muted for now (iOS has taken it for a call, or it stopped sending pictures). */
  interrupted() { return !!this.target().connection.interrupted; }
  /** What to tell the player: why the camera is interrupted, the last error, or the source's own message. */
  message() {
    const { connection } = this.target();
    // In the app, iOS gives the camera back after a call; a browser's muted camera fails to Start
    // camera after a while (WebcamPoseSource's interruptedTimeoutMs).
    if (connection.interrupted) return inApp() ? 'The camera was interrupted. It comes back by itself.' : 'The camera stopped sending pictures.';
    return this.error || connection.message || '';
  }
  failed() { return !!this.error || this.target().connection.status === 'error'; }

  /** Start camera, unless it is on or on its way. */
  start() {
    if (this.active()) return;
    this.error = '';
    this.target().source.connect()?.catch((err: unknown) => { this.error = message(err); });
  }

  /** Handles a camera widget's press; false for any other widget. */
  activate(wdg: CameraWidget) {
    const { source, connection } = this.target();
    if (wdg.cameraDelta) {
      // Default camera stands in for this computer's cameras until the browser names them. After
      // that it is one of them (a running default camera takes on its id), so it would come round twice.
      const known = connection.cameras || [];
      const cameras = known.some(camera => ![PHONE_CAMERA.deviceId, NO_CAMERA.deviceId].includes(camera.deviceId)) ? known : [DEFAULT_CAMERA, ...known];
      const index = cameras.findIndex(camera => camera.deviceId === connection.cameraId);
      // From a camera that isn't listed (the default one, or one unplugged), Right goes to the first, Left to the last.
      const next = index < 0 ? (wdg.cameraDelta > 0 ? 0 : cameras.length - 1) : index + wdg.cameraDelta;
      const camera = cameras[(next + cameras.length) % cameras.length];
      this.error = '';
      void source.configure({ cameraId: camera.deviceId }).catch((err: unknown) => { this.error = message(err); });
    } else return false;
    return true;
  }
}

// A camera arrow: the blue disc and chevron on their own, centred in the arrow's hit area.
function drawArrow(g: CanvasRenderingContext2D, rect: Rect, icon: 'left' | 'right', hover: number) {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const r = 24 + hover * 2;
  drawDisc(g, cx, cy, r);
  g.save();
  g.lineJoin = 'round';
  g.lineCap = 'round';
  g.lineWidth = 6;
  g.strokeStyle = '#ffffff';
  ICONS[icon](g, cx, cy, r);
  g.restore();
}

/** The camera arrows with the chosen camera's name between them. */
export function drawCameraPicker(g: CanvasRenderingContext2D, layout: CameraLayout, connection: PoseInputView, hover: Record<string, number>) {
  const { prev, next } = layout;
  drawArrow(g, prev, 'left', hover['camera-prev'] ?? 0);
  drawArrow(g, next, 'right', hover['camera-next'] ?? 0);
  const camera = connection.cameras?.find(camera => camera.deviceId === connection.cameraId);
  const left = prev.x + prev.w;
  g.font = `700 24px ${FONT}`;
  text(g, ellipsize(g, camera?.label || DEFAULT_CAMERA.label, next.x - left - 40), (left + next.x) / 2, prev.y + prev.h / 2, { size: 24, align: 'center' });
}
