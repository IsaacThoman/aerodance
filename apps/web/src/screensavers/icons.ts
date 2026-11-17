import type { IconDraw } from '../ui/draw.ts';

export const clockIcon: IconDraw = (g, x, y, size) => {
  const r = size * 0.46;
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.moveTo(x, y - r * 0.63);
  g.lineTo(x, y);
  g.lineTo(x + r * 0.45, y + r * 0.2);
  g.stroke();
};

export const butterflyIcon: IconDraw = (g, x, y, r) => {
  g.save();
  g.translate(x, y);
  for (const side of [1, -1]) {
    g.save();
    g.scale(side, 1);
    g.beginPath();
    g.moveTo(0, 0);
    g.bezierCurveTo(r * 0.5, -r * 0.85, r * 0.88, -r * 0.35, r * 0.36, 0);
    g.bezierCurveTo(r * 0.65, r * 0.37, r * 0.15, r * 0.62, 0, 0);
    g.stroke();
    g.restore();
  }
  g.restore();
};

export const skylineIcon: IconDraw = (g, x, y, r) => {
  g.beginPath();
  g.rect(x - r * 0.56, y - r * 0.12, r * 0.32, r * 0.54);
  g.rect(x - r * 0.24, y - r * 0.53, r * 0.45, r * 0.95);
  g.rect(x + r * 0.21, y - r * 0.24, r * 0.35, r * 0.66);
  g.stroke();
};

export const fishIcon: IconDraw = (g, x, y, r) => {
  g.beginPath();
  g.ellipse(x + r * 0.12, y, r * 0.46, r * 0.29, -0.09, 0, Math.PI * 2);
  g.moveTo(x - r * 0.35, y);
  g.lineTo(x - r * 0.62, y - r * 0.26);
  g.lineTo(x - r * 0.62, y + r * 0.26);
  g.closePath();
  g.stroke();
};
