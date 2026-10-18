import { FONT, drawPill, ellipsize, text } from '../ui/draw.ts';
import type { Rect } from '../ui/draw.ts';
import type { Widget } from '../ui/useCanvasUI.ts';
import { MODELS } from '../../../packages/pose/browser/models.ts';
import type { PoseModelId } from '../../../packages/pose/browser/models.ts';
import type { PoseSourceController } from '../../../packages/pose/browser/PoseSourceController.ts';
import type { WebcamStatus } from '../../../packages/pose/browser/WebcamPoseSource.ts';
import type { PoseInputView } from '../pose/PoseSource.ts';

/**
 * The webcam controls Connect Client and the calibration screen share: the camera arrows,
 * the Lite / Full / Heavy tracking buttons and Start camera / Disconnect (Connect Client
 * only; calibration starts the camera from its preview). Each screen lays them out
 * (CameraLayout), adds cameraWidgets() to its widgets and hands presses to
 * CameraSetup.activate().
 *
 * const camera = new CameraSetup(() => ({ source, connection }));
 * widgets: [...cameraWidgets(LAYOUT)]; onActivate: camera.activate(wdg);
 * draw: drawCameraPicker(g, LAYOUT, connection, hover); drawModelPicker(...); drawCameraButton(...);
 */

export interface CameraLayout {
  /** The camera arrows; the camera's name sits between them. */
  prev: Rect;
  next: Rect;
  /** One per tracking model, in MODELS order. */
  models?: readonly Rect[];
  /** Start camera / Disconnect. */
  primary?: Rect;
}
export type CameraWidget = Widget & { cameraDelta?: number; modelId?: PoseModelId };

const ACTIVE: readonly WebcamStatus[] = ['connecting', 'initializing', 'connected'];
const message = (error: unknown) => (error instanceof Error ? error.message : '');

export const cameraWidgets = ({ prev, next, models, primary }: CameraLayout): CameraWidget[] => [
  { id: 'camera-prev', rect: prev, cameraDelta: -1 },
  { id: 'camera-next', rect: next, cameraDelta: 1 },
  ...(models ? MODELS.map((model, i) => ({ id: `model-${model.id}`, rect: models[i], modelId: model.id })) : []),
  ...(primary ? [{ id: 'primary', rect: primary }] : []),
];

/** The camera actions, and the error from the last one that failed. */
export class CameraSetup {
  error = '';
  target: () => { source: PoseSourceController; connection: PoseInputView };
  constructor(target: () => { source: PoseSourceController; connection: PoseInputView }) { this.target = target; }

  /** The camera is on or on its way. */
  active() { return ACTIVE.includes(this.target().connection.status); }
  /** What to tell the player: the last error, or the source's own message. */
  message() { return this.error || this.target().connection.message || ''; }
  failed() { return !!this.error || this.target().connection.status === 'error'; }

  /** Start camera, unless it is on or on its way. */
  start() {
    if (this.active()) return;
    this.error = '';
    this.target().source.connect()?.catch((err: unknown) => { this.error = message(err); });
  }

  /** Start camera, or stop it (also cancels a connection on its way). */
  toggle() {
    if (this.active()) this.target().source.disconnect();
    else this.start();
  }

  /** Handles a camera widget's press; false for any other widget. */
  activate(wdg: CameraWidget) {
    const { source, connection } = this.target();
    if (wdg.modelId) {
      this.error = '';
      void source.configure({ modelId: wdg.modelId }).catch((err: unknown) => { this.error = message(err); });
    } else if (wdg.cameraDelta) {
      const cameras = [{ deviceId: '', label: 'Default camera' }, ...(connection.cameras || [])];
      const index = Math.max(0, cameras.findIndex(camera => camera.deviceId === connection.cameraId));
      const camera = cameras[(index + wdg.cameraDelta + cameras.length) % cameras.length];
      this.error = '';
      void source.configure({ cameraId: camera.deviceId }).catch((err: unknown) => { this.error = message(err); });
    } else if (wdg.id === 'primary') this.toggle();
    else return false;
    return true;
  }
}

/** The camera arrows with the chosen camera's name between them. */
export function drawCameraPicker(g: CanvasRenderingContext2D, layout: CameraLayout, connection: PoseInputView, hover: Record<string, number>) {
  const { prev, next } = layout;
  drawPill(g, prev, { label: '', icon: 'left', hover: hover['camera-prev'] ?? 0 });
  drawPill(g, next, { label: '', icon: 'right', hover: hover['camera-next'] ?? 0 });
  const camera = connection.cameras?.find(camera => camera.deviceId === connection.cameraId);
  const left = prev.x + prev.w;
  g.font = `700 24px ${FONT}`;
  text(g, ellipsize(g, camera?.label || 'Default camera', next.x - left - 40), (left + next.x) / 2, prev.y + prev.h / 2, { size: 24, align: 'center' });
}

/** A button per tracking model; the chosen one is marked. */
export function drawModelPicker(g: CanvasRenderingContext2D, { models }: CameraLayout, connection: PoseInputView, hover: Record<string, number>) {
  if (!models) return;
  MODELS.forEach((model, i) => drawPill(g, models[i], {
    label: `${connection.model === model.id ? '● ' : ''}${model.label}`, icon: 'gear', hover: hover[`model-${model.id}`] ?? 0,
  }));
}

/** Start camera, or Disconnect / Cancel connection while it is on. */
export function drawCameraButton(g: CanvasRenderingContext2D, layout: CameraLayout, setup: CameraSetup, hover: number, press: number) {
  if (!layout.primary) return;
  const { status } = setup.target().connection;
  const active = setup.active();
  const label = active ? (status === 'connected' ? 'Disconnect' : 'Cancel connection') : 'Start camera';
  drawPill(g, layout.primary, { label, icon: active ? 'close' : 'play', hover, press });
}

export const modelDescription = (connection: PoseInputView) => MODELS.find(model => model.id === connection.model)?.description || '';
