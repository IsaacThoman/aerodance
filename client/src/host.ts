/*
 * What the iPhone/iPad app (client-ios/) tells the page about itself. Browsers don't set it,
 * so everything reads as false there.
 *
 *   globalThis.__aerodanceHost = { multitasking, interrupted }
 *   window 'aerodance-host' event (a CustomEvent, detail = the same fields) on every change
 *
 * multitasking: on iPad, aerodance isn't full screen (Split View, Slide Over, Stage Manager),
 *               and iPadOS stops the camera.
 * interrupted:  a phone call, Siri or an alarm has taken the app's audio.
 *
 * const off = onHostChange((host) => ...); hostState().multitasking
 */

export interface HostState { multitasking: boolean; interrupted: boolean; }

const read = (value: unknown): HostState => {
  const v = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  return { multitasking: v.multitasking === true, interrupted: v.interrupted === true };
};

export const hostState = () => read((globalThis as { __aerodanceHost?: unknown }).__aerodanceHost);

/** Calls fn with the app's new state on every change; returns the unsubscribe. */
export function onHostChange(fn: (state: HostState) => void, target: EventTarget | undefined = globalThis.window) {
  const listener = (e: Event) => fn(read((e as CustomEvent<unknown>).detail));
  target?.addEventListener('aerodance-host', listener);
  return () => target?.removeEventListener('aerodance-host', listener);
}
