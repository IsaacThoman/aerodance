import { TABLE } from '../../minigames/table-tennis/ball.ts';
import { TABLE_Z } from '../../minigames/table-tennis/rig.ts';
import type { Shot, ShotFrame } from '../kit.ts';

/*
 * The screensaver's camera views, in the room (the minigame's: the table's middle at z = TABLE_Z,
 * the near player at +z, the far one, or the robot, at −z), each slow and smooth enough to hold
 * for a minute or more. The near player's place across (`follow.x`, eased) steers the views
 * that are behind or beside them. The scoreboard stands off the table's −x side, facing +x, where
 * Broadcast and Courtside see it.
 *
 *   broadcast   the hero shot: up in the stands on the +x side, the waterfall and the pool behind,
 *               drifting slowly along the table
 *   courtside   low by the net on the +x side, looking across at the near player
 *   shoulder    over the near player's shoulder, down the table at the far end
 *   far-end     from behind the far end, high, past the robot (or the far dancer) to the near player
 *   overhead    high above the table, turning slowly round it
 */

export interface Follow { x: number; }

const Z = TABLE_Z, L = TABLE.halfLength, TOP = TABLE.top;
const ease = (u: number) => u * u * (3 - 2 * u);
/** 0 to 1 and back over `period` seconds, eased at each end, starting at `phase` (0-1) of the way. */
const swing = (t: number, period: number, phase = 0) => {
  const p = ((t / period + phase) % 1) * 2;
  return ease(p < 1 ? p : 2 - p);
};

export const VIEW_IDS = ['broadcast', 'courtside', 'shoulder', 'far-end', 'overhead'] as const;
export type ViewId = typeof VIEW_IDS[number];

/**
 * How far (radians) each view turns to its left while the preview's settings cover the left of
 * the picture (at the usual shift; more with more): the near player, at the left of most views,
 * comes out from under them.
 */
export const PREVIEW_TURN: Record<ViewId, number> = { broadcast: 0.27, courtside: 0.1, shoulder: 0.3, 'far-end': 0.16, overhead: 0.22 };
/** ctx.shift() at which a view turns by its PREVIEW_TURN. */
const USUAL_SHIFT = 0.16;

/** A shot turned `turn` of its PREVIEW_TURN to the left about its camera, for a picture shifted by `shift`. */
export function turnForPreview(frame: ShotFrame, view: ViewId, shift: number): ShotFrame {
  const a = PREVIEW_TURN[view] * Math.min(1.6, Math.max(0, shift / USUAL_SHIFT));
  if (a < 1e-4) return frame;
  const [px, , pz] = frame.position, [tx, ty, tz] = frame.target;
  const dx = tx - px, dz = tz - pz, c = Math.cos(a), s = Math.sin(a);
  // (Turning left about +y, as seen from above.)
  return { ...frame, target: [px + dx * c + dz * s, ty, pz - dx * s + dz * c] };
}

export function views(follow: Follow, robots: boolean): Record<ViewId, Shot> {
  return {
    broadcast: (t): ShotFrame => {
      const u = swing(t, 72, 0.25);
      // (Two arms reach further each way than a dancer stands.)
      const mid = robots ? -0.15 : 0.25;
      return {
        // (Higher with the wider lens, to look over the umpire's chair.)
        position: [5.1, (robots ? 4.55 : 4.0) + 0.15 * swing(t, 53), Z + mid + 0.7 - 0.55 * u],
        target: [-0.3, TOP + 0.09, Z + mid - 0.35 * u],
        fov: robots ? 37 : 33,
      };
    },
    courtside: (t): ShotFrame => {
      const u = swing(t, 64, 0.1);
      return {
        position: [1.85 + 0.15 * u, 1.12 + 0.05 * Math.sin(t * 0.21), Z - 1.35 + 0.4 * u],
        target: [follow.x * 0.6 - 0.3, TOP + 0.4, Z + L + 0.4],
        fov: 40,
      };
    },
    shoulder: (t): ShotFrame => {
      // (Out to the right and up, so the dancer's big glass head stays clear of the table.)
      const behind = robots ? 3.3 : 2.95, high = robots ? 2.85 : 2.7;
      const sway = Math.sin(t * 0.17) * 0.1;
      return {
        position: [follow.x + 1.55 + sway, high + 0.05 * Math.sin(t * 0.13), Z + L + behind],
        target: [follow.x * 0.3 - 0.45, TOP + 0.04, Z - L - 0.2],
        fov: 42,
      };
    },
    'far-end': (t): ShotFrame => {
      const u = swing(t, 80);
      return {
        position: [-2.5 + 0.55 * u, 3.2 + 0.12 * swing(t, 47), Z - L - 2.55],
        target: [follow.x * 0.3 + 0.3, TOP + 0.09, Z + 0.8],
        fov: 38,
      };
    },
    overhead: (t): ShotFrame => {
      const a = 0.9 + (t / 150) * Math.PI * 2;
      return {
        position: [Math.sin(a) * 1.9, 5.3, Z - 0.3 + Math.cos(a) * 1.9],
        target: [Math.sin(a) * 0.2, TOP, Z - 0.3 + Math.cos(a) * 0.2],
        fov: 46,
      };
    },
  };
}
