import { TAU } from '../../ui/draw.ts';
import type { IconDraw, Rect } from '../../ui/draw.ts';

/*
 * Table Tennis's tile art and how-to icons, drawn (they load with the menus): the table from the
 * player's end, a paddle and the ball in flight.
 */

/** A ping-pong paddle, its blade centred on (x, y), turned by `angle`. */
function drawPaddle(g: CanvasRenderingContext2D, x: number, y: number, r: number, angle: number) {
  g.save();
  g.translate(x, y);
  g.rotate(angle);
  g.fillStyle = '#e9c48c';
  g.fillRect(-r * 0.19, r * 0.8, r * 0.38, r * 1.05);
  g.beginPath();
  g.arc(0, 0, r, 0, TAU);
  const rubber = g.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.1, 0, 0, r);
  rubber.addColorStop(0, '#ff7088');
  rubber.addColorStop(1, '#e02848');
  g.fillStyle = rubber;
  g.fill();
  g.lineWidth = Math.max(1, r * 0.08);
  g.strokeStyle = '#c99a5c';
  g.stroke();
  g.restore();
}

function drawBall(g: CanvasRenderingContext2D, x: number, y: number, r: number) {
  const ball = g.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r);
  ball.addColorStop(0, '#ffffff');
  ball.addColorStop(1, '#f2e6cf');
  g.beginPath();
  g.arc(x, y, r, 0, TAU);
  g.fillStyle = ball;
  g.fill();
}

/** The tile: a blue table running away from the player, its net, the ball arcing over and a paddle. */
export function drawTableTile(g: CanvasRenderingContext2D, r: Rect, time: number) {
  const room = g.createLinearGradient(0, r.y, 0, r.y + r.h);
  room.addColorStop(0, '#dfe7f0');
  room.addColorStop(1, '#b9c6d6');
  g.fillStyle = room;
  g.fillRect(r.x, r.y, r.w, r.h);
  // The table in perspective: wide at the bottom, narrow at the far end.
  const at = (u: number, v: number) => ({ x: r.x + r.w * (0.5 + u * (0.46 - v * 0.3)), y: r.y + r.h * (1.02 - v * 0.58) });
  const corners = [at(-1, 0), at(1, 0), at(1, 1), at(-1, 1)];
  g.beginPath();
  corners.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
  g.closePath();
  const top = g.createLinearGradient(0, corners[2].y, 0, corners[0].y);
  top.addColorStop(0, '#1d5fc9');
  top.addColorStop(1, '#0f3f96');
  g.fillStyle = top;
  g.fill();
  g.lineWidth = Math.max(1.5, r.h * 0.012);
  g.strokeStyle = '#eef2f6';
  g.stroke();
  const mid = [at(0, 0), at(0, 1)];
  g.beginPath();
  g.moveTo(mid[0].x, mid[0].y);
  g.lineTo(mid[1].x, mid[1].y);
  g.lineWidth = Math.max(1, r.h * 0.006);
  g.stroke();
  // The net across the middle.
  const net = [at(-1.08, 0.5), at(1.08, 0.5)];
  g.fillStyle = 'rgba(255, 255, 255, 0.55)';
  g.fillRect(net[0].x, net[0].y - r.h * 0.05, net[1].x - net[0].x, r.h * 0.05);
  g.fillStyle = '#ffffff';
  g.fillRect(net[0].x, net[0].y - r.h * 0.055, net[1].x - net[0].x, r.h * 0.01);
  // The ball on an arc from the far end towards the paddle.
  const k = (time * 0.45) % 1;
  const ball = at(0.15 + k * 0.25, 0.95 - k * 0.8);
  drawBall(g, ball.x, ball.y - Math.sin(k * Math.PI) * r.h * 0.28, r.h * (0.025 + k * 0.03));
  drawPaddle(g, r.x + r.w * 0.76, r.y + r.h * 0.7, r.h * 0.17, -0.45);
}

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
