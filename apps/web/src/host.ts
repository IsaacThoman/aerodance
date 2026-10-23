/*
 * What the iPhone/iPad app (apps/ios/) tells the page about itself. Browsers don't set it,
 * so everything reads as false there.
 *
 *   globalThis.__aerodanceHost = { interrupted, tv, screen }
 *   window 'aerodance-host' event (a CustomEvent, detail = the same fields) on every change
 *
 * interrupted: a phone call, Siri or an alarm has taken the app's audio.
 * tv:          the game is on an external display (AirPlay Screen Mirroring or an HDMI
 *              adapter) and its sound goes there too, which delays its picture along with
 *              its sound.
 * screen:      where the game's picture is: 'phone' (the iPhone or iPad itself) or 'tv' (an
 *              external display, wherever the sound goes).
 *
 * The app also lays an invisible AirPlay picker over the game's AirPlay bubble
 * (menu/AirPlayButton.tsx), where the page says it is: placeAirPlayPicker().
 *
 * const off = onHostChange((host) => ...); hostState().tv; inApp(); client() === 'tvos'
 */

export interface HostState { interrupted: boolean; tv: boolean; screen: 'phone' | 'tv'; }

const read = (value: unknown): HostState => {
  const v = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  return { interrupted: v.interrupted === true, tv: v.tv === true, screen: v.screen === 'tv' ? 'tv' : 'phone' };
};
const host = () => (globalThis as { __aerodanceHost?: unknown }).__aerodanceHost;

export const hostState = () => read(host());

/** The page runs in the iPhone/iPad app rather than a browser. */
export const inApp = () => typeof host() === 'object' && host() !== null;

/**
 * Which build of the game this is: 'web' (a browser), 'ios' (the iPhone/iPad app's web view,
 * apps/ios/) or 'tvos' (the Apple TV app's JavaScriptCore host, apps/tvos/, which puts its
 * natives on globalThis.__native). Prefer checking for the feature itself where there is one
 * (RTCPeerConnection, getUserMedia); this is for what only the platform tells you.
 */
export type Client = 'web' | 'ios' | 'tvos';
export const client = (): Client => ('__native' in globalThis ? 'tvos' : inApp() ? 'ios' : 'web');

/** Calls fn with the app's new state on every change; returns the unsubscribe. */
export function onHostChange(fn: (state: HostState) => void, target: EventTarget | undefined = globalThis.window) {
  const listener = (e: Event) => fn(read((e as CustomEvent<unknown>).detail));
  target?.addEventListener('aerodance-host', listener);
  return () => target?.removeEventListener('aerodance-host', listener);
}

/** Where the app's AirPlay picker goes, in the page's CSS pixels; null takes it away. */
export interface PickerRect { x: number; y: number; w: number; h: number; }
type AirPlayHook = (rect: PickerRect | null) => void;
const airPlayHook = () => (globalThis as { __aerodanceAirPlayAt?: unknown }).__aerodanceAirPlayAt;

/** The app can lay an AirPlay picker over the page (the iPhone/iPad app, not a browser). */
export const canPickAirPlay = () => typeof airPlayHook() === 'function';

/** Puts the app's invisible AirPlay picker over this rect, or takes it away. */
export function placeAirPlayPicker(rect: PickerRect | null) {
  const hook = airPlayHook();
  if (typeof hook === 'function') (hook as AirPlayHook)(rect);
}
