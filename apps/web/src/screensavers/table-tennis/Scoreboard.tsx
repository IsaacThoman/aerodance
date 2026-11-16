import { useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeAll } from '../../../../../packages/arenas/shared/Table.tsx';
import { useDisposable } from '../../../../../packages/stages/shared/hooks.ts';
import { TABLE_Z } from '../../minigames/table-tennis/rig.ts';
import { FONT, roundRect } from '../../ui/draw.ts';
import { clockText, useClockTexture } from '../kit.ts';
import type { ScreensaverContext } from '../types.ts';
import type { Match, Scenario } from './match.ts';

/*
 * The courtside scoreboard: a glossy white stand off the table's −x side, facing the court (and
 * the Broadcast and Courtside views), its screen a deep aqua glass. It keeps the score, the
 * games and the rally's shots; with the Clock setting on In scene it shows the time and the date
 * instead, in big bold digits that read at the 640×480 buffer.
 */

/** Where it stands (the room), facing +x, and its screen's size (m). */
export const BOARD = { x: -2.45, z: TABLE_Z - 0.15, width: 1.56, height: 0.82, bottom: 1.12 } as const;
const W = 512, H = 256;

const NAMES: Record<Scenario, readonly [string, string]> = {
  robot: ['DANCER', 'ROBOT'],
  dancers: ['BLUE', 'VIOLET'],
  robots: ['TORVEN 1', 'TORVEN 2'],
};
const COLORS: Record<Scenario, readonly [string, string]> = {
  robot: ['#4fb6ff', '#ff9a3c'],
  dancers: ['#4fb6ff', '#c58bff'],
  robots: ['#ff9a3c', '#ffc66b'],
};

function glass(g: CanvasRenderingContext2D) {
  const bg = g.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#0d6f96');
  bg.addColorStop(0.55, '#063d5e');
  bg.addColorStop(1, '#042a44');
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
}

// The glass's sheen over the top of the screen.
function sheen(g: CanvasRenderingContext2D) {
  const hi = g.createLinearGradient(0, 0, 0, H * 0.5);
  hi.addColorStop(0, 'rgba(255,255,255,0.32)');
  hi.addColorStop(1, 'rgba(255,255,255,0.03)');
  g.fillStyle = hi;
  g.beginPath();
  g.ellipse(W / 2, -H * 0.18, W * 0.62, H * 0.62, 0, 0, Math.PI * 2);
  g.fill();
}

function text(g: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, { weight = 800, align = 'center' as CanvasTextAlign, color = '#ffffff', glow = 0 } = {}) {
  g.font = `${weight} ${size}px ${FONT}`;
  g.textAlign = align;
  g.textBaseline = 'middle';
  g.shadowColor = glow ? 'rgba(120,230,255,0.85)' : 'rgba(0,20,40,0.6)';
  g.shadowBlur = glow || 4;
  g.fillStyle = color;
  g.fillText(s, x, y);
  g.shadowBlur = 0;
}

function drawTime(g: CanvasRenderingContext2D, now: Date) {
  const { time, period, day } = clockText(now);
  g.font = `800 150px ${FONT}`;
  const tw = g.measureText(time).width;
  g.font = `800 44px ${FONT}`;
  const pw = period ? g.measureText(period).width + 12 : 0;
  const x = (W - tw - pw) / 2;
  text(g, time, x, 112, 150, { align: 'left', glow: 18 });
  if (period) text(g, period, x + tw + 12, 72, 44, { align: 'left', color: '#bff3ff' });
  text(g, day, W / 2, 214, 30, { weight: 700, color: '#bff3ff' });
}

function drawScore(g: CanvasRenderingContext2D, scenario: Scenario, score: readonly number[], games: readonly number[], shots: number) {
  const names = NAMES[scenario], colors = COLORS[scenario];
  for (let i = 0; i < 2; i++) {
    const cx = i === 0 ? W * 0.27 : W * 0.73;
    g.fillStyle = colors[i];
    roundRect(g, cx - 92, 22, 184, 36, 18);
    g.fill();
    text(g, names[i], cx, 41, 24, { color: '#ffffff' });
    text(g, String(score[i]), cx, 140, 128, { glow: 14 });
  }
  text(g, ':', W / 2, 134, 80, { color: '#bff3ff' });
  const line = `GAMES ${games[0]}–${games[1]}${shots > 0 ? `   ·   RALLY ${shots}` : ''}`;
  text(g, line, W / 2, 226, 24, { weight: 700, color: '#bff3ff' });
}

export function Scoreboard({ ctx, match }: { ctx: ScreensaverContext; match: Match }) {
  // What it shows, kept as state so the screen is redrawn only when it changes.
  const [shown, setShown] = useState('');
  useFrame(() => {
    const clock = ctx.clock() === 'scene';
    const next = clock ? 'clock' : `${match.score.join('-')}|${match.games.join('-')}|${match.shots}`;
    if (next !== shown) setShown(next);
  });
  const face = useClockTexture(W, H, (g, now) => {
    glass(g);
    if (shown === 'clock') drawTime(g, now);
    else drawScore(g, match.scenario, match.score, match.games, match.shots);
    sheen(g);
  }, { key: shown });
  const parts = useDisposable(() => {
    const { width, height, bottom } = BOARD;
    const frame = new RoundedBoxGeometry(width + 0.14, height + 0.14, 0.09, 4, 0.05).translate(0, bottom + height / 2, -0.03);
    const post = (x: number) => new THREE.CylinderGeometry(0.035, 0.045, bottom + 0.1, 14).translate(x, (bottom + 0.1) / 2, -0.03);
    const foot = (x: number) => new THREE.CylinderGeometry(0.13, 0.15, 0.04, 20).translate(x, 0.02, -0.03);
    return {
      stand: mergeAll([frame, post(-width * 0.32), post(width * 0.32), foot(-width * 0.32), foot(width * 0.32)]),
      white: new THREE.MeshPhysicalMaterial({ color: '#f4fbfa', roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.08 }),
      screen: new THREE.PlaneGeometry(BOARD.width, BOARD.height).translate(0, BOARD.bottom + BOARD.height / 2, 0.02),
    };
  });
  return (
    <group position={[BOARD.x, 0, BOARD.z]} rotation-y={Math.PI / 2}>
      <mesh geometry={parts.stand} material={parts.white} castShadow receiveShadow />
      <mesh geometry={parts.screen}>
        <meshBasicMaterial map={face} toneMapped={false} />
      </mesh>
    </group>
  );
}
