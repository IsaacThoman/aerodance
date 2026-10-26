import { useEffect, useMemo, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import { FONT, GLASS_STYLES, NAVY, TAU, drawCaps, drawDarkGlassPanel, drawGlassButton, drawGlassCircle, drawHeader, drawTitle, glassCorner, pill } from '../ui/draw.ts';
import type { Circle, GlassStyle, Point, Rect } from '../ui/draw.ts';
import useCanvasUI from '../ui/useCanvasUI.ts';
import type { CanvasUI } from '../ui/useCanvasUI.ts';
import useGlassBlur, { buttonPane, panelPane } from '../ui/useGlassBlur.ts';
import { MAX_PLAYERS } from '../../../../packages/pose/choreography.ts';
import type { PlayerCount } from '../../../../packages/pose/choreography.ts';
import type { SoundSettings } from './soundSettings.ts';
import type { AspectSetting, GraphicsSettings, StatsSetting } from './graphicsSettings.ts';
import AirPlayButton from './AirPlayButton.tsx';
import useFullscreen from './useFullscreen.ts';
import type { Fullscreen } from './useFullscreen.ts';
// The title's height is the same in either display mode (menuLayout only moves and sizes it).
import { PLAYERS_TITLE_Y, TITLE as HOME_TITLE, menuLayout } from './layout.ts';
import { displayDesign } from '../display.ts';
import { HAS_SONGS, createSongsPanel } from './songsPanel.ts';
import type { SongsPanel, SongsWidget } from './songsPanel.ts';
import { createTransferPanel } from './transferPanel.ts';
import type { TransferPanel, TransferWidget } from './transferPanel.ts';

/**
 * Title menu drawn in-engine (see ui/useCanvasUI.ts), laid out in the selected display mode and
 * drawn after the world (useFrame priority 2).
 *
 * Screens: main (Start, Settings), players (a 1-4 dial, shown by that many dancers on the
 * puck in menu/MenuDancers.tsx; Let's dance opens Song Select: game/SongSelect.tsx), settings
 * (a Sound panel: Master / Music / Effects volume, Menu music and Mute all, which
 * audio/mixer.ts applies; a Graphics panel: Aspect ratio Auto / 4:3 / 16:9, and Stats Off /
 * Basic / Full for the performance overlay (stats/StatsOverlay.tsx), which App.tsx applies, then
 * a Fullscreen switch where the page can go fullscreen (menu/useFullscreen.ts; it isn't there in
 * iPhone Safari, the tvOS app, the iPhone/iPad app or iframes without allowfullscreen);
 * where the browser or app can save songs, a Songs panel beside them: the songs imported into it,
 * Import song and Transfer songs, menu/songsPanel.ts), and transfer (opened from Transfer songs:
 * sending songs to and from another device, menu/transferPanel.ts; transferCode opens it joining
 * that code, from a transfer QR code's link).
 * Start, Settings and Let's dance are glass buttons (ui/useGlassBlur.ts blurs the world inside
 * them) in the look ?buttons=1..6 picks; Settings' panels are the dark style's glass.
 * The main screen also shows the AirPlay bubble in the corner in the iPhone/iPad app. The title
 * rises while the players screen is up and fades out while settings is.
 *
 * Input comes from the mouse/touch on the canvas or the keyboard (arrows, Enter, Escape;
 * Left/Right step the volume sliders). On the players screen Left/Right only move the cursor:
 * the count changes by pressing minus or plus.
 * The dial is controlled (playerCount / onPlayerCountChange); Start always turns it back to 2
 * (Back from Song Select keeps the count picked last). onScreenChange reports the
 * screen showing. The canvas reports data-menu-screen / data-menu-ready / data-menu-players
 * (and the Songs and Transfer panels', songsPanel.ts and transferPanel.ts) for tests.
 *
 * <MainMenu visible initialScreen="main" playerCount={n} onPlayerCountChange={setN}
 *   onStart={(playerCount) => ...} onScreenChange={setShown} sound={sound} onSoundChange={setSound}
 *   graphics={graphics} onGraphicsChange={setGraphics} />
 */

export type MenuScreen = 'main' | 'players' | 'settings' | 'transfer';
export interface MainMenuProps {
  visible?: boolean;
  /** Where the menu opens when it is shown. */
  initialScreen?: MenuScreen;
  /** A transfer code to join when the transfer screen first opens (a transfer QR code's link). */
  transferCode?: string;
  /** The players dial's count. */
  playerCount?: PlayerCount;
  onPlayerCountChange?: (count: PlayerCount) => void;
  onStart?: (playerCount: PlayerCount) => void;
  onSettingsOpen?: () => void;
  onScreenChange?: (screen: MenuScreen) => void;
  sound: SoundSettings;
  onSoundChange?: (sound: SoundSettings) => void;
  graphics: GraphicsSettings;
  onGraphicsChange?: (graphics: GraphicsSettings) => void;
}
type SliderKey = 'master' | 'music' | 'sfx';
type ToggleKey = 'menuMusic' | 'muted';
interface Toggle { key: ToggleKey; label: string; audio?: boolean; on: (p: MainMenuProps) => boolean; }
type MenuWidget = SongsWidget & TransferWidget & { slider?: SliderKey; toggle?: Toggle; aspect?: AspectSetting; stats?: StatsSetting; fullscreen?: boolean };

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
const ASPECTS: readonly { value: AspectSetting; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'standard', label: '4:3' },
  { value: 'widescreen', label: '16:9' },
];
const STATS: readonly { value: StatsSetting; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'basic', label: 'Basic' },
  { value: 'full', label: 'Full' },
];
// Where back / Escape leads from each submenu, and the button there that opens it.
const PARENT: Partial<Record<MenuScreen, MenuScreen>> = { players: 'main', settings: 'main', transfer: 'settings' };
const OPENER: Partial<Record<MenuScreen, string>> = { players: 'start', settings: 'settings', transfer: 'song-transfer' };

// ?buttons=1..6 picks the look of Start, Settings and Let's dance (GLASS_STYLES: the mockups in
// order, then dark); dark, the players dial's blue glass, by default.
const params = typeof location === 'undefined' ? null : new URLSearchParams(location.search);
const BUTTONS: GlassStyle = GLASS_STYLES[Number(params?.get('buttons')) - 1] ?? 'dark';

// Left/Right move a slider a twentieth (5) at a time.
const SLIDER_STEPS = 20;
const clampCount = (n: number) => Math.min(MAX_PLAYERS, Math.max(1, n)) as PlayerCount;
// The dial's count each time Start opens the players screen.
export const DEFAULT_PLAYERS: PlayerCount = 2;

// The dial's count: heavy white type with the title's embossed shadow and cool glossy face.
function drawCount(g: CanvasRenderingContext2D, n: number, x: number, cy: number, size = 150) {
  const y = cy + size * 0.36;
  g.save();
  g.font = `800 ${size}px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  g.shadowColor = 'rgba(0, 34, 84, 0.75)';
  g.shadowBlur = 4;
  g.shadowOffsetY = 7;
  g.fillStyle = '#ffffff';
  g.fillText(String(n), x, y);
  g.shadowColor = 'transparent';
  const face = g.createLinearGradient(0, y - size * 0.75, 0, y);
  face.addColorStop(0, '#ffffff');
  face.addColorStop(0.55, '#ffffff');
  face.addColorStop(1, '#d5f3ff');
  g.fillStyle = face;
  g.fillText(String(n), x, y);
  g.restore();
}

// A glass dial button with a white minus or plus, dimmed at the end of the range.
function drawStep(g: CanvasRenderingContext2D, c: Circle, plus: boolean, hover: number, press: number, enabled: boolean) {
  g.save();
  if (!enabled) { g.globalAlpha *= 0.4; hover = 0; press = 0; }
  const y = c.y + press * 3;
  drawGlassCircle(g, { ...c, y }, hover);
  const a = c.r * 0.38;
  g.beginPath();
  g.moveTo(c.x - a, y);
  g.lineTo(c.x + a, y);
  if (plus) { g.moveTo(c.x, y - a); g.lineTo(c.x, y + a); }
  g.lineCap = 'round';
  g.lineWidth = 6;
  g.strokeStyle = '#ffffff';
  g.stroke();
  g.restore();
}

// A switch, right-aligned in its row and filled when on.
function drawSwitch(g: CanvasRenderingContext2D, { w: tw, h: th, x: tx }: { w: number; h: number; x: number }, cy: number, on: boolean, hover: number) {
  pill(g, tx, cy - th / 2, tw, th);
  g.fillStyle = on ? '#4fd8e8' : 'rgba(0, 30, 70, 0.45)';
  g.fill();
  g.lineWidth = 3;
  g.strokeStyle = `rgba(255,255,255,${0.5 + hover * 0.4})`;
  g.stroke();
  const kx = tx + (on ? tw - th / 2 : th / 2);
  g.beginPath();
  g.arc(kx, cy, th / 2 - 5, 0, TAU);
  g.fillStyle = '#ffffff';
  g.fill();
}

function drawSettingsPanel(g: CanvasRenderingContext2D, p: MainMenuProps, fs: Fullscreen, hover: Record<string, number>,
  layout: ReturnType<typeof menuLayout>) {
  const { SOUND, GRAPHICS, TRACK, ROW_Y, SWITCH, ASPECT, ASPECT_ROW_Y, STATS: STATS_RECT, STATS_ROW_Y, FULLSCREEN } = layout;
  const { sound } = p;
  const { x, w } = SOUND;
  const base = g.globalAlpha;
  drawDarkGlassPanel(g, SOUND, 34);
  drawCaps(g, 'SOUND', x + 40, SOUND.y + 44, { size: 22 });

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
    g.globalAlpha = base * (tg.audio && sound.muted ? 0.45 : 1);
    label(tg.label, cy);
    drawSwitch(g, SWITCH, cy, tg.on(p), hover[tg.key] ?? 0);
    g.globalAlpha = base;
  });

  drawDarkGlassPanel(g, GRAPHICS, 34);
  drawCaps(g, 'GRAPHICS', x + 40, GRAPHICS.y + 44, { size: 22 });
  label('Aspect ratio', ASPECT_ROW_Y);
  drawSegments(g, ASPECTS, ASPECT, p.graphics.aspect, (v) => hover[`aspect-${v}`] ?? 0);
  label('Stats', STATS_ROW_Y);
  drawSegments(g, STATS, STATS_RECT, p.graphics.stats, (v) => hover[`stats-${v}`] ?? 0);
  if (FULLSCREEN) {
    const cy = FULLSCREEN.y + FULLSCREEN.h / 2;
    label('Fullscreen', cy);
    drawSwitch(g, SWITCH, cy, fs.active, hover.fullscreen ?? 0);
    // Browsers only go fullscreen from the user's own input on that display: say so beside the
    // panel's heading.
    if (fs.error) {
      g.font = `600 18px ${FONT}`;
      g.textAlign = 'right';
      g.fillStyle = 'rgba(255,255,255,0.8)';
      g.fillText(fs.error, x + w - 40, GRAPHICS.y + 44);
      g.textAlign = 'left';
    }
  }
}

// A segmented switch: the chosen option filled like a switch that's on.
function drawSegments<V extends string>(g: CanvasRenderingContext2D, options: readonly { value: V; label: string }[], rect: (i: number) => Rect,
  value: V, hover: (value: V) => number) {
  const first = rect(0), last = rect(options.length - 1);
  pill(g, first.x - 4, first.y - 4, last.x + last.w - first.x + 8, first.h + 8);
  g.fillStyle = 'rgba(0, 30, 70, 0.45)';
  g.fill();
  options.forEach((a, i) => {
    const r = rect(i);
    const on = value === a.value;
    const hv = hover(a.value);
    pill(g, r.x, r.y, r.w, r.h);
    if (on) {
      const fill = g.createLinearGradient(0, r.y, 0, r.y + r.h);
      fill.addColorStop(0, '#b8fff0');
      fill.addColorStop(1, '#4fd8e8');
      g.fillStyle = fill;
      g.fill();
    }
    if (on || hv > 0.01) {
      g.lineWidth = 3;
      g.strokeStyle = `rgba(255,255,255,${on ? 0.5 + hv * 0.4 : hv * 0.6})`;
      g.stroke();
    }
    g.font = `700 24px ${FONT}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = on ? NAVY : '#ffffff';
    g.fillText(a.label, r.x + r.w / 2, r.y + r.h / 2 + 1);
    g.textAlign = 'left';
  });
}

interface MenuState {
  spin: number; gearAngle: number; alpha: number;
  /** Showing, and where it is going (they differ during a swap). */
  screen: MenuScreen; next: MenuScreen; swap: number;
  drawnSound: SoundSettings | null;
  drawnGraphics: GraphicsSettings | null;
  drawnFullscreen: Fullscreen | null;
  drawnCount: PlayerCount | null;
  drawnSongs: string;
  /** The title's baseline, easing up on the players screen. */
  titleY: number;
  /** The title's opacity, fading out on the settings and transfer screens. */
  titleAlpha: number;
  /** The widget the keyboard cursor goes to once the screen is in (going back). */
  refocus: string | null;
  reported?: MenuScreen;
}

export default function MainMenu({
  visible = true, initialScreen = 'main', transferCode = '', playerCount = 1, onPlayerCountChange, onStart, onSettingsOpen, onScreenChange, sound, onSoundChange, graphics, onGraphicsChange,
}: MainMenuProps) {
  const gl = useThree((state) => state.gl);
  const size = useThree((state) => state.size);
  const fullscreen = useFullscreen();
  const layout = menuLayout(displayDesign(size.width, size.height).w, fullscreen.supported);
  const { ASPECT, BACK, COUNT_X, FULLSCREEN, MINUS, PLAYERS_BACK, PLAYERS_GO, PLUS, SETTINGS, SOUND, START, TITLE, TRACK, ROW_Y } = layout;
  const sliderValue = (x: number) => Math.min(1, Math.max(0, (x - TRACK.x0) / (TRACK.x1 - TRACK.x0)));
  const WIDGETS: Record<MenuScreen, MenuWidget[]> = {
    main: [
      { id: 'start', rect: START, corner: glassCorner(START.h), primary: true },
      { id: 'settings', rect: SETTINGS, corner: glassCorner(SETTINGS.h) },
    ],
    players: [
      { id: 'back', circle: PLAYERS_BACK },
      { id: 'minus', circle: MINUS },
      { id: 'plus', circle: PLUS },
      { id: 'go', rect: PLAYERS_GO, corner: glassCorner(PLAYERS_GO.h), primary: true },
    ],
    transfer: [{ id: 'back', circle: BACK }],
    settings: [
      { id: 'back', circle: BACK },
      ...SLIDERS.map((sl, i) => ({ id: sl.key, slider: sl.key, drag: true, rect: { x: TRACK.x0 - 24, y: ROW_Y(i) - 25, w: TRACK.x1 - TRACK.x0 + 48, h: 50 } })),
      ...TOGGLES.map((tg, i) => ({ id: tg.key, toggle: tg, rect: { x: SOUND.x + 16, y: ROW_Y(SLIDERS.length + i) - 24, w: SOUND.w - 32, h: 48 } })),
      ...ASPECTS.map((a, i) => ({ id: `aspect-${a.value}`, aspect: a.value, rect: ASPECT(i) })),
      ...STATS.map((a, i) => ({ id: `stats-${a.value}`, stats: a.value, rect: layout.STATS(i) })),
      ...(FULLSCREEN ? [{ id: 'fullscreen', fullscreen: true, rect: FULLSCREEN }] : []),
    ],
  };
  const menu = useRef<MenuState>({
    spin: 0, gearAngle: 0, alpha: 0, screen: 'main', next: 'main', swap: 1, drawnSound: null, drawnGraphics: null, drawnFullscreen: null, drawnCount: null, drawnSongs: '', titleY: TITLE.y, titleAlpha: 1, refocus: null,
  });
  const props = useRef<MainMenuProps>({ sound, graphics });
  props.current = { visible, playerCount, onPlayerCountChange, onStart, onSettingsOpen, onScreenChange, sound, onSoundChange, graphics, onGraphicsChange };
  const count = () => props.current.playerCount ?? 1;
  const fullscreenRef = useRef(fullscreen);
  fullscreenRef.current = fullscreen;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const m = menu.current;
  // A keyboard cursor starts over on the next screen (on the players screen, on Let's dance), or
  // going back (also by Escape), on the button it left by once that screen is in.
  const go = (screen: MenuScreen | undefined, key = ui.keyboard) => {
    if (!screen) return;
    if (screen === m.next) return;
    if (key) {
      ui.focus(null);
      m.refocus = screen === 'players' ? 'go' : OPENER[m.next] ?? null;
    }
    m.next = screen;
  };
  const live = () => !!props.current.visible && m.alpha > 0.3 && m.screen === m.next;
  // ui is assigned below, before the panel first asks for it.
  const songs = useMemo<SongsPanel>(() => createSongsPanel({
    layout: () => layoutRef.current,
    ui: (): CanvasUI<SongsWidget> => ui,
    showing: () => !!props.current.visible && m.next === 'settings',
    toDesign: (x, y): Point => {
      const rect = gl.domElement.getBoundingClientRect();
      return { x: ((x - rect.left) / rect.width) * ui.w, y: ((y - rect.top) / rect.height) * ui.h + ui.scroll };
    },
    onTransfer: () => go('transfer'),
  // One panel for the menu's life: ui is the same object every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [m]);
  const transfer = useMemo<TransferPanel>(() => createTransferPanel({
    layout: () => layoutRef.current,
    ui: (): CanvasUI<TransferWidget> => ui,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [m]);
  // The code to join, used by the first visit to the transfer screen only.
  const pendingCode = useRef(transferCode);
  const setCount = (n: number) => {
    const next = clampCount(n);
    if (next !== count()) props.current.onPlayerCountChange?.(next);
  };
  const setSound = (patch: Partial<SoundSettings>) => {
    const { sound: cur, onSoundChange: cb } = props.current;
    cb?.({ ...cur, ...patch });
  };

  const ui = useCanvasUI<MenuWidget>({
    priority: 2,
    // Input goes to the visible screen as soon as it is fading in (never mid swap-out).
    active: live,
    keyNav: true,
    widgets: () => (m.screen === 'settings' ? [...WIDGETS.settings, ...songs.widgets()] : m.screen === 'transfer' ? [...WIDGETS.transfer, ...transfer.widgets()] : WIDGETS[m.screen]),
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
      if (m.screen === 'transfer' ? transfer.activate(wdg) : songs.activate(wdg)) { s.invalidate(); return; }
      if (wdg.toggle) {
        const patch: Partial<SoundSettings> = {};
        patch[wdg.toggle.key] = !wdg.toggle.on(props.current);
        setSound(patch);
        s.invalidate();
        return;
      }
      if (wdg.aspect) {
        const { graphics: cur, onGraphicsChange: cb } = props.current;
        if (cur.aspect !== wdg.aspect) cb?.({ ...cur, aspect: wdg.aspect });
        s.invalidate();
        return;
      }
      if (wdg.stats) {
        const { graphics: cur, onGraphicsChange: cb } = props.current;
        if (cur.stats !== wdg.stats) cb?.({ ...cur, stats: wdg.stats });
        s.invalidate();
        return;
      }
      // Straight from the input handler: browsers only enter fullscreen from the user's input.
      if (wdg.fullscreen) {
        fullscreenRef.current.toggle();
        s.invalidate();
        return;
      }
      switch (wdg.id) {
        case 'start': setCount(DEFAULT_PLAYERS); go('players'); break;
        case 'settings': m.spin += Math.PI / 2; go('settings'); props.current.onSettingsOpen?.(); break;
        case 'back': go(PARENT[m.screen]); break;
        case 'minus': setCount(count() - 1); break;
        case 'plus': setCount(count() + 1); break;
        case 'go': props.current.onStart?.(count()); break;
        default:
      }
      s.invalidate();
    },
    onKey: (e, s) => {
      if (live() && m.screen === 'transfer' && transfer.keyDown(e)) { e.preventDefault(); s.invalidate(); return; }
      if (e.key === 'Escape' && !e.repeat && live() && PARENT[m.screen]) { go(PARENT[m.screen], true); s.invalidate(); }
    },
    update: (dt, s) => {
      const shown = !!props.current.visible;
      // Screen change: fade the current screen out, swap, fade the next one in.
      if (m.next !== m.screen) {
        m.swap = Math.max(0, m.swap - dt * 7);
        if (m.swap === 0) {
          m.screen = m.next;
          // A mouse left resting where the last screen was pressed hovers nothing on the new one
          // until it moves (Start sits over the dial's minus), so Enter goes to its primary.
          if (s.pointerKind !== 'key') s.pointer = null;
        }
        s.invalidate();
      } else if (m.swap < 1) {
        m.swap = Math.min(1, m.swap + dt * 6);
        s.invalidate();
      }
      m.alpha = s.ease(m.alpha, shown ? 1 : 0, shown ? 3 : 6);
      if (m.refocus && live()) {
        s.focus(WIDGETS[m.screen].find((wdg) => wdg.id === m.refocus) ?? null);
        m.refocus = null;
      }
      m.gearAngle = s.ease(m.gearAngle, m.spin + (s.hover.settings ?? 0) * 0.35, 8);
      m.titleY = s.ease(m.titleY, m.next === 'players' ? PLAYERS_TITLE_Y : TITLE.y, 7);
      m.titleAlpha = s.ease(m.titleAlpha, m.next === 'settings' || m.next === 'transfer' ? 0 : 1, 8);
      const { sound: drawSound, graphics: drawGraphics } = props.current;
      if (drawSound !== m.drawnSound || drawGraphics !== m.drawnGraphics || fullscreenRef.current !== m.drawnFullscreen || count() !== m.drawnCount) s.invalidate();
      if (m.screen !== m.reported) {
        if (m.reported === 'settings') songs.close();
        if (m.reported === 'transfer') transfer.close();
        if (m.screen === 'settings') songs.open();
        if (m.screen === 'transfer') { transfer.open(pendingCode.current); pendingCode.current = ''; }
        m.reported = m.screen;
        props.current.onScreenChange?.(m.screen);
      }
      const songsKey = `${songs.key()}|${transfer.key()}`;
      if (songsKey !== m.drawnSongs || songs.busy() || transfer.busy()) { m.drawnSongs = songsKey; s.invalidate(); }
      const { dataset } = gl.domElement;
      Object.assign(dataset, songs.report());
      // The transfer screen's, gone while it isn't showing.
      for (const [key, value] of Object.entries(transfer.report())) { if (value) dataset[key] = value; else delete dataset[key]; }
      dataset.menuScreen = m.screen;
      dataset.menuPlayers = String(count());
      dataset.menuReady = String(shown && m.alpha > 0.5 && m.screen === m.next && m.swap > 0.95);
    },
    opacity: () => m.alpha,
    draw: (g, s) => {
      m.drawnSound = props.current.sound;
      m.drawnGraphics = props.current.graphics;
      m.drawnFullscreen = fullscreenRef.current;
      m.drawnCount = count();
      if (m.titleAlpha > 0) {
        g.save();
        g.globalAlpha = m.titleAlpha;
        drawTitle(g, { ...TITLE, y: m.titleY });
        g.restore();
      }

      const t = m.swap;
      g.save();
      g.globalAlpha = t;
      g.translate((1 - t) * -24, 0);
      const h = s.hover;
      const press = (id: string) => s.press * (h[id] ?? 0);
      if (m.screen === 'main') {
        // No chevrons on the title menu's buttons (Let's dance's too).
        drawGlassButton(g, START, { label: 'Start', icon: 'play', hover: h.start ?? 0, press: press('start'), style: BUTTONS, chevron: false });
        drawGlassButton(g, SETTINGS, { label: 'Settings', icon: 'gear', hover: h.settings ?? 0, press: press('settings'), angle: m.gearAngle, style: BUTTONS, chevron: false });
      } else if (m.screen === 'players') {
        const n = count();
        drawHeader(g, PLAYERS_BACK, 'PLAYERS', h.back ?? 0);
        drawStep(g, MINUS, false, h.minus ?? 0, press('minus'), n > 1);
        drawCount(g, n, COUNT_X, MINUS.y);
        drawStep(g, PLUS, true, h.plus ?? 0, press('plus'), n < MAX_PLAYERS);
        drawGlassButton(g, PLAYERS_GO, { label: "Let's dance", icon: 'play', hover: h.go ?? 0, press: press('go'), style: BUTTONS, chevron: false });
      } else if (m.screen === 'transfer') {
        drawHeader(g, BACK, 'TRANSFER SONGS', h.back ?? 0);
        transfer.draw(g, h, press, s.time);
      } else {
        drawHeader(g, BACK, 'SETTINGS', h.back ?? 0);
        drawSettingsPanel(g, props.current, fullscreenRef.current, h, layout);
        songs.draw(g, h, press, s.time);
      }
      g.restore();
    },
  });

  // Frosted glass: the world blurred inside the glass buttons and Settings' panels only,
  // lifting, fading and sliding with them (drawn just before the overlay).
  useGlassBlur(() => {
    const panes = m.screen === 'main' ? [buttonPane(ui, 'start', START), buttonPane(ui, 'settings', SETTINGS)]
      : m.screen === 'players' ? [buttonPane(ui, 'go', PLAYERS_GO)]
        : m.screen === 'transfer' ? [panelPane(layout.TRANSFER_CONNECT), panelPane(layout.SONGS)]
          : [panelPane(SOUND), panelPane(layout.GRAPHICS), ...(HAS_SONGS ? [panelPane(layout.SONGS)] : [])];
    return { panes, alpha: m.alpha * m.swap, offsetX: (1 - m.swap) * -24 };
  });

  // Reopening the menu lands on initialScreen (Back from Song Select returns to players), with
  // a keyboard cursor on Let's dance.
  useEffect(() => {
    if (!visible) return;
    m.screen = m.next = initialScreen;
    m.swap = 1;
    m.titleY = initialScreen === 'players' ? PLAYERS_TITLE_Y : HOME_TITLE.y;
    m.titleAlpha = initialScreen === 'settings' || initialScreen === 'transfer' ? 0 : 1;
    m.refocus = ui.keyboard && initialScreen === 'players' ? 'go' : null;
    ui.invalidate();
  }, [visible, initialScreen, m, ui]);

  useEffect(() => () => songs.dispose(), [songs]);
  useEffect(() => () => transfer.dispose(), [transfer]);

  const onMain = () => !!props.current.visible && m.screen === 'main' && m.next === 'main';
  return <AirPlayButton visible={onMain} />;
}
