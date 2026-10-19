import { CONNECTIONS } from '../choreography.ts';
import type { Pose } from '../choreography.ts';

export interface PreviewRect { x: number; y: number; w: number; h: number; }
// Each player's skeleton: P1 cyan and P2 gold as ever, then green and pink.
const SKELETON = ['#7dffff', '#ffdc70', '#8dffb4', '#ff9fd2'];

// Shared setup view: mirrored display only; captured landmarks stay canonical. The player
// lanes show once the camera's picture does; without video it shows `placeholder` (the caller
// may draw its own instead). Returns where the picture landed inside `rect` (all of it without
// video), so callers can line labels up with the lanes.
export function drawWebcamPreview(g: CanvasRenderingContext2D, video: HTMLVideoElement | null | undefined,
  snapshot: { poses: readonly Pose[] } | null | undefined, rect: PreviewRect, playerCount = 2, placeholder = 'Start camera to preview'): PreviewRect {
  const { x, y, w, h } = rect;
  let picture: PreviewRect = rect;
  g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip();
  g.fillStyle = '#09273b'; g.fillRect(x, y, w, h);
  const showing = !!video && video.readyState >= 2 && !!video.videoWidth;
  if (video && showing) {
    const scale = Math.min(w / video.videoWidth, h / video.videoHeight);
    const dw = video.videoWidth * scale, dh = video.videoHeight * scale;
    const dx = x + (w - dw) / 2, dy = y + (h - dh) / 2;
    picture = { x: dx, y: dy, w: dw, h: dh };
    g.save(); g.translate(dx + dw, dy); g.scale(-1, 1); g.drawImage(video, 0, 0, dw, dh); g.restore();
    for (const pose of snapshot?.poses || []) {
      g.strokeStyle = SKELETON[pose.playerId % SKELETON.length]; g.lineWidth = 2;
      for (const [a, b] of CONNECTIONS) {
        const p = pose.landmarks[a], q = pose.landmarks[b];
        if (Math.min(p.visibility ?? 0, p.presence ?? 0, q.visibility ?? 0, q.presence ?? 0) < 0.5) continue;
        g.beginPath(); g.moveTo(dx + (1 - p.x) * dw, dy + p.y * dh); g.lineTo(dx + (1 - q.x) * dw, dy + q.y * dh); g.stroke();
      }
    }
  }
  g.font = 'bold 16px sans-serif'; g.fillStyle = '#fff'; g.textAlign = 'center';
  // Player lanes only over a live picture, splitting the picture itself, P1 on the left.
  if (showing) {
    const lane = picture.w / playerCount;
    g.strokeStyle = '#fff8'; g.lineWidth = 1; g.beginPath();
    for (let i = 1; i < playerCount; i++) { g.moveTo(picture.x + lane * i, y); g.lineTo(picture.x + lane * i, y + h); }
    g.stroke();
    g.shadowColor = '#000a'; g.shadowBlur = 4;
    for (let i = 0; i < playerCount; i++) g.fillText(`P${i + 1}`, picture.x + lane * (i + 0.5), y + 22);
  }
  if (!video && placeholder) g.fillText(placeholder, x + w / 2, y + h / 2);
  g.restore();
  return picture;
}
