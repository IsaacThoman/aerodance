import { FONT, ICONS, drawDisc, drawPill, ellipsize, text } from '../ui/draw.ts';
import type { Rect } from '../ui/draw.ts';
import type { Widget } from '../ui/useCanvasUI.ts';
import { MODELS } from '../../../packages/pose/browser/models.ts';
import type { WebcamStatus } from '../../../packages/pose/browser/WebcamPoseSource.ts';
import type { CameraInput, CameraInputView } from '../pose/CameraInput.ts';
import type { PoseInputView } from '../pose/PoseSource.ts';

/**
 * The calibration screen's camera controls: the camera arrows (this computer's cameras, then
 * the phone), laid out by CameraLayout. The screen adds cameraWidgets() to its widgets and hands
 * presses to CameraSetup.activate(); the preview starts the camera (CameraSetup.start()). The
 * phone page draws its Lite / Full / Heavy tracking buttons with drawModelPicker().
 *
 * const camera = new CameraSetup(() => ({ source, connection }));
 * widgets: [...cameraWidgets(LAYOUT)]; onActivate: camera.activate(wdg);
 * draw: drawCameraPicker(g, LAYOUT, connection, hover);
 */

export interface CameraLayout {
  /** The camera arrows; the camera's name sits between them. */
  prev: Rect;
  next: Rect;
  /** One per tracking model, in MODELS order (drawModelPicker). */
  models?: readonly Rect[];
}
export type CameraWidget = Widget & { cameraDelta?: number };

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
  /** The code and link to show while waiting for a phone to pair. */
  pairing() {
    const { connection } = this.target();
    return connection.status === 'connecting' ? connection.pairing : null;
  }
  /** What to tell the player: the last error, or the source's own message. */
  message() { return this.error || this.target().connection.message || ''; }
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
      const cameras = [{ deviceId: '', label: 'Default camera' }, ...(connection.cameras || [])];
      const index = Math.max(0, cameras.findIndex(camera => camera.deviceId === connection.cameraId));
      const camera = cameras[(index + wdg.cameraDelta + cameras.length) % cameras.length];
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
  text(g, ellipsize(g, camera?.label || 'Default camera', next.x - left - 40), (left + next.x) / 2, prev.y + prev.h / 2, { size: 24, align: 'center' });
}

/** A button per tracking model; the chosen one is marked. */
export function drawModelPicker(g: CanvasRenderingContext2D, { models }: CameraLayout, connection: PoseInputView, hover: Record<string, number>) {
  if (!models) return;
  MODELS.forEach((model, i) => drawPill(g, models[i], {
    label: `${connection.model === model.id ? '● ' : ''}${model.label}`, icon: 'gear', hover: hover[`model-${model.id}`] ?? 0,
  }));
}
