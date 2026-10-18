import { useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import { FONT, TAU, drawGlassPanel, drawHeader, drawPill, drawTitle, pill } from '../ui/draw.ts';
import useCanvasUI from '../ui/useCanvasUI.ts';
import type { Widget } from '../ui/useCanvasUI.ts';
import type { PlayerCount } from '../../../packages/pose/choreography.ts';
import type { SoundSettings } from './soundSettings.ts';
import FullscreenButton from './FullscreenButton.tsx';
import { BACK, ONE_PLAYER, SETTINGS, START, TITLE, TWO_PLAYERS } from './layout.ts';

/**
 * Title menu drawn in-engine (see ui/useCanvasUI.ts), laid out in 16:9 design units and
 * drawn after the world (useFrame priority 2).
 *
 * Screens: main (Start, Settings), players (one / two players, then Song Select:
 * game/SongSelect.tsx), settings (sound: Master / Music / Effects volume, Menu music and Mute
 * all, which audio/mixer.ts applies). The main screen also shows the fullscreen bubble in the
 * corner.
 *
 * Input comes from the mouse/touch on the canvas or the keyboard (arrows, Enter, Escape;
 * Left/Right step the volume sliders).
 * `blocked` (the Connect Client card is open) holds input. onScreenChange hears which screen
 * is showing (Settings carries the Connect Client pill). The canvas reports
 * data-menu-screen / data-menu-ready for tests.
 *
 * <MainMenu visible initialScreen="main" onStart={(playerCount) => ...}
 *   onScreenChange={setShown} sound={sound} onSoundChange={setSound} />
 */

export type MenuScreen = 'main' | 'players' | 'settings';
export interface MainMenuProps {
  visible?: boolean;
  /** Holds input (the Connect Client card is open). */
  blocked?: boolean;
  /** Where the menu opens when it is shown. */
  initialScreen?: MenuScreen;
  onStart?: (playerCount: PlayerCount) => void;
  onSettingsOpen?: () => void;
  onScreenChange?: (screen: MenuScreen) => void;
  sound: SoundSettings;
  onSoundChange?: (sound: SoundSettings) => void;
}
type SliderKey = 'master' | 'music' | 'sfx';
type ToggleKey = 'menuMusic' | 'muted';
interface Toggle { key: ToggleKey; label: string; audio?: boolean; on: (p: MainMenuProps) => boolean; }
type MenuWidget = Widget & { slider?: SliderKey; toggle?: Toggle };

// Design space is 1600x900 (16:9); the layout is in ./layout.ts.
const PANEL = { x: 128, y: 540, w: 600, h: 294 };
const SLIDERS: readonly { key: SliderKey; label: string }[] = [
  { key: 'master', label: 'Master' },
  { key: 'music', label: 'Music' },
  { key: 'sfx', label: 'Effects' },
];
// Switches below the sliders: on() reads whether each one is on from the menu's props; audio
// ones also grey out under Mute all.
const TOGGLES: readonly Toggle[] = [
  { key: 'menuMusic', label: 'Menu music', audio: true, on: (p) => p.sound.menuMusic !== false },
  { key: 'muted', label: 'Mute all', on: (p) => !!p.sound.muted },
];
const ROW_Y = (i: number) => PANEL.y + 46 + i * 50;
const SWITCH = { w: 84, h: 42, x: PANEL.x + PANEL.w - 40 - 84 };
const TRACK = { x0: PANEL.x + 190, x1: PANEL.x + PANEL.w - 110 };

const WIDGETS: Record<MenuScreen, MenuWidget[]> = {
  main: [
    { id: 'start', rect: START, primary: true },
    { id: 'settings', rect: SETTINGS },
  ],
  players: [
    { id: 'back', circle: BACK },
    { id: 'one', rect: ONE_PLAYER, primary: true },
    { id: 'two', rect: TWO_PLAYERS },
  ],
  settings: [
    { id: 'back', circle: BACK },
    ...SLIDERS.map((sl, i) => ({ id: sl.key, slider: sl.key, drag: true, rect: { x: TRACK.x0 - 24, y: ROW_Y(i) - 25, w: TRACK.x1 - TRACK.x0 + 48, h: 50 } })),
    ...TOGGLES.map((tg, i) => ({ id: tg.key, toggle: tg, rect: { x: PANEL.x + 16, y: ROW_Y(SLIDERS.length + i) - 24, w: PANEL.w - 32, h: 48 } })),
  ],
};
// Where back / Escape leads from each submenu, and the button there that opens it.
const PARENT: Partial<Record<MenuScreen, MenuScreen>> = { players: 'main', settings: 'main' };
const OPENER: Partial<Record<MenuScreen, string>> = { players: 'start', settings: 'settings' };

const sliderValue = (x: number) => Math.min(1, Math.max(0, (x - TRACK.x0) / (TRACK.x1 - TRACK.x0)));
// Left/Right move a slider a twentieth (5) at a time.
const SLIDER_STEPS = 20;

function drawSettingsPanel(g: CanvasRenderingContext2D, p: MainMenuProps, hover: Record<string, number>) {
  const { sound } = p;
  const { x, w } = PANEL;
  const base = g.globalAlpha;
  drawGlassPanel(g, PANEL, 34);

  const label = (text: string, cy: number) => {
    g.font = `600 30px ${FONT}`;
    g.textBaseline = 'middle';
    g.fillStyle = '#ffffff';
    g.fillText(text, x + 40, cy + 1);
  };

  SLIDERS.forEach((sl, i) => {
    const cy = ROW_Y(i);
    const v = sound[sl.key];
    const kx = TRACK.x0 + v * (TRACK.x1 - TRACK.x0);
    // Only Mute all greys the sliders out; Menu music switches off just the menu track.
    const dim = base * (sound.muted ? 0.45 : 1);
    label(sl.label, cy);

    g.globalAlpha = dim;
    pill(g, TRACK.x0 - 6, cy - 7, TRACK.x1 - TRACK.x0 + 12, 14);
    g.fillStyle = 'rgba(0, 30, 70, 0.45)';
    g.fill();
    if (v > 0.01) {
      pill(g, TRACK.x0 - 6, cy - 7, kx - TRACK.x0 + 12, 14);
      const fill = g.createLinearGradient(0, cy - 7, 0, cy + 7);
      fill.addColorStop(0, '#b8fff0');
      fill.addColorStop(1, '#4fd8e8');
      g.fillStyle = fill;
      g.fill();
    }
    g.save();
    g.shadowColor = 'rgba(0, 30, 70, 0.5)';
    g.shadowBlur = 8;
    g.shadowOffsetY = 3;
    g.beginPath();
    g.arc(kx, cy, 17 + (hover[sl.key] ?? 0) * 3, 0, TAU);
    const knob = g.createLinearGradient(0, cy - 18, 0, cy + 18);
    knob.addColorStop(0, '#ffffff');
    knob.addColorStop(1, '#bfeff8');
    g.fillStyle = knob;
    g.fill();
    g.restore();

    g.font = `700 26px ${FONT}`;
    g.textAlign = 'right';
    g.fillStyle = '#ffffff';
    g.fillText(String(Math.round(v * 100)), x + w - 40, cy + 1);
    g.textAlign = 'left';
    g.globalAlpha = base;
  });

  // Switches, right-aligned under the slider values.
  TOGGLES.forEach((tg, i) => {
    const cy = ROW_Y(SLIDERS.length + i);
    const on = tg.on(p);
    const { w: tw, h: th, x: tx } = SWITCH;
    g.globalAlpha = base * (tg.audio && sound.muted ? 0.45 : 1);
    label(tg.label, cy);
    pill(g, tx, cy - th / 2, tw, th);
    g.fillStyle = on ? '#4fd8e8' : 'rgba(0, 30, 70, 0.45)';
    g.fill();
    g.lineWidth = 3;
    g.strokeStyle = `rgba(255,255,255,${0.5 + (hover[tg.key] ?? 0) * 0.4})`;
    g.stroke();
    const kx = tx + (on ? tw - th / 2 : th / 2);
    g.beginPath();
    g.arc(kx, cy, th / 2 - 5, 0, TAU);
    g.fillStyle = '#ffffff';
    g.fill();
    g.globalAlpha = base;
  });
}

interface MenuState {
  spin: number; gearAngle: number; alpha: number;
  /** Showing, and where it is going (they differ during a swap). */
  screen: MenuScreen; next: MenuScreen; swap: number;
  drawnSound: SoundSettings | null;
  reported?: MenuScreen;
}

export default function MainMenu({
  visible = true, blocked = false, initialScreen = 'main', onStart, onSettingsOpen, onScreenChange, sound, onSoundChange,
}: MainMenuProps) {
  const gl = useThree((state) => state.gl);
  const menu = useRef<MenuState>({ spin: 0, gearAngle: 0, alpha: 0, screen: 'main', next: 'main', swap: 1, drawnSound: null });
  const props = useRef<MainMenuProps>({ sound });
  props.current = { visible, blocked, onStart, onSettingsOpen, onScreenChange, sound, onSoundChange };

  const m = menu.current;
  const go = (screen: MenuScreen | undefined) => {
    if (!screen) return;
    if (screen === m.next) return;
    // A keyboard cursor starts over on the next screen, or going back, on the button it left by.
    if (ui.pointerKind === 'key') ui.focus(WIDGETS[screen].find((wdg) => wdg.id === OPENER[m.next]) ?? null);
    m.next = screen;
  };
  const live = () => !!props.current.visible && !props.current.blocked && m.alpha > 0.3 && m.screen === m.next;
  const setSound = (patch: Partial<SoundSettings>) => {
    const { sound: cur, onSoundChange: cb } = props.current;
    cb?.({ ...cur, ...patch });
  };

  const ui = useCanvasUI<MenuWidget>({
    priority: 2,
    // Input goes to the visible screen as soon as it is fading in (never mid swap-out).
    active: live,
    keyNav: true,
    widgets: () => WIDGETS[m.screen],
    onDrag: (wdg, p) => {
      if (!wdg.slider) return;
      const patch: Partial<SoundSettings> = {};
      patch[wdg.slider] = sliderValue(p.x);
      setSound(patch);
    },
    onStep: (wdg, dir) => {
      if (!wdg.slider) return false;
      const patch: Partial<SoundSettings> = {};
      const step = Math.round(props.current.sound[wdg.slider] * SLIDER_STEPS) + dir;
      patch[wdg.slider] = Math.min(SLIDER_STEPS, Math.max(0, step)) / SLIDER_STEPS;
      setSound(patch);
      return true;
    },
    onActivate: (wdg, s) => {
      if (wdg.toggle) {
        const patch: Partial<SoundSettings> = {};
        patch[wdg.toggle.key] = !wdg.toggle.on(props.current);
        setSound(patch);
        s.invalidate();
        return;
      }
      switch (wdg.id) {
        case 'start': go('players'); break;
        case 'settings': m.spin += Math.PI / 2; go('settings'); props.current.onSettingsOpen?.(); break;
        case 'back': go(PARENT[m.screen]); break;
        case 'one': props.current.onStart?.(1); break;
        case 'two': props.current.onStart?.(2); break;
        default:
      }
      s.invalidate();
    },
    onKey: (e, s) => {
      if (e.key === 'Escape' && !e.repeat && live() && PARENT[m.screen]) { go(PARENT[m.screen]); s.invalidate(); }
    },
    update: (dt, s) => {
      const shown = !!props.current.visible;
      // Screen change: fade the current screen out, swap, fade the next one in.
      if (m.next !== m.screen) {
        m.swap = Math.max(0, m.swap - dt * 7);
        if (m.swap === 0) m.screen = m.next;
        s.invalidate();
      } else if (m.swap < 1) {
        m.swap = Math.min(1, m.swap + dt * 6);
        s.invalidate();
      }
      m.alpha = s.ease(m.alpha, shown ? 1 : 0, shown ? 3 : 6);
      m.gearAngle = s.ease(m.gearAngle, m.spin + (s.hover.settings ?? 0) * 0.35, 8);
      if (props.current.sound !== m.drawnSound) s.invalidate();
      if (m.screen !== m.reported) { m.reported = m.screen; props.current.onScreenChange?.(m.screen); }
      const { dataset } = gl.domElement;
      dataset.menuScreen = m.screen;
      dataset.menuReady = String(shown && m.alpha > 0.5 && m.screen === m.next && m.swap > 0.95);
    },
    opacity: () => m.alpha,
    draw: (g, s) => {
      m.drawnSound = props.current.sound;
      drawTitle(g, TITLE);

      const t = m.swap;
      g.save();
      g.globalAlpha = t;
      g.translate((1 - t) * -24, 0);
      const h = s.hover;
      const press = (id: string) => s.press * (h[id] ?? 0);
      if (m.screen === 'main') {
        drawPill(g, START, { label: 'Start', icon: 'play', hover: h.start ?? 0, press: press('start') });
        drawPill(g, SETTINGS, { label: 'Settings', icon: 'gear', hover: h.settings ?? 0, press: press('settings'), angle: m.gearAngle });
      } else if (m.screen === 'players') {
        drawHeader(g, BACK, 'PLAYERS', h.back ?? 0);
        drawPill(g, ONE_PLAYER, { label: 'One Player', icon: 'solo', hover: h.one ?? 0, press: press('one') });
        drawPill(g, TWO_PLAYERS, { label: 'Two Players', icon: 'pair', hover: h.two ?? 0, press: press('two') });
      } else {
        drawHeader(g, BACK, 'SETTINGS', h.back ?? 0);
        drawSettingsPanel(g, props.current, h);
      }
      g.restore();
    },
  });

  // Reopening the menu lands on initialScreen (Back from Song Select returns to players).
  useEffect(() => {
    if (!visible) return;
    m.screen = m.next = initialScreen;
    m.swap = 1;
    ui.invalidate();
  }, [visible, initialScreen, m, ui]);

  return <FullscreenButton visible={() => !!props.current.visible && !props.current.blocked && m.screen === 'main' && m.next === 'main'} />;
}
