import { ICONS, TAU } from '../ui/draw.ts';
import type { IconDraw } from '../ui/draw.ts';

/*
 * The screensavers' list icons: white line drawings, centred at (cx, cy) and about r across, in
 * the menu icons' weight (ui/draw.ts ICONS). The glass button sets the stroke and fill colour.
 */

function line(g: CanvasRenderingContext2D, r: number, draw: () => void) {
  g.save();
  g.lineWidth = Math.max(2.5, r * 0.09);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  draw();
  g.restore();
}

export const skylineIcon: IconDraw = (g, cx, cy, r) => line(g, r, () => {
  const s = r * 0.42, base = cy + s * 0.8;
  g.beginPath();
  g.moveTo(cx - s, base);
  g.lineTo(cx - s, cy - s * 0.1); g.lineTo(cx - s * 0.5, cy - s * 0.1); g.lineTo(cx - s * 0.5, base);
  g.moveTo(cx - s * 0.5, cy - s * 0.4);
  g.quadraticCurveTo(cx - s * 0.2, cy - s * 1.1, cx + s * 0.1, cy - s * 0.4); g.lineTo(cx + s * 0.1, base);
  g.moveTo(cx + s * 0.1, cy + s * 0.05); g.lineTo(cx + s * 0.6, cy + s * 0.05); g.lineTo(cx + s * 0.6, base);
  g.moveTo(cx - s * 1.1, base); g.lineTo(cx + s * 1.1, base);
  g.stroke();
});

export const auroraIcon: IconDraw = (g, cx, cy, r) => line(g, r, () => {
  const s = r * 0.42;
  for (let i = 0; i < 3; i++) {
    const x = cx - s * 0.7 + i * s * 0.7;
    g.beginPath();
    g.moveTo(x - s * 0.15, cy - s * 0.9);
    g.bezierCurveTo(x + s * 0.35, cy - s * 0.4, x - s * 0.35, cy + s * 0.1, x + s * 0.1, cy + s * 0.5);
    g.stroke();
  }
  g.beginPath();
  g.moveTo(cx - s * 1.1, cy + s * 0.85); g.lineTo(cx - s * 0.4, cy + s * 0.45); g.lineTo(cx + s * 0.1, cy + s * 0.85);
  g.lineTo(cx + s * 0.55, cy + s * 0.55); g.lineTo(cx + s * 1.1, cy + s * 0.85);
  g.stroke();
});

export const ribbonsIcon: IconDraw = (g, cx, cy, r) => line(g, r, () => {
  const s = r * 0.42;
  for (const dy of [-0.35, 0.05, 0.45]) {
    g.beginPath();
    g.moveTo(cx - s * 1.05, cy + s * (dy + 0.25));
    g.bezierCurveTo(cx - s * 0.4, cy + s * (dy - 0.55), cx + s * 0.4, cy + s * (dy + 0.55), cx + s * 1.05, cy + s * (dy - 0.25));
    g.stroke();
  }
});

export const cloudIcon: IconDraw = (g, cx, cy, r) => line(g, r, () => {
  const s = r * 0.42;
  g.beginPath();
  g.moveTo(cx - s * 0.95, cy + s * 0.45);
  g.arc(cx - s * 0.55, cy + s * 0.05, s * 0.42, 0.6 * Math.PI, 1.5 * Math.PI);
  g.arc(cx + s * 0.02, cy - s * 0.2, s * 0.58, 1.1 * Math.PI, 1.95 * Math.PI);
  g.arc(cx + s * 0.6, cy + s * 0.12, s * 0.36, 1.45 * Math.PI, 0.45 * Math.PI);
  g.closePath();
  g.stroke();
});

export const hillsIcon: IconDraw = (g, cx, cy, r) => line(g, r, () => {
  const s = r * 0.42;
  g.beginPath();
  g.arc(cx + s * 0.45, cy - s * 0.45, s * 0.3, 0, TAU);
  g.stroke();
  g.beginPath();
  g.moveTo(cx - s * 1.1, cy + s * 0.55);
  g.quadraticCurveTo(cx - s * 0.5, cy - s * 0.15, cx + s * 0.1, cy + s * 0.35);
  g.quadraticCurveTo(cx + s * 0.6, cy + s * 0.05, cx + s * 1.1, cy + s * 0.5);
  g.moveTo(cx - s * 1.1, cy + s * 0.85); g.lineTo(cx + s * 1.1, cy + s * 0.85);
  g.stroke();
});

export const koiIcon: IconDraw = (g, cx, cy, r) => line(g, r, () => {
  const s = r * 0.42;
  g.beginPath();
  g.moveTo(cx - s * 0.75, cy);
  g.quadraticCurveTo(cx, cy - s * 0.75, cx + s * 0.7, cy);
  g.quadraticCurveTo(cx, cy + s * 0.75, cx - s * 0.75, cy);
  g.moveTo(cx + s * 0.7, cy); g.lineTo(cx + s * 1.1, cy - s * 0.4); g.lineTo(cx + s * 1.1, cy + s * 0.4); g.closePath();
  g.stroke();
  g.beginPath(); g.arc(cx - s * 0.4, cy - s * 0.08, s * 0.07, 0, TAU); g.fill();
});

export const atriumIcon: IconDraw = (g, cx, cy, r) => line(g, r, () => {
  const s = r * 0.42;
  g.beginPath();
  g.moveTo(cx - s, cy + s * 0.8); g.lineTo(cx - s, cy);
  g.arc(cx, cy, s, Math.PI, 0); g.lineTo(cx + s, cy + s * 0.8);
  g.moveTo(cx, cy - s); g.lineTo(cx, cy + s * 0.8);
  g.moveTo(cx - s * 0.5, cy - s * 0.86); g.lineTo(cx - s * 0.5, cy + s * 0.8);
  g.moveTo(cx + s * 0.5, cy - s * 0.86); g.lineTo(cx + s * 0.5, cy + s * 0.8);
  g.moveTo(cx - s * 1.15, cy + s * 0.8); g.lineTo(cx + s * 1.15, cy + s * 0.8);
  g.stroke();
});

export const dewIcon: IconDraw = (g, cx, cy, r) => line(g, r, () => {
  const s = r * 0.42;
  g.beginPath();
  g.moveTo(cx, cy - s);
  g.bezierCurveTo(cx + s * 0.25, cy - s * 0.5, cx + s * 0.75, cy + s * 0.05, cx + s * 0.75, cy + s * 0.35);
  g.arc(cx, cy + s * 0.35, s * 0.75, 0, Math.PI);
  g.bezierCurveTo(cx - s * 0.75, cy + s * 0.05, cx - s * 0.25, cy - s * 0.5, cx, cy - s);
  g.stroke();
  g.beginPath(); g.arc(cx - s * 0.3, cy + s * 0.3, s * 0.2, Math.PI, 1.5 * Math.PI); g.stroke();
});

export const orbitIcon: IconDraw = (g, cx, cy, r) => line(g, r, () => {
  const s = r * 0.42;
  g.beginPath(); g.arc(cx, cy, s * 0.6, 0, TAU); g.stroke();
  g.beginPath(); g.ellipse(cx, cy, s * 1.1, s * 0.35, -0.35, 0, TAU); g.stroke();
});

export const jellyfishIcon: IconDraw = (g, cx, cy, r) => line(g, r, () => {
  const s = r * 0.42;
  g.beginPath();
  g.moveTo(cx - s * 0.8, cy);
  g.quadraticCurveTo(cx - s * 0.8, cy - s * 0.9, cx, cy - s * 0.9);
  g.quadraticCurveTo(cx + s * 0.8, cy - s * 0.9, cx + s * 0.8, cy);
  g.closePath();
  g.stroke();
  for (let i = -1; i <= 1; i++) {
    g.beginPath();
    g.moveTo(cx + i * s * 0.4, cy + s * 0.1);
    g.quadraticCurveTo(cx + i * s * 0.4 + s * 0.2, cy + s * 0.5, cx + i * s * 0.4, cy + s * 0.95);
    g.stroke();
  }
});

export const bubblesIcon: IconDraw = ICONS.bubbles;
export const dancerIcon: IconDraw = ICONS.dancer;

export const paddleIcon: IconDraw = (g, cx, cy, r) => line(g, r, () => {
  const s = r * 0.42;
  g.beginPath(); g.arc(cx - s * 0.15, cy - s * 0.2, s * 0.62, 0, TAU); g.stroke();
  g.beginPath(); g.moveTo(cx + s * 0.28, cy + s * 0.25); g.lineTo(cx + s * 0.85, cy + s * 0.85); g.stroke();
  g.beginPath(); g.arc(cx + s * 0.75, cy - s * 0.75, s * 0.16, 0, TAU); g.fill();
});

// A floating island: a round tree on its flat top, its rock tapering to a point beneath, a waterfall off its edge.
export const weatherIcon: IconDraw = (g, cx, cy, r) => line(g, r, () => {
  const s = r * 0.42, top = cy + s * 0.05;
  g.beginPath();
  g.moveTo(cx - s * 1.15, top);
  g.lineTo(cx + s * 1.15, top);
  g.quadraticCurveTo(cx + s * 0.75, top + s * 0.25, cx + s * 0.4, top + s * 0.55);
  g.lineTo(cx - s * 0.05, top + s * 0.95);
  g.lineTo(cx - s * 0.5, top + s * 0.5);
  g.quadraticCurveTo(cx - s * 0.8, top + s * 0.25, cx - s * 1.15, top);
  g.stroke();
  g.beginPath(); g.arc(cx - s * 0.3, top - s * 0.72, s * 0.4, 0, TAU); g.stroke();
  g.beginPath(); g.moveTo(cx - s * 0.3, top - s * 0.32); g.lineTo(cx - s * 0.3, top); g.stroke();
  g.beginPath(); g.moveTo(cx + s * 0.85, top + s * 0.15); g.lineTo(cx + s * 0.85, top + s * 0.85); g.stroke();
});
