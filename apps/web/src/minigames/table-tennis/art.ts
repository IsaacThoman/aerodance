import { TAU } from '../../ui/draw.ts';
import type { IconDraw } from '../../ui/draw.ts';

/** A static white paddle and ball, drawn like the main menu's monochrome icons. */
export const paddleIcon: IconDraw = (g, cx, cy, r) => {
  g.save();
  g.fillStyle = '#ffffff';
  g.translate(cx, cy);
  g.rotate(-0.55);
  g.beginPath();
  g.ellipse(0, -r * 0.18, r * 0.55, r * 0.65, 0, 0, TAU);
  g.fill();
  g.fillRect(-r * 0.13, r * 0.35, r * 0.26, r * 0.55);
  g.restore();
  g.save();
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.arc(cx + r * 0.65, cy - r * 0.6, r * 0.18, 0, TAU);
  g.fill();
  g.restore();
};

/** How-to icons, in white like the platform's. */
export const swingIcon: IconDraw = (g, cx, cy, r) => {
  g.save();
  g.strokeStyle = '#ffffff';
  g.fillStyle = '#ffffff';
  g.lineWidth = r * 0.12;
  g.lineCap = 'round';
  g.beginPath();
  g.arc(cx - r * 0.1, cy + r * 0.1, r * 0.75, -2.4, -0.9);
  g.stroke();
  g.beginPath();
  g.arc(cx + r * 0.35, cy - r * 0.35, r * 0.32, 0, TAU);
  g.fill();
  g.fillRect(cx + r * 0.05, cy - r * 0.15, r * 0.14, r * 0.55);
  g.restore();
};
export const raiseIcon: IconDraw = (g, cx, cy, r) => {
  g.save();
  g.strokeStyle = '#ffffff';
  g.lineWidth = r * 0.14;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(cx - r * 0.35, cy + r * 0.7);
  g.lineTo(cx - r * 0.35, cy - r * 0.55);
  g.moveTo(cx - r * 0.7, cy - r * 0.2);
  g.lineTo(cx - r * 0.35, cy - r * 0.6);
  g.lineTo(cx, cy - r * 0.2);
  g.stroke();
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.arc(cx + r * 0.45, cy + r * 0.2, r * 0.18, 0, TAU);
  g.fill();
  g.restore();
};
