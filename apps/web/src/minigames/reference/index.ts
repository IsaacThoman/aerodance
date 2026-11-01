import { TAU, drawDancer } from '../../ui/draw.ts';
import type { Rect } from '../../ui/draw.ts';
import type { MinigameDefinition } from '../types.ts';

/*
 * The reference minigame: a deliberately small game that uses every part of the minigames
 * contract (docs/minigames.md), to copy from and to test the platform with. Development builds
 * only (devOnly; ?devgames lists it in a production build), and it can go: delete this folder.
 */

/** A glossy soap bubble (the tile art's and the game's), centred on (x, y). */
export function drawBubble(g: CanvasRenderingContext2D, x: number, y: number, r: number, tint = '#9ff3ff', alpha = 1) {
  g.save();
  g.globalAlpha *= alpha;
  const body = g.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.1, x, y, r);
  body.addColorStop(0, 'rgba(255, 255, 255, 0.55)');
  body.addColorStop(0.55, 'rgba(255, 255, 255, 0.08)');
  body.addColorStop(0.92, `${tint}66`);
  body.addColorStop(1, `${tint}cc`);
  g.beginPath();
  g.arc(x, y, r, 0, TAU);
  g.fillStyle = body;
  g.fill();
  g.lineWidth = Math.max(1.5, r * 0.05);
  g.strokeStyle = 'rgba(255, 255, 255, 0.8)';
  g.stroke();
  g.beginPath();
  g.ellipse(x - r * 0.35, y - r * 0.42, r * 0.28, r * 0.15, -0.6, 0, TAU);
  g.fillStyle = 'rgba(255, 255, 255, 0.85)';
  g.fill();
  g.restore();
}

// Bubbles rising past a dancer reaching up, over an aqua sky.
function art(g: CanvasRenderingContext2D, r: Rect, time: number) {
  const sky = g.createLinearGradient(0, r.y, 0, r.y + r.h);
  sky.addColorStop(0, '#2fb4f0');
  sky.addColorStop(1, '#bff6ff');
  g.fillStyle = sky;
  g.fillRect(r.x, r.y, r.w, r.h);
  const meadow = g.createLinearGradient(0, r.y + r.h * 0.78, 0, r.y + r.h);
  meadow.addColorStop(0, '#7be07a');
  meadow.addColorStop(1, '#2fa95a');
  g.fillStyle = meadow;
  g.fillRect(r.x, r.y + r.h * 0.8, r.w, r.h * 0.2);
  for (let i = 0; i < 7; i++) {
    const k = (i * 0.37 + time * (0.05 + i * 0.008)) % 1;
    const x = r.x + r.w * (0.12 + ((i * 0.61) % 1) * 0.76) + Math.sin(time * 1.3 + i) * r.w * 0.02;
    drawBubble(g, x, r.y + r.h * (1.05 - k * 1.2), r.h * (0.07 + (i % 3) * 0.03));
  }
  const fill = g.createLinearGradient(0, r.y + r.h * 0.3, 0, r.y + r.h * 0.95);
  fill.addColorStop(0, '#7fd0ff');
  fill.addColorStop(1, '#078fff');
  g.save();
  g.shadowColor = 'rgba(0, 40, 80, 0.4)';
  g.shadowBlur = 8;
  drawDancer(g, r.x + r.w * 0.5, r.y + r.h * 0.93, r.h * 0.62, fill);
  g.restore();
}

const reference: MinigameDefinition = {
  id: 'reference',
  title: 'Bubble Pop',
  blurb: 'Pop the bubbles with your hands',
  description: 'Bubbles float up past your glass self: touch them to pop them, or clap to pop every one around you. Most pops in 30 seconds wins. (The minigames platform\'s reference game.)',
  players: [1, 2, 3, 4],
  howTo: [
    { icon: 'bubbles', text: 'Touch the bubbles with your hands to pop them' },
    { icon: 'dancer', text: 'Clap to pop every bubble around you' },
    { icon: 'replay', text: 'Most pops in 30 seconds wins' },
  ],
  art,
  tint: ['rgba(60, 190, 240, 0.6)', 'rgba(10, 90, 170, 0.72)'],
  score: { unit: 'pops' },
  durationMs: 30000,
  scene: 'menu',
  devOnly: true,
  order: 1000,
  load: () => import('./Game.tsx'),
};
export default reference;
