import { useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import { FONT, ICONS, drawDisc, drawGlassCircle, drawPill, drawTitle, ellipsize, text } from '../ui/draw.ts';
import type { Circle, IconName } from '../ui/draw.ts';
import useCanvasUI from '../ui/useCanvasUI.ts';
import type { Widget } from '../ui/useCanvasUI.ts';
import { phoneDesign } from '../phone/layout.ts';
import { remoteLayout } from './layout.ts';
import type { RemoteButton } from './layout.ts';
import { backAction, inApp, screenName } from './bridge.ts';
import type { BackAction, GamePage, RemoteKey } from './bridge.ts';

/**
 * The TV remote, drawn in-engine like the game's menus: the arrows around OK, and Back (Pause
 * or Resume while a song is on), which send the game the keys its canvas UI already knows, as
 * the Apple TV's Siri Remote does. Buttons act as soon as they're touched, and the arrows repeat
 * while held, like a keyboard's. The AirPlay button is only a picture: the app lays its own
 * AirPlay picker, invisible, over it (RemoteApp). The status line says what the TV is showing.
 *
 * The canvas reports data-remote-ready / -screen (the status line's) / -back (back, pause or
 * resume) for tests.
 *
 * <RemoteScreen page onKey />
 */

export const KEYS: Record<RemoteButton, RemoteKey> = {
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', ok: 'Enter', back: 'Escape',
};
const ARROWS = ['up', 'down', 'left', 'right'] as const;
const REPEAT_DELAY_MS = 400;
const REPEAT_EVERY_MS = 120;

export const BACK_LABELS: Record<BackAction, { label: string; icon: IconName }> = {
  back: { label: 'Back', icon: 'back' },
  pause: { label: 'Pause', icon: 'pause' },
  resume: { label: 'Resume', icon: 'play' },
};

/** The status line: what the TV shows, or that the page needs the app. */
export const statusLine = (page: GamePage, app = inApp()) => (app ? `On the TV · ${screenName(page)}` : 'The remote for the aerodance app on a TV');

export interface RemoteScreenProps {
  /** The game's reported state, from the app. */
  page: GamePage;
  /** A button: its key, and whether it's repeating while held. */
  onKey: (key: RemoteKey, repeat: boolean) => void;
}
type RemoteWidget = Widget & { id: RemoteButton };

// Text straight over the background: the navy drop shadow the game's own titles use.
function shadowed(g: CanvasRenderingContext2D, draw: () => void) {
  g.save();
  g.shadowColor = 'rgba(0, 34, 84, 0.8)';
  g.shadowBlur = 5;
  g.shadowOffsetY = 2;
  draw();
  g.restore();
}

// A glass arrow button, pressed in while held.
function drawArrow(g: CanvasRenderingContext2D, c: Circle, icon: 'up' | 'down' | 'left' | 'right', hover: number, held: boolean) {
  const r = held ? c.r * 0.94 : c.r;
  drawGlassCircle(g, { ...c, r }, held ? 1 : hover * 0.5);
  if (held) {
    g.beginPath();
    g.arc(c.x, c.y, r, 0, Math.PI * 2);
    g.fillStyle = 'rgba(191, 244, 255, 0.25)';
    g.fill();
  }
  g.save();
  g.lineWidth = 7;
  g.lineCap = g.lineJoin = 'round';
  g.strokeStyle = '#ffffff';
  ICONS[icon](g, c.x, c.y, r * 1.3);
  g.restore();
}

// OK: the game's glossy blue disc, ringed in white.
function drawOK(g: CanvasRenderingContext2D, c: Circle, held: boolean) {
  const r = held ? c.r * 0.95 : c.r;
  drawDisc(g, c.x, c.y, r);
  if (held) {
    g.beginPath();
    g.arc(c.x, c.y, r, 0, Math.PI * 2);
    g.fillStyle = 'rgba(0, 30, 70, 0.22)';
    g.fill();
  }
  g.beginPath();
  g.arc(c.x, c.y, r, 0, Math.PI * 2);
  g.lineWidth = 4;
  g.strokeStyle = 'rgba(255, 255, 255, 0.9)';
  g.stroke();
  shadowed(g, () => text(g, 'OK', c.x, c.y + 3, { size: Math.round(r * 0.5), weight: 800, align: 'center' }));
}

export default function RemoteScreen({ page, onKey }: RemoteScreenProps) {
  const gl = useThree((state) => state.gl);
  const props = useRef({ page, onKey });
  props.current = { page, onKey };
  const st = useRef<{ held: RemoteButton | null; timer: number; drawn: string; reported: string }>(
    { held: null, timer: 0, drawn: '', reported: '' }).current;

  // (Timeouts and intervals share one set of ids.)
  const release = () => {
    clearTimeout(st.timer);
    st.timer = 0;
    st.held = null;
  };
  const hold = (id: RemoteButton) => {
    release();
    st.held = id;
    const key = KEYS[id];
    props.current.onKey(key, false);
    if (!(ARROWS as readonly string[]).includes(id)) return;
    st.timer = window.setTimeout(() => {
      st.timer = window.setInterval(() => { if (st.held === id) props.current.onKey(key, true); }, REPEAT_EVERY_MS);
    }, REPEAT_DELAY_MS);
  };
  // A hidden page (the TV gone, the app away) may never hear the finger lift: stop repeating.
  useEffect(() => {
    const onHide = () => { if (document.hidden) { clearTimeout(st.timer); st.timer = 0; st.held = null; } };
    document.addEventListener('visibilitychange', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      clearTimeout(st.timer);
    };
  }, [st]);

  const ui = useCanvasUI<RemoteWidget>({
    priority: 2,
    design: phoneDesign,
    // Every button acts on touch (a drag, in the canvas UI's terms) rather than on release.
    widgets: (s) => {
      const L = remoteLayout(s);
      return [
        ...ARROWS.map((id) => ({ id, circle: L[id], drag: true })),
        { id: 'ok', circle: L.ok, drag: true },
        { id: 'back', rect: L.back, drag: true },
      ];
    },
    onDrag: (wdg) => { if (st.held !== wdg.id) hold(wdg.id); },
    update: (_dt, s) => {
      // Let go: the canvas UI's drag has ended.
      if (st.held && s.drag?.id !== st.held) { release(); s.invalidate(); }
      const p = props.current;
      const screen = statusLine(p.page);
      const back = backAction(p.page);
      const key = `${screen}|${back}|${st.held}`;
      if (key !== st.drawn) { st.drawn = key; s.invalidate(); }
      const report = JSON.stringify([screen, back]);
      if (report !== st.reported) {
        st.reported = report;
        Object.assign(gl.domElement.dataset, { remoteReady: 'true', remoteScreen: screen, remoteBack: back });
      }
    },
    draw: (g, s) => {
      const L = remoteLayout(s);
      const p = props.current;
      drawTitle(g, L.title);
      g.font = `700 22px ${FONT}`;
      const status = ellipsize(g, statusLine(p.page), L.status.w);
      shadowed(g, () => text(g, status, L.status.x, L.status.y, { size: 22, weight: 700, color: '#e6f8ff' }));

      drawGlassCircle(g, L.airplay, 0);
      g.save();
      g.lineWidth = 4;
      g.lineCap = g.lineJoin = 'round';
      g.strokeStyle = '#ffffff';
      ICONS.airplay(g, L.airplay.x, L.airplay.y, L.airplay.r);
      g.restore();

      for (const id of ARROWS) drawArrow(g, L[id], id, s.hover[id] ?? 0, st.held === id);
      drawOK(g, L.ok, st.held === 'ok');
      const back = BACK_LABELS[backAction(p.page)];
      drawPill(g, L.back, { ...back, hover: s.hover.back ?? 0, press: st.held === 'back' ? 1 : 0 });

      shadowed(g, () => text(g, 'Change the volume with the volume buttons', L.hint.x, L.hint.y, { size: 20, weight: 600, color: 'rgba(230, 248, 255, 0.75)', align: 'center' }));
    },
  });

  // The game's state arrives between frames.
  useEffect(() => { ui.invalidate(); }, [ui, page]);

  return null;
}
