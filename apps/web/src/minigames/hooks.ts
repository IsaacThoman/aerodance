import { createContext, useContext, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import useCanvasUI from '../ui/useCanvasUI.ts';
import type { CanvasUI, CanvasUIOptions, Widget } from '../ui/useCanvasUI.ts';
import type { MinigameSession } from './MinigameSession.ts';
import type { MinigameContext, MinigameFrame, MinigamePhase } from './types.ts';

/*
 * The hooks a game is built from, inside the session's React context (MinigameView provides it):
 *
 *   useMinigame()                    the MinigameContext (also the game's `ctx` prop)
 *   useMinigameFrame((frame) => {})  every frame, after the host has taken in this frame's poses
 *                                    and gestures; frame.dt is 0 unless playing
 *   useMinigameOverlay({ draw })     the game's own 2D layer, in design units like the menus,
 *                                    under the host's HUD and pause screen
 *
 * Frame order (useFrame priorities): the host's update (-1), the game's frames (-0.5 by default),
 * the background and any MinigameWorld or stage (1), MinigameLayer (1.5) and MirrorCharacters
 * (1.55), the game's overlay (2.1), the host's overlay (2.3), the results (2.5).
 */

export const MinigameReact = createContext<MinigameSession | null>(null);

/** The game's MinigameContext. */
export function useMinigame(): MinigameContext {
  const session = useContext(MinigameReact);
  if (!session) throw Error('useMinigame needs a minigame: render the game through MinigameView');
  return session;
}
/** The session itself, for the platform's own components. */
export function useMinigameSession(): MinigameSession {
  const session = useContext(MinigameReact);
  if (!session) throw Error('Not inside a minigame');
  return session;
}

/** Calls back every frame with this frame (types.ts MinigameFrame), after the host's update. */
export function useMinigameFrame(callback: (frame: MinigameFrame, ctx: MinigameContext) => void, priority = -0.5) {
  const session = useMinigameSession();
  const ref = useRef(callback);
  ref.current = callback;
  useFrame(() => { if (session.tick) ref.current(session.tick, session); }, priority);
}

/** The phases a game's overlay shows in, by default: the game's whole round, not its results. */
export const OVERLAY_PHASES: readonly MinigamePhase[] = ['howto', 'countdown', 'playing', 'paused', 'finishing'];

export interface MinigameOverlayOptions<W extends Widget = Widget> {
  /** Draws the layer in design units (1600x900 or 1200x900), every frame it's showing. */
  draw: (g: CanvasRenderingContext2D, ui: CanvasUI<W>, frame: MinigameFrame) => void;
  /** Taps and clicks on its widgets, while playing (most games are played with the body: none). */
  widgets?: CanvasUIOptions<W>['widgets'];
  onActivate?: CanvasUIOptions<W>['onActivate'];
  /** When it shows (default OVERLAY_PHASES). */
  phases?: readonly MinigamePhase[];
  priority?: number;
}

/** The game's own canvas layer (ui/useCanvasUI.ts), fading in and out with its round. */
export function useMinigameOverlay<W extends Widget = Widget>({ draw, widgets, onActivate, phases = OVERLAY_PHASES, priority = 2.1 }: MinigameOverlayOptions<W>) {
  const session = useMinigameSession();
  const st = useRef({ alpha: 0 }).current;
  const opts = useRef({ draw, phases });
  opts.current = { draw, phases };
  return useCanvasUI<W>({
    priority,
    active: () => session.phase() === 'playing' && st.alpha > 0.5,
    widgets,
    onActivate,
    update: (_, s) => {
      st.alpha = s.ease(st.alpha, opts.current.phases.includes(session.phase()) ? 1 : 0, 6);
      // Games move every frame.
      if (st.alpha > 0) s.invalidate();
    },
    opacity: () => st.alpha,
    draw: (g, s) => { if (session.tick) opts.current.draw(g, s, session.tick); },
  });
}
