import { useRef } from 'react';
import { useThree } from '@react-three/fiber';
import { TAU } from '../../ui/draw.ts';
import { displayDesign } from '../../display.ts';
import { PLAYERS } from '../../game/results.ts';
import { useMinigameFrame, useMinigameOverlay } from '../hooks.ts';
import { MirrorCharacters, cameraArea, toDesign } from '../scene.tsx';
import { JOINT } from '../pose/body.ts';
import type { MinigameContext } from '../types.ts';
import { drawBubble } from './index.ts';

/*
 * Bubble Pop, the reference minigame (index.ts). Everything a game does, in small:
 *
 *   - the players' glass characters as a mirror over the menu's background (MirrorCharacters),
 *     with the bubbles and hand markers on the game's overlay (useMinigameOverlay), both mapped
 *     from the pose API's screen space with the same cameraArea, so a hand is where its marker is
 *   - each frame's logic in useMinigameFrame: bubbles rise (frame.dt stops while paused), a hand
 *     touching one pops it (the pose API's screen space), a clap (frame.events) pops every bubble
 *     near that player
 *   - scores with ctx.addScore (the host's HUD shows them; durationMs ends the round), and the
 *     game's state for play.ts with ctx.report (data-mg-bubbles, data-mg-popped)
 */

interface Bubble { x: number; y: number; r: number; vy: number; wobble: number; tint: string; }
interface Pop { x: number; y: number; r: number; at: number; tint: string; }

const TINTS = ['#9ff3ff', '#c8b6ff', '#a6ffcf', '#ffc6ea'];
// A hand within this many design units of a bubble's edge pops it.
const REACH = 26;
// Bubbles a second, for each player.
const SPAWN_RATE = 1.1;
const POP_S = 0.35;

export default function BubblePop({ ctx }: { ctx: MinigameContext }) {
  const size = useThree((state) => state.size);
  const st = useRef({ bubbles: [] as Bubble[], pops: [] as Pop[], due: 0, seed: 12345, popped: 0 }).current;
  const random = () => (st.seed = (st.seed * 16807) % 2147483647) / 2147483647;

  // Where the camera's picture fills the screen: the bubbles and the mirror both use it.
  const area = () => {
    const { w, h } = displayDesign(size.width, size.height);
    return cameraArea(w, h, ctx.players[0]?.aspect ?? 4 / 3, 'cover');
  };
  const pop = (b: Bubble, player: number, now: number) => {
    st.bubbles.splice(st.bubbles.indexOf(b), 1);
    st.pops.push({ x: b.x, y: b.y, r: b.r, at: now, tint: b.tint });
    st.popped++;
    ctx.addScore(player, 1);
  };

  useMinigameFrame((frame) => {
    const { w, h } = displayDesign(size.width, size.height);
    const now = frame.now / 1000;
    st.pops = st.pops.filter((p) => now - p.at < POP_S);
    if (frame.phase !== 'playing') return;
    // New bubbles from the bottom, across the screen.
    st.due += frame.dt * SPAWN_RATE * ctx.playerCount;
    while (st.due >= 1) {
      st.due -= 1;
      const r = 38 + random() * 34;
      st.bubbles.push({ x: 80 + random() * (w - 160), y: h + r, r, vy: 70 + random() * 60, wobble: random() * TAU, tint: TINTS[Math.floor(random() * TINTS.length)] });
    }
    for (const b of st.bubbles) { b.y -= b.vy * frame.dt; b.wobble += frame.dt * 2; b.x += Math.sin(b.wobble) * 20 * frame.dt; }
    st.bubbles = st.bubbles.filter((b) => b.y > -b.r);
    // Hands pop what they touch.
    const a = area();
    for (const p of frame.players) {
      if (!p.present) continue;
      for (const joint of [JOINT.leftWrist, JOINT.rightWrist]) {
        if (p.jointConfidence[joint] < 0.5) continue;
        const hand = toDesign(p.screen[joint], a);
        for (const b of [...st.bubbles]) if (Math.hypot(b.x - hand.x, b.y - hand.y) < b.r + REACH) pop(b, p.id, now);
      }
    }
    // A clap pops every bubble within a torso and a half of the player's hips.
    for (const e of frame.events) {
      if (e.type !== 'clap') continue;
      const p = frame.players[e.player], hips = toDesign(p.screen[JOINT.leftHip], a), reach = p.torso * a.h * 1.5;
      const near = st.bubbles.filter((b) => Math.abs(b.x - hips.x) < reach);
      for (const b of near) pop(b, e.player, now);
    }
    ctx.report({ bubbles: st.bubbles.length, popped: st.popped });
  });

  useMinigameOverlay({
    draw: (g, _ui, frame) => {
      const now = frame.now / 1000;
      for (const b of st.bubbles) drawBubble(g, b.x, b.y, b.r, b.tint);
      // A pop: a ring flying out and fading.
      for (const p of st.pops) {
        const k = (now - p.at) / POP_S;
        g.beginPath();
        g.arc(p.x, p.y, p.r * (1 + k * 0.8), 0, TAU);
        g.lineWidth = 4 * (1 - k);
        g.strokeStyle = `rgba(255, 255, 255, ${1 - k})`;
        g.stroke();
      }
      // Each hand's marker, in its player's colour.
      const a = area();
      for (const p of frame.players) {
        if (!p.present) continue;
        for (const joint of [JOINT.leftWrist, JOINT.rightWrist]) {
          if (p.jointConfidence[joint] < 0.5) continue;
          const hand = toDesign(p.screen[joint], a);
          g.beginPath();
          g.arc(hand.x, hand.y, 16, 0, TAU);
          g.fillStyle = `${PLAYERS[p.id].light}aa`;
          g.fill();
          g.lineWidth = 3;
          g.strokeStyle = '#ffffff';
          g.stroke();
        }
      }
    },
  });

  return <MirrorCharacters fit="cover" scale={0.8} />;
}
