import { CONNECTIONS } from '../choreography.ts';
import type { FrameSize, Pose } from '../choreography.ts';

export interface PreviewRect { x: number; y: number; w: number; h: number; }
export interface PreviewOptions {
  /** Show the picture as a mirror (a camera facing the viewer); false shows it as the camera sees it. */
  mirror?: boolean;
  /** Without video (a phone tracking remotely): the camera frame's size, to draw the poses in. */
  frame?: FrameSize | null;
  /** A one-player preview's label is this player's (P2 when only player 2 is tracked). */
  soloPlayerId?: number;
}

// Shared setup view: mirrored display only; captured landmarks stay canonical. The player
// lanes show once the camera's picture (or, without one, its frame) does; without either it
// shows `placeholder` (the caller may draw its own instead).
export function drawWebcamPreview(g: CanvasRenderingContext2D, video: HTMLVideoElement | null | undefined,
  snapshot: { poses: readonly Pose[] } | null | undefined, rect: PreviewRect, playerCount = 2, placeholder = 'Start camera to preview',
  { mirror = true, frame = null, soloPlayerId = 0 }: PreviewOptions = {}) {
  const { x, y, w, h } = rect;
  g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip();
  g.fillStyle = '#09273b'; g.fillRect(x, y, w, h);
  const showing = !!video && video.readyState >= 2 && !!video.videoWidth;
  const size = video && showing ? { width: video.videoWidth, height: video.videoHeight } : video ? null : frame;
  if (size) {
    const scale = Math.min(w / size.width, h / size.height);
    const dw = size.width * scale, dh = size.height * scale;
    const dx = x + (w - dw) / 2, dy = y + (h - dh) / 2;
    if (video && showing) {
      g.save();
      if (mirror) { g.translate(dx + dw, dy); g.scale(-1, 1); } else g.translate(dx, dy);
      g.drawImage(video, 0, 0, dw, dh);
      g.restore();
    } else {
      g.fillStyle = '#0e3a57'; g.fillRect(dx, dy, dw, dh);
    }
    const px = (p: { x: number }) => dx + (mirror ? 1 - p.x : p.x) * dw;
    for (const pose of snapshot?.poses || []) {
      g.strokeStyle = pose.playerId === 0 ? '#7dffff' : '#ffdc70'; g.lineWidth = 2;
      for (const [a, b] of CONNECTIONS) {
        const p = pose.landmarks[a], q = pose.landmarks[b];
        if (Math.min(p.confidence ?? 0, q.confidence ?? 0) < 0.5) continue;
        g.beginPath(); g.moveTo(px(p), dy + p.y * dh); g.lineTo(px(q), dy + q.y * dh); g.stroke();
      }
    }
  }
  g.font = 'bold 16px sans-serif'; g.fillStyle = '#fff'; g.textAlign = 'center';
  // Player lanes only over a live picture. Player 1 is on the camera's left, so on the
  // right of an unmirrored picture.
  if (size && playerCount === 2) {
    g.strokeStyle = '#fff8'; g.lineWidth = 1; g.beginPath(); g.moveTo(x + w / 2, y); g.lineTo(x + w / 2, y + h); g.stroke();
    g.fillText(mirror ? 'P1' : 'P2', x + w / 4, y + 22); g.fillText(mirror ? 'P2' : 'P1', x + w * 3 / 4, y + 22);
  } else if (size) g.fillText(`P${soloPlayerId + 1}`, x + w / 2, y + 22);
  if (!video && !frame && placeholder) g.fillText(placeholder, x + w / 2, y + h / 2);
  g.restore();
}
