import { FONT, ICONS, drawDarkGlassPanel, drawHeader, drawProgress, drawShadowText, drawStatusDot, ellipsize, paragraph, text } from '../ui/draw.ts';
import type { CanvasUI } from '../ui/useCanvasUI.ts';
import { drawCameraPicker } from '../connect/cameraSetup.ts';
import type { CameraSetup } from '../connect/cameraSetup.ts';
import { drawPairing } from '../connect/pairing.ts';
import { drawWebcamPreview, SKELETON } from '../../../../packages/pose/browser/preview.ts';
import type { CameraInput } from '../pose/CameraInput.ts';
import { WEBCAM_STILL_MS } from './webcamCalibration.ts';
import type { CalibrationPlayerStatus, CalibrationStatus } from './webcamCalibration.ts';
import { gameLayout } from './layout.ts';

/*
 * The camera setup card the song game (GameScreen) and the minigames (minigames/MinigameScreen)
 * both calibrate on: the mirrored preview, which starts the camera when pressed, over the camera
 * picker, each player's status along the top of the preview and the shared stillness hold along
 * its bottom. Laid out by game/layout.ts's GAME_CALIBRATION_* (so play.ts clicks the same
 * targets in both).
 */

/** What the card is for: its players, and whether No camera carries on without one (the song game) or can't (minigames). */
export interface CalibrationOwner { playerCount: number; }
export interface CalibrationCardOptions {
  /** The heading beside the back button. */
  title?: string;
  /** No camera continues without one (the preview is its button); otherwise the card asks for a camera. */
  withoutCamera?: boolean;
  /** The hold wants everyone's feet in view too (webcamCalibration.ts's feet), as the songs' does. */
  feet?: boolean;
}

// Each status's label, colour and a short label for the narrow columns of three or four players.
const CALIBRATION_STATUS: Record<CalibrationPlayerStatus, [label: string, color: string, short: string]> = {
  missing: ['Step into view', '#ffffff', 'Step in'],
  body: ['Keep your whole body in view', '#ffe27a', 'Whole body'],
  moving: ['Movement detected — hold still', '#ffe27a', 'Hold still!'],
  holding: ['Hold still…', '#bff4ff', 'Hold still…'],
  ready: ['Calibrated!', '#9effdf', 'Calibrated!'],
};
// Without feet, a player's body is in view once their shoulders and hips are.
const UPPER_BODY: [label: string, color: string, short: string] = ['Keep your shoulders and hips in view', '#ffe27a', 'Step back'];

// The webcam setup card, centred: the mirrored preview, then the camera picker. Over the
// preview, each player's status along the top and the shared hold along the bottom. With the
// camera off, the preview is a big Start camera button (or with No camera, a button that plays
// without one).
/** Where each player last stood in the calibration preview (mirrored, as a fraction of its width). */
const lastStood = new WeakMap<CalibrationOwner, number[]>();
export function drawCalibration(g: CanvasRenderingContext2D, owner: CalibrationOwner, calibration: CalibrationStatus, camera: CameraSetup, s: CanvasUI,
  { title = 'CALIBRATION', withoutCamera = true, feet = true }: CalibrationCardOptions = {}) {
  const { GAME_READY_BACK, GAME_CALIBRATION_CARD, GAME_CALIBRATION_PREVIEW, GAME_CALIBRATION_CAMERA, GAME_CALIBRATION_PROGRESS } = gameLayout(s.w);
  const h = s.hover;
  const { connection, source } = camera.target();
  const preview = GAME_CALIBRATION_PREVIEW;
  const mid = preview.x + preview.w / 2;
  const live = connection.status === 'connected';
  drawHeader(g, GAME_READY_BACK, title, h.quit ?? 0);
  drawDarkGlassPanel(g, GAME_CALIBRATION_CARD, 30);

  const picture = drawWebcamPreview(g, source.video, connection.snapshot, preview, owner.playerCount, '', { frame: connection.frame, labelTop: preview.y + 66 });
  const pairing = camera.pairing();
  // The pairing card goes up as soon as the phone is picked; its code fills in once it comes.
  if (pairing || camera.awaitingCode()) drawPairing(g, { x: preview.x + 40, y: preview.y + 30, w: preview.w - 80, h: preview.h - 60 }, pairing);
  else if (!source.video && !connection.frame) drawStartCamera(g, camera, s, withoutCamera);
  drawCameraPicker(g, GAME_CALIBRATION_CAMERA, connection, h);

  if (live) {
    // The hold sits on a fade along the bottom, to read over the camera's picture.
    const top = preview.y + preview.h - 110;
    const fade = g.createLinearGradient(0, top, 0, preview.y + preview.h);
    fade.addColorStop(0, 'rgba(4, 34, 61, 0)');
    fade.addColorStop(1, 'rgba(4, 34, 61, 0.85)');
    g.fillStyle = fade;
    g.fillRect(preview.x, top, preview.w, 110);
    // The players' statuses sit on a fade along the top, too.
    const head = g.createLinearGradient(0, preview.y, 0, preview.y + 72);
    head.addColorStop(0, 'rgba(4, 34, 61, 0.75)');
    head.addColorStop(1, 'rgba(4, 34, 61, 0)');
    g.fillStyle = head;
    g.fillRect(preview.x, preview.y, preview.w, 72);
    // Each player's status under their label, in a column each across the camera picture in the
    // order they stand (mirrored, as the preview shows them; a player out of view keeps where
    // they last stood, or their number's place), short where the columns are narrow. The preview
    // labels each player over their head in the same colour.
    const column = picture.w / owner.playerCount;
    const crowd = owner.playerCount > 2;
    const size = crowd ? 17 : 20;
    const stood = lastStood.get(owner) ?? Array.from({ length: owner.playerCount }, (_, id) => (id + 0.5) / owner.playerCount);
    lastStood.set(owner, stood);
    const standing = (id: number) => {
      const pose = connection.snapshot?.poses.find(p => p.playerId === id);
      if (pose) stood[id] = 1 - (pose.landmarks[23].x + pose.landmarks[24].x) / 2;
      return stood[id];
    };
    const columns = calibration.players.map((_, id) => id).sort((a, b) => standing(a) - standing(b));
    calibration.players.forEach((status, id) => {
      const [label, color, short] = !feet && status === 'body' ? UPPER_BODY : CALIBRATION_STATUS[status];
      const cx = picture.x + column * (columns.indexOf(id) + 0.5);
      // (One player's label too: the fade dims the preview's own.)
      drawShadowText(g, `P${id + 1}`, cx, preview.y + 24, { size: 16, weight: 800, align: 'center', color: SKELETON[id % SKELETON.length] });
      g.font = `800 ${size}px ${FONT}`;
      const fits = !crowd && g.measureText(label).width <= column - 24;
      drawShadowText(g, ellipsize(g, fits ? label : short, column - 24), cx, preview.y + 50, { size, weight: 800, align: 'center', color });
    });
    const remaining = ((1 - calibration.progress) * WEBCAM_STILL_MS / 1000).toFixed(1);
    const message = calibration.complete ? 'Calibrated! Starting…'
      : calibration.progress > 0 ? `Keep still · ${remaining} seconds to go`
      : owner.playerCount > 2 && calibration.players.includes('missing') ? (feet ? 'Stand side by side, feet in view' : 'Stand side by side')
      : 'Stand still for 2.5 seconds';
    drawShadowText(g, message, mid, GAME_CALIBRATION_PROGRESS.y - 24, { size: 22, weight: 800, align: 'center' });
    drawProgress(g, GAME_CALIBRATION_PROGRESS, calibration.progress);
  }
}

// Over the empty preview: a camera button while the camera is off (the whole preview presses
// it, and shows why the last start failed), or a note while it starts. With No camera, the
// button continues without one, or (withoutCamera false) the card asks for a camera.
function drawStartCamera(g: CanvasRenderingContext2D, camera: CameraSetup, s: CanvasUI, withoutCamera: boolean) {
  const { GAME_CALIBRATION_PREVIEW } = gameLayout(s.w);
  const preview = GAME_CALIBRATION_PREVIEW;
  const cx = preview.x + preview.w / 2;
  const cy = preview.y + preview.h / 2;
  const phone = camera.phone();
  const none = camera.none();
  if (camera.active()) {
    text(g, phone ? 'Connecting to your phone…' : 'Starting camera…', cx, cy, { size: 24, weight: 700, align: 'center', color: '#e6f8ff' });
    return;
  }
  const failed = !none && camera.failed();
  const top = failed || (none && !withoutCamera) ? cy - 40 : cy;
  const hover = none && !withoutCamera ? 0 : s.hover[none ? 'skip' : 'start-camera'] ?? 0;
  g.save();
  g.fillStyle = `rgba(120, 220, 255, ${hover * 0.08})`;
  g.fillRect(preview.x, preview.y, preview.w, preview.h);
  g.globalAlpha *= none && !withoutCamera ? 0.5 : 0.85 + hover * 0.15;
  g.strokeStyle = '#ffffff';
  g.lineWidth = 6;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  (none ? ICONS.noCamera : phone ? ICONS.phone : ICONS.camera)(g, cx, top - 24, 100);
  g.restore();
  text(g, failed ? 'Try again' : none ? 'No camera' : 'Start camera', cx, top + 44, { size: 26, weight: 800, align: 'center' });
  if (failed) paragraph(g, camera.message(), cx, top + 86, preview.w - 120, { size: 19, lineH: 25, align: 'center', color: '#ffb38a' });
  else if (none && !withoutCamera) paragraph(g, 'Experiments are played with your body: pick a camera with the arrows.', cx, top + 86, preview.w - 120, { size: 20, lineH: 26, align: 'center', color: '#e6f8ff' });
}

// Under the pause panel while the camera is muted: why nobody is tracked, after its status light
// (as on the calibration screen).
export function drawCameraInterrupted(g: CanvasRenderingContext2D, camera: CameraSetup, status: CameraInput['view']['status'], y: number, width: number) {
  g.font = `700 24px ${FONT}`;
  const message = ellipsize(g, camera.message(), width - 140);
  const x = width / 2 - g.measureText(message).width / 2 + 14;
  drawStatusDot(g, x - 26, y, status, 9);
  drawShadowText(g, message, x, y, { size: 24, weight: 700 });
}
