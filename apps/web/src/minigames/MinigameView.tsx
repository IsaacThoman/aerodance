import { Component, Suspense, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { MinigameReact } from './hooks.ts';
import type { MinigameSession } from './MinigameSession.ts';

/*
 * Mounts a session's game inside the <Canvas> once its code has loaded, in the session's React
 * context (hooks.ts), for the whole round (App keys it by session.key, so every round, Play again
 * included, mounts the game afresh). App renders it where the game's scene says
 * (types.ts MinigameScene): inside the dance stage's scene for a stage, beside everything else
 * otherwise. A game that throws is caught here: the session fails (MinigameScreen says so and
 * offers the way back) and the rest of the game carries on.
 *
 * <MinigameView session={session} />
 */

class GameBoundary extends Component<{ session: MinigameSession; children?: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) {
    console.error(`[minigames] ${this.props.session.game.id} crashed:`, error);
    this.props.session.fail(`${this.props.session.game.title} hit a problem and stopped.`);
  }
  render() { return this.state.failed ? null : this.props.children; }
}

export default function MinigameView({ session }: { session: MinigameSession }) {
  // The game mounts once its code is in (a phase change).
  const [Game, setGame] = useState(() => session.component);
  useEffect(() => {
    setGame(() => session.component);
    return session.onChange((s) => setGame(() => s.component));
  }, [session]);
  if (!Game) return null;
  return (
    <MinigameReact.Provider value={session}>
      <GameBoundary key={session.key} session={session}>
        <Suspense fallback={null}>
          <Game ctx={session} />
        </Suspense>
      </GameBoundary>
    </MinigameReact.Provider>
  );
}
