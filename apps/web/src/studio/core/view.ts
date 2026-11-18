// What the author is looking at, shared by every station of an open project: the dancer they're
// working on, the stretch of the song they've selected, and how the coach view is shown.
import { createContext, useContext, useSyncExternalStore } from 'react';

export interface ViewState {
  /** Index of the dancer being worked on. */
  dancer: number;
  /** A selected stretch of the song [start, end] in ms, or null. */
  selection: readonly [number, number] | null;
  /** The clip picked in the timeline (a dancer's id and the clip's), or null. */
  clip: { dancer: string; id: string } | null;
  /** The coach view: the practice floor, or the song's stage as the game shows it. */
  look: 'floor' | 'stage';
  /** Floor view: mirrored like the game's coach, or as filmed. */
  mirror: boolean;
}
export class ViewStore {
  state: ViewState = { dancer: 0, selection: null, clip: null, look: 'floor', mirror: true };
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getState = () => this.state;
  set(patch: Partial<ViewState>) { this.state = { ...this.state, ...patch }; for (const l of this.listeners) l(); }
}
export const ViewContext = createContext<ViewStore | null>(null);
export function useViewStore(): ViewStore {
  const store = useContext(ViewContext);
  if (!store) throw Error('No project is open');
  return store;
}
export function useView(): ViewState {
  const store = useViewStore();
  return useSyncExternalStore(store.subscribe, store.getState);
}
