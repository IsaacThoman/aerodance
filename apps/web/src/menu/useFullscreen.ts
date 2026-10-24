import { useCallback, useEffect, useState } from 'react';

/** The fullscreen API of a document, with older Safari's prefixed methods (which return void). */
export interface FullscreenDocument {
  fullscreenEnabled?: boolean;
  fullscreenElement?: object | null;
  exitFullscreen?: () => Promise<void>;
  webkitFullscreenEnabled?: boolean;
  webkitFullscreenElement?: object | null;
  webkitExitFullscreen?: () => void;
  documentElement: {
    requestFullscreen?: () => Promise<void>;
    webkitRequestFullscreen?: () => void;
  };
}
export interface FullscreenState { active: boolean; supported: boolean; }
export interface Fullscreen extends FullscreenState {
  error: string | null;
  toggle: () => void;
}

const fullscreenElement = (doc: FullscreenDocument) => doc.fullscreenElement ?? doc.webkitFullscreenElement;

export function readFullscreenState(doc: FullscreenDocument): FullscreenState {
  const el = doc.documentElement;
  const supported = typeof el.requestFullscreen === 'function'
    ? doc.fullscreenEnabled !== false && typeof doc.exitFullscreen === 'function'
    : doc.webkitFullscreenEnabled !== false && typeof el.webkitRequestFullscreen === 'function' && typeof doc.webkitExitFullscreen === 'function';
  return { active: !!fullscreenElement(doc), supported };
}

// Call directly from the canvas input handler: Safari needs the user's activation.
// Older Safari uses prefixed methods that return void instead of a Promise.
export function toggleFullscreen(doc: FullscreenDocument): Promise<void> | void {
  if (fullscreenElement(doc)) {
    const exit = doc.exitFullscreen ?? doc.webkitExitFullscreen;
    if (!exit) throw Error('Fullscreen is not supported');
    return exit.call(doc);
  }
  const el = doc.documentElement;
  const request = el.requestFullscreen ?? el.webkitRequestFullscreen;
  if (!request) throw Error('Fullscreen is not supported');
  return request.call(el);
}

export default function useFullscreen(): Fullscreen {
  const [state, setState] = useState(() => readFullscreenState(document));
  const [error, setError] = useState<string | null>(null);
  const failed = useCallback(() => setError('Retry fullscreen on this display'), []);

  useEffect(() => {
    const changed = () => {
      setState(readFullscreenState(document));
      setError(null);
    };
    const events: [string, () => void][] = [
      ['fullscreenchange', changed], ['webkitfullscreenchange', changed],
      ['fullscreenerror', failed], ['webkitfullscreenerror', failed],
    ];
    for (const [type, fn] of events) document.addEventListener(type, fn);
    changed();
    return () => {
      for (const [type, fn] of events) document.removeEventListener(type, fn);
    };
  }, [failed]);

  const toggle = useCallback(() => {
    setError(null);
    try {
      Promise.resolve(toggleFullscreen(document)).catch(failed);
    } catch {
      failed();
    }
  }, [failed]);

  return { ...state, error, toggle };
}
