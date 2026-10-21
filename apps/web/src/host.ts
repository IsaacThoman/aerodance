/*
 * What the iPhone/iPad app (apps/ios/) tells the page about itself. Browsers don't set it,
 * so everything reads as false there.
 *
 *   globalThis.__aerodanceHost = { interrupted, tv }
 *   window 'aerodance-host' event (a CustomEvent, detail = the same fields) on every change
 *
 * interrupted: a phone call, Siri or an alarm has taken the app's audio.
 * tv:          the game is on an external display (AirPlay Screen Mirroring or an HDMI
 *              adapter), which delays its picture along with its sound.
 *
 * const off = onHostChange((host) => ...); hostState().tv; inApp()
 */

export interface HostState { interrupted: boolean; tv: boolean; }

const read = (value: unknown): HostState => {
  const v = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  return { interrupted: v.interrupted === true, tv: v.tv === true };
};
const host = () => (globalThis as { __aerodanceHost?: unknown }).__aerodanceHost;

export const hostState = () => read(host());

/** The page runs in the iPhone/iPad app rather than a browser. */
export const inApp = () => typeof host() === 'object' && host() !== null;

/** Calls fn with the app's new state on every change; returns the unsubscribe. */
export function onHostChange(fn: (state: HostState) => void, target: EventTarget | undefined = globalThis.window) {
  const listener = (e: Event) => fn(read((e as CustomEvent<unknown>).detail));
  target?.addEventListener('aerodance-host', listener);
  return () => target?.removeEventListener('aerodance-host', listener);
}
