/*
 * The remote page's link to the iPhone/iPad app (apps/ios/src/main.m), which shows the page on
 * the phone while the game is on a TV.
 *
 * Page to app, through webkit.messageHandlers.aerodanceRemote:
 *   { key, repeat }       a button: the key the game's canvas UI understands (repeat: held down)
 *   { airplay: rect }     where the app's invisible AirPlay picker goes, in CSS pixels (null: away)
 *   { ready: true }       the page listens now; the app sends its state
 * App to page: window.__aerodanceRemote({ page, shown }) with the game's reported state (the
 * canvas's data-* values inject.js passes on: menuScreen, songScreen, gamePhase…) whenever it
 * changes, and whether the remote is showing (false once the TV has gone).
 *
 * Outside the app nothing is listening: inApp() is false and messages go nowhere.
 */

/** The game's reported state, as inject.js passes it on. */
export type GamePage = Readonly<Record<string, string>>;
export interface RemoteState { page: GamePage; shown: boolean; }
export type RemoteKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Enter' | 'Escape';

interface Handler { postMessage(message: unknown): void; }
type RemoteWindow = { webkit?: { messageHandlers?: { aerodanceRemote?: Handler } }; __aerodanceRemote?: (state: unknown) => void };
const page = () => globalThis as RemoteWindow;
const handler = () => page().webkit?.messageHandlers?.aerodanceRemote;

/** The page runs in the iPhone/iPad app, which reads its messages. */
export const inApp = () => !!handler();

export function post(message: object) {
  try { handler()?.postMessage(message); } catch { /* the app has gone */ }
}

const readState = (value: unknown): RemoteState => {
  const v = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  const raw = typeof v.page === 'object' && v.page !== null ? v.page as Record<string, unknown> : {};
  return {
    page: Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string')),
    shown: v.shown !== false,
  };
};

/** Calls fn with the app's state now and on every change; returns the unsubscribe. */
export function listen(fn: (state: RemoteState) => void) {
  page().__aerodanceRemote = (state) => fn(readState(state));
  post({ ready: true });
  return () => { delete page().__aerodanceRemote; };
}

/** What the game is showing, for the status line. */
export function screenName(p: GamePage): string {
  if (p.resultsScreen) return 'Results';
  switch (p.gamePhase) {
    case 'loading': return 'Loading the song';
    case 'calibrating': case 'ready': return 'Getting ready';
    case 'countdown': case 'playing': case 'finishing': return 'Dancing';
    case 'paused': return 'Paused';
    case 'results': return 'Results';
    case 'error': return 'The song couldn\'t start';
  }
  if (p.songReady === 'true') return p.songScreen === 'preview' ? 'Song preview' : p.songScreen === 'dancers' ? 'Choosing dancers' : 'Choosing a song';
  switch (p.menuScreen) {
    case 'main': return 'Main menu';
    case 'players': return 'Players';
    case 'settings': return 'Settings';
  }
  return 'Starting';
}

/** What Back (Escape) does now: pause a song that's on, resume a paused one, else go back. */
export type BackAction = 'back' | 'pause' | 'resume';
export function backAction(p: GamePage): BackAction {
  if (p.gamePhase === 'countdown' || p.gamePhase === 'playing') return 'pause';
  if (p.gamePhase === 'paused') return 'resume';
  return 'back';
}
