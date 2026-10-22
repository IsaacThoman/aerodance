import { CONNECTIONS } from '../choreography.ts';
import type { FrameSize, Pose } from '../choreography.ts';

export interface PreviewRect { x: number; y: number; w: number; h: number; }
// Each player's skeleton: P1 cyan and P2 gold as ever, then green and pink.
export const SKELETON = ['#7dffff', '#ffdc70', '#8dffb4', '#ff9fd2'];
export interface PreviewOptions {
  /** Show the picture as a mirror (a camera facing the viewer); false shows it as the camera sees it. */
  mirror?: boolean;
  /** Without video (a phone tracking remotely): the camera frame's size, to draw the poses in. */
  frame?: FrameSize | null;
  /** A one-player preview's label is this player's (P2 when only player 2 is tracked). */
  soloPlayerId?: number;
}

// Shared setup view: mirrored display only; captured landmarks stay canonical. Each tracked
// player is labelled over their head once the camera's picture (or, without one, its frame)
// shows; without either it shows `placeholder` (the caller may draw its own instead). Returns
// where the picture landed inside `rect` (all of it without one).
/** A still picture to preview under the skeletons (a phone's, sent through the pairing relay). */
export interface PreviewFrame { image: CanvasImageSource; width: number; height: number; close?(): void; }
/** What a preview shows: a live video, or the latest still picture. */
export type PreviewPicture = HTMLVideoElement | PreviewFrame;
const isFrame = (picture: PreviewPicture): picture is PreviewFrame => 'image' in picture;
/** The picture's size once it has one to show (a video's first frame has decoded). */
const shownSize = (p: PreviewPicture) => isFrame(p) ? (p.width ? { width: p.width, height: p.height } : null)
  : p.readyState >= 2 && p.videoWidth ? { width: p.videoWidth, height: p.videoHeight } : null;

export function drawWebcamPreview(g: CanvasRenderingContext2D, video: PreviewPicture | null | undefined,
  snapshot: { poses: readonly Pose[] } | null | undefined, rect: PreviewRect, playerCount = 2, placeholder = 'Start camera to preview',
  { mirror = true, frame = null, soloPlayerId = 0 }: PreviewOptions = {}): PreviewRect {
  const { x, y, w, h } = rect;
  let picture: PreviewRect = rect;
  g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip();
  g.fillStyle = '#09273b'; g.fillRect(x, y, w, h);
  const shown = video ? shownSize(video) : null;
  const size = shown ?? (video ? null : frame);
  if (size) {
    const scale = Math.min(w / size.width, h / size.height);
    const dw = size.width * scale, dh = size.height * scale;
    const dx = x + (w - dw) / 2, dy = y + (h - dh) / 2;
    picture = { x: dx, y: dy, w: dw, h: dh };
    if (video && shown) {
      g.save();
      if (mirror) { g.translate(dx + dw, dy); g.scale(-1, 1); } else g.translate(dx, dy);
      g.drawImage(isFrame(video) ? video.image : video, 0, 0, dw, dh);
      g.restore();
    } else {
      g.fillStyle = '#0e3a57'; g.fillRect(dx, dy, dw, dh);
    }
    const px = (p: { x: number }) => dx + (mirror ? 1 - p.x : p.x) * dw;
    for (const pose of snapshot?.poses || []) {
      g.strokeStyle = SKELETON[pose.playerId % SKELETON.length]; g.lineWidth = 2;
      for (const [a, b] of CONNECTIONS) {
        const p = pose.landmarks[a], q = pose.landmarks[b];
        if (Math.min(p.confidence ?? 0, q.confidence ?? 0) < 0.5) continue;
        g.beginPath(); g.moveTo(px(p), dy + p.y * dh); g.lineTo(px(q), dy + q.y * dh); g.stroke();
      }
    }
  }
  g.font = 'bold 16px sans-serif'; g.fillStyle = '#fff'; g.textAlign = 'center';
  // With several players, each is labelled over their head (the tracker follows each person,
  // wherever they stand); one player's label sits at the top.
  if (size && playerCount > 1) {
    g.shadowColor = '#000'; g.shadowBlur = 4;
    for (const pose of snapshot?.poses || []) {
      const head = pose.landmarks.slice(0, 13).filter(p => (p.confidence ?? 0) >= 0.5);
      if (!head.length) continue;
      const top = Math.min(...head.map(p => p.y));
      const cx = head.reduce((sum, p) => sum + (mirror ? 1 - p.x : p.x), 0) / head.length;
      g.fillStyle = SKELETON[pose.playerId % SKELETON.length];
      g.fillText(`P${pose.playerId + 1}`, picture.x + cx * picture.w, Math.max(y + 18, picture.y + top * picture.h - 14));
    }
  } else if (size) g.fillText(`P${soloPlayerId + 1}`, x + w / 2, y + 22);
  if (!video && !frame && placeholder) g.fillText(placeholder, x + w / 2, y + h / 2);
  g.restore();
  return picture;
}
