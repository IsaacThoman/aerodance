import { CONNECTIONS } from '../choreography.ts';
import type { Pose } from '../choreography.ts';

export interface PreviewRect { x: number; y: number; w: number; h: number; }

// Shared setup view: mirrored display only; captured landmarks stay canonical. The player
// lanes show once the camera's picture does; without video it shows `placeholder` (the caller
// may draw its own instead).
export function drawWebcamPreview(g: CanvasRenderingContext2D, video: HTMLVideoElement | null | undefined,
  snapshot: { poses: readonly Pose[] } | null | undefined, rect: PreviewRect, playerCount = 2, placeholder = 'Start camera to preview') {
  const { x, y, w, h } = rect;
  g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip();
  g.fillStyle = '#09273b'; g.fillRect(x, y, w, h);
  const showing = !!video && video.readyState >= 2 && !!video.videoWidth;
  if (video && showing) {
    const scale = Math.min(w / video.videoWidth, h / video.videoHeight);
    const dw = video.videoWidth * scale, dh = video.videoHeight * scale;
    const dx = x + (w - dw) / 2, dy = y + (h - dh) / 2;
    g.save(); g.translate(dx + dw, dy); g.scale(-1, 1); g.drawImage(video, 0, 0, dw, dh); g.restore();
    for (const pose of snapshot?.poses || []) {
      g.strokeStyle = pose.playerId === 0 ? '#7dffff' : '#ffdc70'; g.lineWidth = 2;
      for (const [a, b] of CONNECTIONS) {
        const p = pose.landmarks[a], q = pose.landmarks[b];
        if (Math.min(p.visibility ?? 0, p.presence ?? 0, q.visibility ?? 0, q.presence ?? 0) < 0.5) continue;
        g.beginPath(); g.moveTo(dx + (1 - p.x) * dw, dy + p.y * dh); g.lineTo(dx + (1 - q.x) * dw, dy + q.y * dh); g.stroke();
      }
    }
  }
  g.font = 'bold 16px sans-serif'; g.fillStyle = '#fff'; g.textAlign = 'center';
  // Player lanes only over a live picture.
  if (showing && playerCount === 2) {
    g.strokeStyle = '#fff8'; g.lineWidth = 1; g.beginPath(); g.moveTo(x + w / 2, y); g.lineTo(x + w / 2, y + h); g.stroke();
    g.fillText('P1', x + w / 4, y + 22); g.fillText('P2', x + w * 3 / 4, y + 22);
  } else if (showing) g.fillText('P1', x + w / 2, y + 22);
  if (!video && placeholder) g.fillText(placeholder, x + w / 2, y + h / 2);
  g.restore();
}
