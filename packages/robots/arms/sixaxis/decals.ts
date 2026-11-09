import * as THREE from 'three';
import type { Placement } from '../../shared/geometry.ts';
import { place } from '../../shared/geometry.ts';
import { ATLAS, SWATCH, SWATCHES, SWATCH_NAMES, swatchBlock } from './palette.ts';

// Every printed thing on the six-axis arm, its track and its controller, drawn once into one
// canvas atlas so they share a single material (one draw call per link that carries labels): the
// maker's wordmark, axis tags with rotation arrows, hazard triangles, the rating plate, model
// badges, cabinet labels. The maker, Torven, and every model number are made up.

const W = ATLAS;
const H = ATLAS;

interface Region { x: number; y: number; w: number; h: number }

const FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';

/** The atlas's regions, in canvas pixels. */
export const REGIONS = {
  logoBlack: { x: 0, y: 0, w: 1024, h: 200 },
  logoOrange: { x: 1024, y: 0, w: 1024, h: 200 },
  ...Object.fromEntries(['J1', 'J2', 'J3', 'J4', 'J5', 'J6', 'E1'].map((name, i) => [`axis${name}`, { x: i * 280, y: 220, w: 270, h: 128 }])) as Record<`axis${'J1' | 'J2' | 'J3' | 'J4' | 'J5' | 'J6' | 'E1'}`, Region>,
  crush: { x: 0, y: 370, w: 200, h: 180 },
  shock: { x: 210, y: 370, w: 200, h: 180 },
  hand: { x: 420, y: 370, w: 200, h: 180 },
  lift: { x: 630, y: 370, w: 140, h: 180 },
  rating: { x: 800, y: 370, w: 600, h: 300 },
  model: { x: 1420, y: 370, w: 620, h: 130 },
  modelWhite: { x: 1420, y: 510, w: 620, h: 130 },
  track: { x: 0, y: 700, w: 760, h: 150 },
  gripper: { x: 780, y: 700, w: 300, h: 80 },
  danger: { x: 1100, y: 700, w: 420, h: 200 },
  mainSwitch: { x: 1540, y: 700, w: 240, h: 240 },
  cabinetPanel: { x: 0, y: 960, w: 720, h: 360 },
  pendantKeys: { x: 740, y: 960, w: 300, h: 420 },
  stopRing: { x: 1060, y: 960, w: 240, h: 240 },
  serialTag: { x: 1320, y: 960, w: 360, h: 90 },
  ventGrille: { x: 1320, y: 1060, w: 360, h: 300 },
  cableTag: { x: 1700, y: 960, w: 300, h: 90 },
  maxLoad: { x: 1700, y: 1060, w: 300, h: 140 },
  pendantScreen: { x: 420, y: 1400, w: 480, h: 320 },
} as const;

export type DecalName = keyof typeof REGIONS;

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function wordmark(g: CanvasRenderingContext2D, r: Region, color: string) {
  g.save();
  g.fillStyle = color;
  // A slanted bar mark, then the name, wide-spaced.
  const h = r.h;
  const x0 = r.x + h * 0.15;
  g.beginPath();
  g.moveTo(x0 + h * 0.22, r.y + h * 0.18);
  g.lineTo(x0 + h * 0.62, r.y + h * 0.18);
  g.lineTo(x0 + h * 0.42, r.y + h * 0.82);
  g.lineTo(x0 + h * 0.02, r.y + h * 0.82);
  g.closePath();
  g.fill();
  g.beginPath();
  g.moveTo(x0 + h * 0.72, r.y + h * 0.18);
  g.lineTo(x0 + h * 0.92, r.y + h * 0.18);
  g.lineTo(x0 + h * 0.72, r.y + h * 0.82);
  g.lineTo(x0 + h * 0.52, r.y + h * 0.82);
  g.closePath();
  g.fill();
  g.font = `italic 900 ${Math.round(h * 0.7)}px ${FONT}`;
  g.textBaseline = 'middle';
  (g as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${Math.round(h * 0.08)}px`;
  g.fillText('TORVEN', x0 + h * 1.05, r.y + h * 0.53, r.w - h * 1.3);
  g.restore();
}

function axisTag(g: CanvasRenderingContext2D, r: Region, name: string) {
  g.save();
  g.fillStyle = '#f2f1ec';
  roundRect(g, r.x + 4, r.y + 4, r.w - 8, r.h - 8, 18);
  g.fill();
  g.strokeStyle = '#141414';
  g.lineWidth = 5;
  roundRect(g, r.x + 10, r.y + 10, r.w - 20, r.h - 20, 13);
  g.stroke();
  g.fillStyle = '#141414';
  g.font = `800 ${Math.round(r.h * 0.5)}px ${FONT}`;
  g.textBaseline = 'middle';
  g.textAlign = 'center';
  g.fillText(name, r.x + r.w * 0.26, r.y + r.h * 0.53);
  // A curved double arrow with + and - at its ends.
  const cx = r.x + r.w * 0.68;
  const cy = r.y + r.h * 0.62;
  const rad = r.h * 0.3;
  g.lineWidth = 7;
  g.beginPath();
  g.arc(cx, cy, rad, Math.PI * 1.08, Math.PI * 1.92);
  g.stroke();
  const head = (a: number, dir: number) => {
    const px = cx + Math.cos(a) * rad;
    const py = cy + Math.sin(a) * rad;
    const tx = -Math.sin(a) * dir;
    const ty = Math.cos(a) * dir;
    g.beginPath();
    g.moveTo(px + tx * 22, py + ty * 22);
    g.lineTo(px - ty * 14 - tx * 4, py + tx * 14 - ty * 4);
    g.lineTo(px + ty * 14 - tx * 4, py - tx * 14 - ty * 4);
    g.closePath();
    g.fill();
  };
  head(Math.PI * 1.08, -1);
  head(Math.PI * 1.92, 1);
  g.font = `800 ${Math.round(r.h * 0.26)}px ${FONT}`;
  g.fillText('−', cx - rad * 1.25, cy + rad * 0.15);
  g.fillText('+', cx + rad * 1.25, cy + rad * 0.15);
  g.restore();
}

function triangle(g: CanvasRenderingContext2D, r: Region, symbol: (cx: number, cy: number, s: number) => void) {
  g.save();
  const cx = r.x + r.w / 2;
  const top = r.y + 8;
  const s = Math.min(r.w, r.h * 1.12) - 16;
  const h = s * 0.866;
  const tri = (inset: number) => {
    g.beginPath();
    g.moveTo(cx, top + inset * 2);
    g.lineTo(cx + s / 2 - inset * 1.7, top + h - inset);
    g.lineTo(cx - s / 2 + inset * 1.7, top + h - inset);
    g.closePath();
  };
  g.lineJoin = 'round';
  g.fillStyle = '#121212';
  g.strokeStyle = '#121212';
  g.lineWidth = 14;
  tri(0);
  g.fill();
  g.stroke();
  g.fillStyle = '#f5c400';
  tri(13);
  g.fill();
  g.fillStyle = '#121212';
  g.strokeStyle = '#121212';
  symbol(cx, top + h * 0.62, s);
  g.restore();
}

function plate(g: CanvasRenderingContext2D, r: Region, lines: readonly [string, string][], title: string) {
  g.save();
  const grad = g.createLinearGradient(r.x, r.y, r.x + r.w, r.y + r.h);
  grad.addColorStop(0, '#d9dcdf');
  grad.addColorStop(0.5, '#c4c8cc');
  grad.addColorStop(1, '#d4d7da');
  g.fillStyle = grad;
  roundRect(g, r.x + 2, r.y + 2, r.w - 4, r.h - 4, 10);
  g.fill();
  g.strokeStyle = '#2a2c2f';
  g.lineWidth = 3;
  roundRect(g, r.x + 12, r.y + 12, r.w - 24, r.h - 24, 6);
  g.stroke();
  // Rivets.
  g.fillStyle = '#8d9196';
  for (const [x, y] of [[22, 22], [r.w - 22, 22], [22, r.h - 22], [r.w - 22, r.h - 22]]) {
    g.beginPath();
    g.arc(r.x + x, r.y + y, 6, 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = '#16181a';
  g.fillRect(r.x + 12, r.y + 12, r.w - 24, r.h * 0.2);
  g.fillStyle = '#d9dcdf';
  g.font = `italic 900 ${Math.round(r.h * 0.13)}px ${FONT}`;
  g.textBaseline = 'middle';
  g.fillText(title, r.x + 30, r.y + 12 + r.h * 0.1);
  g.fillStyle = '#16181a';
  const rows = lines.length;
  const top = r.y + r.h * 0.27;
  const lh = (r.h * 0.66) / rows;
  g.font = `600 ${Math.round(lh * 0.62)}px ${FONT}`;
  lines.forEach(([k, v], i) => {
    g.fillText(k, r.x + 30, top + lh * (i + 0.5));
    g.fillText(v, r.x + r.w * 0.44, top + lh * (i + 0.5));
  });
  g.restore();
}

function text(g: CanvasRenderingContext2D, r: Region, value: string, { color = '#141414', background = '', size = 0.6, weight = 800, italic = false, align = 'center' as CanvasTextAlign, border = '' } = {}) {
  g.save();
  if (background) {
    g.fillStyle = background;
    roundRect(g, r.x + 2, r.y + 2, r.w - 4, r.h - 4, Math.min(12, r.h * 0.12));
    g.fill();
  }
  if (border) {
    g.strokeStyle = border;
    g.lineWidth = 4;
    roundRect(g, r.x + 8, r.y + 8, r.w - 16, r.h - 16, Math.min(8, r.h * 0.08));
    g.stroke();
  }
  g.fillStyle = color;
  g.font = `${italic ? 'italic ' : ''}${weight} ${Math.round(r.h * size)}px ${FONT}`;
  g.textBaseline = 'middle';
  g.textAlign = align;
  const x = align === 'left' ? r.x + r.h * 0.2 : align === 'right' ? r.x + r.w - r.h * 0.2 : r.x + r.w / 2;
  g.fillText(value, x, r.y + r.h * 0.54, r.w * 0.92);
  g.restore();
}

function draw(g: CanvasRenderingContext2D) {
  const R = REGIONS;
  g.clearRect(0, 0, W, H);
  wordmark(g, R.logoBlack, '#121314');
  wordmark(g, R.logoOrange, '#e0601f');
  for (const name of ['J1', 'J2', 'J3', 'J4', 'J5', 'J6', 'E1'] as const) axisTag(g, R[`axis${name}`], name);
  // Crushing hazard: a hand under a falling block.
  triangle(g, R.crush, (cx, cy, s) => {
    g.fillRect(cx - s * 0.16, cy - s * 0.28, s * 0.32, s * 0.12);
    g.beginPath();
    g.moveTo(cx - s * 0.04, cy - s * 0.12);
    g.lineTo(cx + s * 0.04, cy - s * 0.12);
    g.lineTo(cx, cy - s * 0.06);
    g.fill();
    g.beginPath();
    g.ellipse(cx, cy + s * 0.06, s * 0.16, s * 0.07, 0, 0, Math.PI * 2);
    g.fill();
    g.fillRect(cx - s * 0.3, cy + s * 0.14, s * 0.6, s * 0.03);
  });
  // Electrical hazard: the lightning arrow.
  triangle(g, R.shock, (cx, cy, s) => {
    g.beginPath();
    g.moveTo(cx + s * 0.02, cy - s * 0.3);
    g.lineTo(cx - s * 0.1, cy + s * 0.02);
    g.lineTo(cx + s * 0.03, cy + s * 0.0);
    g.lineTo(cx - s * 0.05, cy + s * 0.2);
    g.lineTo(cx + s * 0.1, cy - s * 0.06);
    g.lineTo(cx - s * 0.02, cy - s * 0.04);
    g.lineTo(cx + s * 0.08, cy - s * 0.3);
    g.closePath();
    g.fill();
  });
  // General warning: the exclamation mark.
  triangle(g, R.hand, (cx, cy, s) => {
    g.beginPath();
    g.moveTo(cx - s * 0.05, cy - s * 0.27);
    g.lineTo(cx + s * 0.05, cy - s * 0.27);
    g.lineTo(cx + s * 0.025, cy + s * 0.07);
    g.lineTo(cx - s * 0.025, cy + s * 0.07);
    g.closePath();
    g.fill();
    g.beginPath();
    g.arc(cx, cy + s * 0.15, s * 0.045, 0, Math.PI * 2);
    g.fill();
  });
  // Lifting point: a hook on a chain, black on yellow.
  {
    const r = R.lift;
    g.save();
    g.fillStyle = '#f5c400';
    roundRect(g, r.x + 4, r.y + 4, r.w - 8, r.h - 8, 12);
    g.fill();
    g.strokeStyle = '#121212';
    g.lineWidth = 10;
    g.beginPath();
    g.moveTo(r.x + r.w / 2, r.y + 26);
    g.lineTo(r.x + r.w / 2, r.y + r.h * 0.5);
    g.arc(r.x + r.w / 2 - 22, r.y + r.h * 0.6, 22, 0, Math.PI * 0.95);
    g.stroke();
    g.restore();
  }
  plate(g, R.rating, [
    ['TYPE', 'TR-30/1.9  ARTICULATED ROBOT'],
    ['SERIAL', 'T30-1907-0417'],
    ['PAYLOAD', '30 kg      REACH 1910 mm'],
    ['MASS', '418 kg     IP67 WRIST'],
    ['SUPPLY', '400 V 3~ 50/60 Hz  4.2 kVA'],
    ['BUILT', '2026-03   MADE IN THE EU'],
  ], 'TORVEN ROBOTICS');
  text(g, R.model, 'TR-30 / 1.9', { color: '#141414', italic: true, weight: 900, size: 0.62 });
  text(g, R.modelWhite, 'TR-30 / 1.9', { color: '#e8e9eb', italic: true, weight: 900, size: 0.62 });
  plate(g, R.track, [['TYPE', 'LT-3000 LINEAR TRACK  (E1)'], ['STROKE', '1300 mm   2.0 m/s']], 'TORVEN');
  text(g, R.gripper, 'PGX-80  6 bar', { color: '#1a1b1d', background: '#cfd3d6', size: 0.48, weight: 700 });
  // Danger, high voltage: the classic two-part label.
  {
    const r = R.danger;
    g.save();
    g.fillStyle = '#f4f4f0';
    roundRect(g, r.x + 2, r.y + 2, r.w - 4, r.h - 4, 10);
    g.fill();
    g.fillStyle = '#c8191e';
    g.fillRect(r.x + 10, r.y + 10, r.w - 20, r.h * 0.38);
    g.fillStyle = '#f4f4f0';
    g.font = `900 ${Math.round(r.h * 0.26)}px ${FONT}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('DANGER', r.x + r.w / 2, r.y + 10 + r.h * 0.19);
    g.fillStyle = '#141414';
    g.font = `800 ${Math.round(r.h * 0.17)}px ${FONT}`;
    g.fillText('400 V INSIDE', r.x + r.w / 2, r.y + r.h * 0.6);
    g.font = `600 ${Math.round(r.h * 0.11)}px ${FONT}`;
    g.fillText('ISOLATE BEFORE OPENING', r.x + r.w / 2, r.y + r.h * 0.82);
    g.restore();
  }
  // The main switch's yellow plate.
  {
    const r = R.mainSwitch;
    g.save();
    g.fillStyle = '#f5c400';
    roundRect(g, r.x + 2, r.y + 2, r.w - 4, r.h - 4, 14);
    g.fill();
    g.fillStyle = '#141414';
    g.font = `900 ${Math.round(r.h * 0.17)}px ${FONT}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('0', r.x + r.w * 0.2, r.y + r.h * 0.5);
    g.fillText('I', r.x + r.w * 0.5, r.y + r.h * 0.18);
    g.font = `800 ${Math.round(r.h * 0.09)}px ${FONT}`;
    g.fillText('MAIN SWITCH', r.x + r.w / 2, r.y + r.h * 0.88);
    g.restore();
  }
  // The emergency stop's yellow ring (the red mushroom is geometry).
  for (const r of [R.stopRing]) {
    g.save();
    g.fillStyle = '#f5c400';
    g.beginPath();
    g.arc(r.x + r.w / 2, r.y + r.h / 2, r.w / 2 - 4, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#141414';
    g.font = `800 ${Math.round(r.h * 0.085)}px ${FONT}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const txt = 'EMERGENCY  STOP  ';
    for (let i = 0; i < txt.length; i++) {
      const a = -Math.PI * 0.95 + (i / txt.length) * Math.PI * 1.9 - Math.PI / 2;
      g.save();
      g.translate(r.x + r.w / 2 + Math.cos(a) * r.w * 0.4, r.y + r.h / 2 + Math.sin(a) * r.w * 0.4);
      g.rotate(a + Math.PI / 2);
      g.fillText(txt[i], 0, 0);
      g.restore();
    }
    g.restore();
  }
  // The cabinet's operator panel: mode key switch, buttons, a little status display.
  {
    const r = R.cabinetPanel;
    g.save();
    g.fillStyle = '#2c2f33';
    roundRect(g, r.x + 2, r.y + 2, r.w - 4, r.h - 4, 12);
    g.fill();
    g.fillStyle = '#d8dadc';
    g.font = `700 ${Math.round(r.h * 0.07)}px ${FONT}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const labels = ['AUTO', 'T1', 'T2', 'MOTORS ON', 'RESET', 'CYCLE'];
    labels.forEach((label, i) => g.fillText(label, r.x + r.w * (0.14 + 0.144 * i), r.y + r.h * 0.84));
    g.fillStyle = '#0e1a14';
    g.fillRect(r.x + r.w * 0.06, r.y + r.h * 0.1, r.w * 0.5, r.h * 0.42);
    g.fillStyle = '#7dff9e';
    g.font = `600 ${Math.round(r.h * 0.075)}px "Courier New", monospace`;
    g.textAlign = 'left';
    ['RUN  PRG TT_RALLY', 'SPD 100%  E1 OK', 'TEMP 34C  OK'].forEach((line, i) => g.fillText(line, r.x + r.w * 0.09, r.y + r.h * (0.19 + i * 0.12)));
    g.restore();
  }
  // The teach pendant's keypad and jog keys.
  {
    const r = R.pendantKeys;
    g.save();
    g.fillStyle = '#25272b';
    g.fillRect(r.x, r.y, r.w, r.h);
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 4; col++) {
        g.fillStyle = col === 3 ? '#3b6fb6' : row < 2 ? '#4a4d52' : '#55595f';
        roundRect(g, r.x + 18 + col * 70, r.y + 20 + row * 56, 56, 40, 8);
        g.fill();
        g.fillStyle = '#e9eaec';
        g.font = `700 18px ${FONT}`;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(col === 3 ? (row % 2 ? '−' : '+') : String((row * 3 + col) % 10), r.x + 46 + col * 70, r.y + 40 + row * 56);
      }
    }
    g.restore();
  }
  text(g, R.serialTag, 'S/N T30-1907-0417', { color: '#141414', background: '#e9e9e4', size: 0.42, weight: 700 });
  // A louvred vent.
  {
    const r = R.ventGrille;
    g.save();
    g.fillStyle = '#26282c';
    g.fillRect(r.x, r.y, r.w, r.h);
    for (let i = 0; i < 12; i++) {
      const y = r.y + 14 + i * 23;
      const grad = g.createLinearGradient(0, y, 0, y + 16);
      grad.addColorStop(0, '#0b0c0d');
      grad.addColorStop(1, '#45484d');
      g.fillStyle = grad;
      g.fillRect(r.x + 14, y, r.w - 28, 15);
    }
    g.restore();
  }
  text(g, R.cableTag, 'X21  E1-MOT', { color: '#141414', background: '#f2f2ee', size: 0.46, weight: 700 });
  {
    const r = R.maxLoad;
    g.save();
    g.fillStyle = '#f4f4f0';
    roundRect(g, r.x + 2, r.y + 2, r.w - 4, r.h - 4, 10);
    g.fill();
    g.fillStyle = '#1f5fae';
    g.fillRect(r.x + 10, r.y + 10, r.h - 20, r.h - 20);
    g.fillStyle = '#f4f4f0';
    g.font = `900 ${Math.round(r.h * 0.4)}px ${FONT}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('i', r.x + r.h / 2, r.y + r.h / 2);
    g.fillStyle = '#141414';
    g.font = `800 ${Math.round(r.h * 0.2)}px ${FONT}`;
    g.fillText('MAX 30 kg', r.x + r.h + (r.w - r.h) / 2, r.y + r.h * 0.38);
    g.font = `600 ${Math.round(r.h * 0.14)}px ${FONT}`;
    g.fillText('AT FLANGE', r.x + r.h + (r.w - r.h) / 2, r.y + r.h * 0.66);
    g.restore();
  }
  pendantScreen(g, R.pendantScreen);
}

// The teach pendant's screen: the program running, the joints' positions, a status bar.
function pendantScreen(g: CanvasRenderingContext2D, r: Region) {
  g.save();
  g.fillStyle = '#0d1a26';
  g.fillRect(r.x, r.y, r.w, r.h);
  g.fillStyle = '#1f4f7a';
  g.fillRect(r.x, r.y, r.w, r.h * 0.12);
  g.fillStyle = '#e8f2fb';
  g.font = `700 ${Math.round(r.h * 0.075)}px ${FONT}`;
  g.textBaseline = 'middle';
  g.fillText('AUTO  100%   TT_RALLY.prg', r.x + 12, r.y + r.h * 0.06);
  g.fillStyle = '#56d37a';
  g.beginPath();
  g.arc(r.x + r.w - 20, r.y + r.h * 0.06, 9, 0, Math.PI * 2);
  g.fill();
  const rows = ['J1', 'J2', 'J3', 'J4', 'J5', 'J6', 'E1'];
  rows.forEach((name, i) => {
    const y = r.y + r.h * (0.18 + i * 0.105);
    g.fillStyle = '#9fc4e6';
    g.font = `700 ${Math.round(r.h * 0.065)}px ${FONT}`;
    g.fillText(name, r.x + 14, y + r.h * 0.035);
    g.fillStyle = '#1b3550';
    g.fillRect(r.x + 60, y + 6, r.w * 0.5, r.h * 0.05);
    g.fillStyle = i === 6 ? '#e0a33a' : '#4aa3e8';
    g.fillRect(r.x + 60, y + 6, r.w * 0.5 * (0.25 + 0.6 * ((i * 37) % 10) / 10), r.h * 0.05);
  });
  g.strokeStyle = '#4aa3e8';
  g.lineWidth = 3;
  g.beginPath();
  for (let i = 0; i <= 40; i++) {
    const x = r.x + r.w * 0.68 + (i / 40) * r.w * 0.28;
    const y = r.y + r.h * 0.55 - Math.sin(i * 0.45) * r.h * 0.18 * Math.exp(-i / 50);
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.stroke();
  g.fillStyle = '#e8f2fb';
  g.font = `600 ${Math.round(r.h * 0.055)}px ${FONT}`;
  g.fillText('CYCLE 0.94 s', r.x + r.w * 0.68, r.y + r.h * 0.86);
  g.restore();
}

/** The finishes' swatches, along the atlas's bottom strip. */
function drawSwatches(g: CanvasRenderingContext2D, scale: number, value: (name: (typeof SWATCH_NAMES)[number]) => string) {
  for (const name of SWATCH_NAMES) {
    const { x, y } = swatchBlock(name);
    g.fillStyle = value(name);
    g.fillRect(x * scale, y * scale, SWATCH * scale, SWATCH * scale);
  }
}

const channel = (v: number) => Math.round(THREE.MathUtils.clamp(v, 0, 1) * 255);

export interface AtlasTextures {
  /** Colour, alpha 0 where nothing's printed. */
  color: THREE.CanvasTexture;
  /** Clear coat (R), roughness (G) and metalness (B), on the same layout at an eighth the size. */
  orm: THREE.CanvasTexture;
  /** What glows, at a quarter the size. */
  emissive: THREE.CanvasTexture;
}

let atlas: AtlasTextures | null = null;

function canvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  if (!g) throw Error('No 2D canvas');
  return [c, g];
}

/** The atlas's textures, all read through the second UV set (channel 1). */
export function atlasTextures(): AtlasTextures {
  if (atlas) return atlas;
  const [c, g] = canvas(W);
  draw(g);
  drawSwatches(g, 1, (name) => SWATCHES[name].color);
  // Clear coat, roughness and metalness: the swatches', and a printed label's everywhere else.
  const [oc, og] = canvas(W / 8);
  og.fillStyle = `rgb(${channel(0.55)},${channel(0.42)},0)`;
  og.fillRect(0, 0, W / 8, H / 8);
  drawSwatches(og, 1 / 8, (name) => {
    const sw = SWATCHES[name];
    return `rgb(${channel(sw.clearcoat ?? 0)},${channel(sw.roughness)},${channel(sw.metalness ?? 0)})`;
  });
  // What glows: the lit swatches, and the pendant's screen and the cabinet's display.
  const [ec, eg] = canvas(W / 4);
  eg.fillStyle = '#000';
  eg.fillRect(0, 0, W / 4, H / 4);
  drawSwatches(eg, 1 / 4, (name) => {
    const sw = SWATCHES[name];
    if (!sw.emissive) return '#000';
    return `#${new THREE.Color(sw.emissive).multiplyScalar(sw.glow ?? 1).getHexString()}`;
  });
  const panel = REGIONS.cabinetPanel;
  const display = { x: panel.x + panel.w * 0.06, y: panel.y + panel.h * 0.1, w: panel.w * 0.5, h: panel.h * 0.42 };
  for (const [r, glow] of [[REGIONS.pendantScreen, 0.3], [display, 0.4]] as const) {
    eg.globalAlpha = glow;
    eg.drawImage(c, r.x, r.y, r.w, r.h, r.x / 4, r.y / 4, r.w / 4, r.h / 4);
  }
  eg.globalAlpha = 1;
  const make = (source: HTMLCanvasElement, color: boolean) => {
    const t = new THREE.CanvasTexture(source);
    t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.channel = 1;
    t.anisotropy = 8;
    return t;
  };
  atlas = { color: make(c, true), orm: make(oc, false), emissive: make(ec, true) };
  return atlas;
}

/**
 * A flat decal quad `width` wide (its height from the region's aspect), facing +Z before
 * `at` moves it. UVs point into the atlas (flipY: canvas top is v = 1).
 */
export function decal(name: DecalName, width: number, at: Placement = {}): THREE.BufferGeometry {
  const r: Region = REGIONS[name];
  const height = (width * r.h) / r.w;
  const g = new THREE.PlaneGeometry(width, height);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i);
    const v = uv.getY(i);
    uv.setXY(i, (r.x + u * r.w) / W, 1 - (r.y + (1 - v) * r.h) / H);
  }
  return place(g, at);
}

/**
 * A decal bent round a cylinder of `radius` about +Y, on its outside, centred on the +Z side
 * before `at` moves it. `along: 'around'` runs the text round the cylinder (a band on a drum);
 * `'axis'` runs it along the axis (a tag on a tube, read along its length).
 */
export function cylinderDecal(name: DecalName, radius: number, width: number, along: 'around' | 'axis', at: Placement = {}, endRadius = radius): THREE.BufferGeometry {
  const r: Region = REGIONS[name];
  const height = (width * r.h) / r.w;
  // The span round the cylinder, and along its axis.
  const arc = along === 'around' ? width : height;
  const length = along === 'around' ? height : width;
  const steps = Math.max(2, Math.ceil((arc / radius) * 16));
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const index: number[] = [];
  for (let j = 0; j <= 1; j++) {
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps - 0.5) * (arc / radius);
      const y = (j - 0.5) * length;
      // On a cone, the radius runs from `radius` at the bottom to `endRadius` at the top.
      const rr = radius + (endRadius - radius) * j;
      positions.push(Math.sin(a) * rr, y, Math.cos(a) * rr);
      normals.push(Math.sin(a), 0, Math.cos(a));
      // Round the cylinder runs +X-wards seen from outside; along the axis +Y.
      const s = i / steps;
      const u = along === 'around' ? s : j;
      const v = along === 'around' ? j : 1 - s;
      uvs.push((r.x + u * r.w) / W, 1 - (r.y + (1 - v) * r.h) / H);
    }
  }
  for (let i = 0; i < steps; i++) {
    const a = i;
    const b = i + 1;
    const c = steps + 1 + i;
    const d = c + 1;
    index.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(index);
  return place(g, at);
}
