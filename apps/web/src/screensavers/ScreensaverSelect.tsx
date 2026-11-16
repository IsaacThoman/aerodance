import { useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import {
  FONT, TAU, drawDarkGlassPanel, drawGlassButton, drawHeader, drawShadowText, ellipsize, glassCorner, pill,
} from '../ui/draw.ts';
import type { IconDraw, Rect } from '../ui/draw.ts';
import useCanvasUI from '../ui/useCanvasUI.ts';
import type { Widget } from '../ui/useCanvasUI.ts';
import useGlassBlur, { buttonPane, panelPane } from '../ui/useGlassBlur.ts';
import { HANDOFF_WAIT, SWAP_IN, SWAP_OUT, SWAP_SLIDE, handoff } from '../ui/handoff.ts';
import { displayDesign } from '../display.ts';
import { drawArrow, fitText } from '../minigames/MinigameSelect.tsx';
import { optionsText, resolveOptions } from '../minigames/options.ts';
import type { MinigameOption } from '../minigames/types.ts';
import { drawCaption, drawCornerClock, drawLargeClock } from './clock.ts';
import { SHARED_OPTIONS, SHUFFLE_ID, clockFor, unusedShared } from './definition.ts';
import type { ClockChoice } from './definition.ts';
import type { ScreensaverHost } from './host.ts';
import { SV_PER_PAGE, screensaverLayout } from './layout.ts';
import { previewRows, saveSaverValue, saverValues, sharedValues } from './options.ts';
import type { SaverValues } from './options.ts';
import { SCREENSAVERS, screensaverById } from './registry.ts';
import { isTimeChoice, isWeatherChoice, sky } from './sky/sky.ts';
import type { ScreensaverDefinition } from './types.ts';

/**
 * Screensavers, from Experiments' list (its last button: minigames/MinigameSelect.tsx), drawn
 * in-engine over the screensaver showing (ScreensaverView, which the host shares with this):
 *
 *   list      a glass button per screensaver in a column on the left, Shuffle first, six a page;
 *             the one under the cursor (or the mouse) comes up behind the list after a moment
 *   preview   the chosen one's name and what it shows, its settings (View and Scene, then the
 *             Time, Weather and Clock they all share) and Start; where the live weather is for,
 *             and Use my location where the device can say
 *   running   full screen: nothing but the clock (the Clock setting) and a caption as each
 *             screensaver comes on. Left/Right go to the next screensaver on the list (Shuffle's
 *             next), Up/Down the next view; Escape, Enter or a click or tap goes back to the
 *             preview. The screen is kept awake, and the pointer hides while it's still.
 *
 * Keyboard and the Siri Remote as on Experiments; Escape goes back a screen (from the list to
 * Experiments, after the veil has brought the menus' background back). The canvas reports
 * data-sv-screen (list, preview, running), -sv-select-ready, -sv-list (the ids in order, Shuffle
 * first), -sv-page, -sv-chosen, -sv-options (the preview's settings: view=auto|time=live|…) and
 * -sv-option-rows, for tests and play.ts.
 *
 * <ScreensaverSelect visible host={host} start={{ id: 'koi' }} onBack={() => ...} />
 */

export type SaverScreenName = 'list' | 'preview' | 'running';

/** Opens running a screensaver full screen, with any of its settings (a ?screensaver= link). */
export interface SaverStart { id: string; values?: Readonly<Record<string, string>>; }

export interface ScreensaverSelectProps {
  visible?: boolean;
  host: ScreensaverHost;
  start?: SaverStart | null;
  onBack?: () => void;
}

/** A list button: Shuffle (saver null) or a screensaver. */
interface Entry { id: string; title: string; subtitle: string; icon: IconDraw; saver: ScreensaverDefinition | null; }
type SelectWidget = Widget & { entry?: Entry; option?: string; step?: -1 | 1 };

// Two crossing arrows.
const shuffleIcon: IconDraw = (g, cx, cy, r) => {
  const s = r * 0.42;
  g.save();
  g.lineWidth = Math.max(2.5, r * 0.09);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.beginPath();
  g.moveTo(cx - s, cy - s * 0.55);
  g.bezierCurveTo(cx - s * 0.1, cy - s * 0.55, cx + s * 0.1, cy + s * 0.55, cx + s * 0.9, cy + s * 0.55);
  g.moveTo(cx - s, cy + s * 0.55);
  g.bezierCurveTo(cx - s * 0.1, cy + s * 0.55, cx + s * 0.1, cy - s * 0.55, cx + s * 0.9, cy - s * 0.55);
  for (const y of [-0.55, 0.55]) {
    g.moveTo(cx + s * 0.6, cy + s * (y - 0.3));
    g.lineTo(cx + s * 0.95, cy + s * y);
    g.lineTo(cx + s * 0.6, cy + s * (y + 0.3));
  }
  g.stroke();
  g.restore();
};

const SHUFFLE: Entry = { id: SHUFFLE_ID, title: 'Shuffle', subtitle: 'Every screensaver in turn, to suit the time of day', icon: shuffleIcon, saver: null };
const ENTRIES: readonly Entry[] = [SHUFFLE, ...SCREENSAVERS.map((saver) => ({ id: saver.id, title: saver.title, subtitle: saver.subtitle, icon: saver.icon, saver }))];
const entryOf = (id: string | null) => ENTRIES.find((e) => e.id === id) ?? null;
const LIST_REPORT = ENTRIES.map((e) => e.id).join('|');

// The list's cursor rests this long on a button before its screensaver comes up behind.
const DWELL = 0.6;
// Full screen: the hint and pointer stay this long after the last input; a caption this long.
const HINT_S = 3.5;
const CAPTION_S = 6;
const choiceLabel = (option: MinigameOption, value: string | undefined) => (option.choices.find((c) => c.value === value) ?? option.choices[0]).label;

interface SelectState {
  alpha: number; screen: SaverScreenName; next: SaverScreenName; swap: number;
  /** Seconds left before it swaps in, arriving from Experiments (ui/handoff.ts). */
  wait: number;
  page: number;
  /** The entry on the preview (or last opened). */
  chosen: string;
  /** Each screensaver's own settings (Shuffle's under its id), and the shared ones. */
  values: Map<string, SaverValues>;
  shared: SaverValues;
  /** The list button the cursor or mouse rests on, and since when. */
  dwell: { id: string | null; since: number };
  /** Full screen: seconds since the last input; the caption's text and how long it's shown. */
  idle: number;
  caption: { title: string; line: string; age: number; seen: number };
  /** The screensaver whose own settings were last given to the host. */
  applied: string | null;
  /** What the overlay last drew and reported (redrawn and reported again when it changes). */
  drawn: string;
  /** The minute the clock last drew. */
  minute: number;
  /** Escape from the list: on the way back to Experiments (the veil coming up), taking no more input. */
  leaving: boolean;
  /** The preview's settings as text, and what they were worked out from. */
  settings: { entry: Entry | null; own: SaverValues | null; shared: SaverValues | null; text: string };
  time: number;
}

export default function ScreensaverSelect({ visible = false, host, start = null, onBack }: ScreensaverSelectProps) {
  const gl = useThree((state) => state.gl);
  const size = useThree((state) => state.size);
  const width = displayDesign(size.width, size.height).w;
  const props = useRef({ visible, onBack });
  props.current = { visible, onBack };
  const widthRef = useRef(width);
  widthRef.current = width;
  const st = useRef<SelectState>({
    alpha: 0, screen: 'list', next: 'list', swap: 1, wait: 0, page: 0, chosen: SHUFFLE_ID, values: new Map(), shared: sharedValues(),
    dwell: { id: null, since: 0 }, idle: 0, caption: { title: '', line: '', age: CAPTION_S, seen: -1 }, applied: null, drawn: '', minute: -1, time: 0,
    leaving: false, settings: { entry: null, own: null, shared: null, text: '' },
  }).current;

  const pages = Math.max(1, Math.ceil(ENTRIES.length / SV_PER_PAGE));
  const onPage = () => ENTRIES.slice(st.page * SV_PER_PAGE, (st.page + 1) * SV_PER_PAGE);
  const chosen = () => entryOf(st.chosen) ?? SHUFFLE;
  const rowsOf = (entry: Entry) => previewRows(entry.saver);
  const layoutOf = (entry: Entry | null) => screensaverLayout(widthRef.current, entry ? rowsOf(entry).length : 0);
  const valuesOf = (entry: Entry): SaverValues => {
    let v = st.values.get(entry.id);
    if (!v) { v = saverValues(entry.saver); st.values.set(entry.id, v); }
    return v;
  };
  // Every row's value: the entry's own, then the shared ones (the Clock as it applies to the entry).
  const allValues = (entry: Entry): SaverValues => ({ ...valuesOf(entry), ...st.shared, clock: clockFor(entry.saver, st.shared.clock as ClockChoice) });
  // The Clock as it applies to the screensaver on screen: the one showing, or the preview's.
  const clockNow = () => clockFor(host.shown?.saver ?? chosen().saver, host.clockChoice);

  // The shared settings into the sky and the host.
  const applyShared = () => {
    const { time, weather, clock } = st.shared;
    sky.choose(isTimeChoice(time) ? time : 'live', isWeatherChoice(weather) ? weather : 'live');
    host.clockChoice = (clock as ClockChoice) ?? 'corner';
  };
  // Shows an entry behind the menus (its scenario), with its view, or Shuffle's pick.
  const showEntry = (entry: Entry) => {
    if (!entry.saver) {
      host.shuffle.every = Number(valuesOf(entry).every || 3) * 60;
      if (!host.wanted()) host.shuffleNext(1);
      else host.chooseView('auto');
      st.applied = SHUFFLE_ID;
      return;
    }
    const v = valuesOf(entry);
    host.show(entry.saver, v.scenario ?? entry.saver.scenarios?.[0].value ?? '', v.view ?? 'auto');
    st.applied = entry.id;
  };
  // A screensaver's own Scene and View as last chosen, for Left and Right full screen.
  const ownSettings = (saver: ScreensaverDefinition) => {
    const entry = entryOf(saver.id), v = entry ? valuesOf(entry) : null;
    return { scenario: v?.scenario, view: v?.view };
  };
  // The preview's settings as text (worked out again only when they change).
  const settingsText = (entry: Entry) => {
    const own = valuesOf(entry), m = st.settings;
    if (m.entry !== entry || m.own !== own || m.shared !== st.shared) st.settings = { entry, own, shared: st.shared, text: optionsText(allValues(entry)) };
    return st.settings.text;
  };
  // A row stepped: remembered, and given to the host or the sky at once.
  const stepRow = (id: string, dir: -1 | 1) => {
    const entry = chosen(), rows = rowsOf(entry), option = rows.find((o) => o.id === id);
    if (!option) return;
    const values = allValues(entry);
    const n = option.choices.length, i = option.choices.findIndex((c) => c.value === values[id]);
    const value = option.choices[((i < 0 ? 0 : i) + dir + n) % n].value;
    saveSaverValue(entry.saver, id, value);
    if (SHARED_OPTIONS.some((o) => o.id === id)) { st.shared = { ...st.shared, [id]: value }; applyShared(); return; }
    st.values.set(entry.id, { ...valuesOf(entry), [id]: value });
    if (id === 'every') host.shuffle.every = Number(value) * 60;
    else showEntry(entry);
  };

  const live = () => props.current.visible && !st.leaving && st.alpha > 0.3 && st.screen === st.next;
  const go = (screen: SaverScreenName, key = ui.keyboard) => {
    if (screen === st.next) return;
    const from = st.next;
    st.next = screen;
    host.full = screen === 'running';
    host.shuffle.on = screen === 'running' && st.chosen === SHUFFLE_ID;
    if (screen === 'running') { st.idle = 0; st.caption.seen = -1; }
    if (from === 'running') {
      // Back from full screen on the screensaver it was showing (Left and Right may have moved on),
      // its View row as Up and Down left it.
      const showing = host.wanted()?.saver;
      if (st.chosen !== SHUFFLE_ID && showing && showing.id !== st.chosen) {
        st.chosen = showing.id;
        st.page = Math.floor(ENTRIES.findIndex((e) => e.id === showing.id) / SV_PER_PAGE);
      }
      const entry = chosen();
      if (entry.saver && entry.saver.views.length > 1 && valuesOf(entry).view !== host.viewChoice) {
        st.values.set(entry.id, { ...valuesOf(entry), view: host.viewChoice });
        saveSaverValue(entry.saver, 'view', host.viewChoice);
      }
    }
    if (!key) return;
    ui.focus(null);
    if (screen === 'list') {
      const i = onPage().findIndex((e) => e.id === st.chosen);
      if (i >= 0) ui.focus(tileWidget(onPage()[i], i));
    } else if (screen === 'preview') ui.focus({ id: 'start', rect: layoutOf(chosen()).SV_START });
  };
  const back = (key?: boolean) => {
    if (st.next === 'running') { go('preview', key); return; }
    if (st.next === 'preview') { go('list', key); return; }
    // (Nothing the list does meanwhile, its preview behind included, may call the leaving off.)
    st.leaving = true;
    host.leave(() => props.current.onBack?.());
  };
  const turnPage = (dir: -1 | 1) => {
    const page = Math.max(0, Math.min(pages - 1, st.page + dir));
    if (page === st.page) return false;
    st.page = page;
    return true;
  };
  const tileWidget = (entry: Entry, i: number): SelectWidget => {
    const rect = layoutOf(null).svTile(i);
    return { id: `saver-${entry.id}`, entry, rect, corner: glassCorner(rect.h), primary: entry.id === st.chosen };
  };
  const locating = useRef(false);

  const ui = useCanvasUI<SelectWidget>({
    priority: 2,
    active: live,
    keyNav: () => st.screen !== 'running',
    widgets: () => {
      if (st.screen === 'running') return [];
      const l = layoutOf(st.screen === 'preview' ? chosen() : null);
      if (st.screen === 'preview') {
        const entry = chosen();
        return [
          { id: 'back', circle: l.SV_BACK },
          ...rowsOf(entry).flatMap((option, i): SelectWidget[] => {
            if (unusedShared(entry.saver, option.id)) return [];
            const row = l.svOption(i), prev = l.svOptionPrev(i), next = l.svOptionNext(i);
            const left = prev.x - prev.r - 14, mid = (prev.x + next.x) / 2;
            return [
              { id: `option-${option.id}-prev`, option: option.id, step: -1, rect: { x: left, y: row.y, w: mid - left, h: row.h }, nav: false },
              { id: `option-${option.id}-next`, option: option.id, step: 1, rect: { x: mid, y: row.y, w: row.x + row.w - mid, h: row.h }, nav: false },
              { id: `option-${option.id}`, option: option.id, rect: row },
            ];
          }),
          ...(showLocate(entry) ? [{ id: 'locate', rect: l.SV_LOCATE, corner: l.SV_LOCATE.h / 2 }] : []),
          { id: 'start', rect: l.SV_START, corner: glassCorner(l.SV_START.h), primary: true },
        ];
      }
      return [
        { id: 'back', circle: l.SV_BACK },
        ...onPage().map((entry, i) => tileWidget(entry, i)),
        ...(pages > 1 ? [{ id: 'page-prev', circle: l.SV_PAGE_PREV, nav: false }, { id: 'page-next', circle: l.SV_PAGE_NEXT, nav: false }] : []),
      ];
    },
    onActivate: (wdg, s) => {
      if (wdg.entry) {
        st.chosen = wdg.entry.id;
        showEntry(wdg.entry);
        go('preview');
      } else if (wdg.option) stepRow(wdg.option, wdg.step ?? 1);
      else if (wdg.id === 'back') back();
      else if (wdg.id === 'page-prev') turnPage(-1);
      else if (wdg.id === 'page-next') turnPage(1);
      else if (wdg.id === 'start') go('running');
      else if (wdg.id === 'locate' && !locating.current) {
        // Only from this press: the browser asks the person first.
        locating.current = true;
        sky.locate().catch((error: unknown) => console.warn('[screensavers] location:', error instanceof Error ? error.message : error))
          .finally(() => { locating.current = false; s.invalidate(); });
      }
      s.invalidate();
    },
    onStep: (wdg, dir, s, repeat) => {
      if (wdg.option) {
        if (!repeat) stepRow(wdg.option, dir);
        return true;
      }
      if (!wdg.entry) return false;
      // Left/Right on the list turn the page.
      if (!turnPage(dir)) return true;
      const entries = onPage(), j = dir > 0 ? 0 : entries.length - 1;
      s.focus(tileWidget(entries[j], j));
      return true;
    },
    onKey: (e, s) => {
      if (!live() || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (st.screen === 'running') {
        st.idle = 0;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          if (!e.repeat) { host.stepSaver(e.key === 'ArrowLeft' ? -1 : 1, ownSettings); st.applied = host.wanted()?.saver.id ?? null; }
        }
        else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { if (!e.repeat) host.stepView(e.key === 'ArrowUp' ? -1 : 1); }
        else if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ' || e.key === 'Backspace') { if (!e.repeat) back(true); }
        else return;
        e.preventDefault();
        s.invalidate();
        return;
      }
      if (e.key === 'Escape' && !e.repeat) { back(true); e.preventDefault(); s.invalidate(); }
    },
    update: (dt, s) => {
      const p = props.current;
      st.time += dt;
      if (!p.visible) {
        // Gone back to Experiments: swapping out, then the overlay goes.
        if (st.alpha > 0) {
          st.swap = Math.max(0, st.swap - dt * SWAP_OUT);
          if (st.swap === 0) st.alpha = 0;
          s.invalidate();
        }
      } else if (st.next !== st.screen) {
        st.swap = Math.max(0, st.swap - dt * SWAP_OUT);
        if (st.swap === 0) st.screen = st.next;
        s.invalidate();
      } else if (st.wait > 0) {
        st.wait -= dt;
        s.invalidate();
      } else if (st.swap < 1) {
        st.swap = Math.min(1, st.swap + dt * SWAP_IN);
        s.invalidate();
      }
      if (p.visible) st.alpha = s.ease(st.alpha, 1, 3);
      if (p.visible && st.alpha > 0.9) handoff.live = true;
      host.covered = !!p.visible && st.next !== 'running';
      if (!p.visible) return;
      // The list: the button under the cursor (or the mouse) comes up behind after a moment.
      if (st.screen === 'list' && live()) {
        const under = s.keyFocus ?? Object.entries(s.hover).filter(([id, v]) => id.startsWith('saver-') && v > 0.5).map(([id]) => id)[0] ?? null;
        const id = under?.startsWith('saver-') ? under.slice(6) : null;
        if (id !== st.dwell.id) st.dwell = { id, since: st.time };
        const entry = entryOf(st.dwell.id);
        if (entry && st.time - st.dwell.since > DWELL && st.applied !== entry.id) showEntry(entry);
      }
      // Full screen: a caption as each screensaver comes on.
      if (st.screen === 'running') {
        st.idle += dt;
        if (host.announced !== st.caption.seen && host.settled() && host.shown) {
          const saver = host.shown.saver, views = saver.views, view = views.find((v) => v.value === host.view());
          const scenario = saver.scenarios?.find((c) => c.value === host.shown?.scenario);
          st.caption = { title: saver.title, line: [views.length > 1 ? view?.label : '', scenario?.label].filter(Boolean).join('  ·  '), age: 0, seen: host.announced };
        }
        if (st.caption.age < CAPTION_S) { st.caption.age += dt; s.invalidate(); }
        if (st.idle < HINT_S + 1) s.invalidate();
      }
      // The clock redraws each minute.
      const minute = Math.floor(Date.now() / 60000);
      if (minute !== st.minute) { st.minute = minute; s.invalidate(); }
      // The live weather, while a clock is drawing it (the preview's corner chip, or full screen's).
      const clock = clockNow();
      if (st.screen === 'running' ? clock === 'corner' || clock === 'large' : st.screen === 'preview' && clock === 'corner') sky.wantLive();
      const entry = chosen();
      const settings = settingsText(entry);
      const ready = live() && st.swap > 0.95;
      const key = `${st.screen}~${st.page}~${st.chosen}~${settings}~${sky.revision}~${sky.status}~${host.shown?.saver.id ?? ''}~${ready}`;
      if (key === st.drawn) return;
      st.drawn = key;
      s.invalidate();
      Object.assign(gl.domElement.dataset, {
        svScreen: st.screen,
        svSelectReady: String(ready),
        svList: LIST_REPORT,
        svPage: `${st.page + 1}/${pages}`,
        svChosen: st.screen === 'list' ? '' : st.chosen,
        svOptions: st.screen === 'preview' ? settings : '',
        svOptionRows: st.screen === 'preview' ? String(rowsOf(entry).length) : '',
      });
    },
    opacity: () => st.alpha,
    draw: (g, s) => {
      const h = s.hover;
      const press = (id: string) => s.press * (h[id] ?? 0);
      const t = st.swap;
      if (st.screen === 'running') {
        g.save();
        g.globalAlpha = t;
        drawRunning(g, s.w);
        g.restore();
        return;
      }
      g.save();
      g.globalAlpha = t;
      g.translate((1 - t) * -SWAP_SLIDE, 0);
      if (st.screen === 'list') drawList(g, h, press);
      else drawPreview(g, chosen(), h, press, s.keyFocus);
      g.restore();
      // The corner clock shows on the preview too, as it will full screen.
      if (st.screen === 'preview' && clockNow() === 'corner') drawClock(g, 'corner', t);
    },
  });

  // Use my location: where the live weather or daylight is being drawn for the time zone's place
  // (or a guess), and the device can say where it is.
  function showLocate(entry: Entry) {
    const follows = !entry.saver || entry.saver.follows?.time || entry.saver.follows?.weather;
    const liveSky = st.shared.time === 'live' || st.shared.weather === 'live';
    return !!follows && liveSky && sky.canLocate() && sky.where().source !== 'device';
  }

  function drawList(g: CanvasRenderingContext2D, h: Record<string, number>, press: (id: string) => number) {
    const l = layoutOf(null);
    drawHeader(g, l.SV_BACK, 'SCREENSAVERS', h.back ?? 0);
    onPage().forEach((entry, i) => {
      const id = `saver-${entry.id}`;
      drawGlassButton(g, l.svTile(i), { label: entry.title, icon: entry.icon, hover: h[id] ?? 0, press: press(id), chevron: false });
    });
    if (pages > 1) {
      drawArrow(g, l.SV_PAGE_PREV, 'left', h['page-prev'] ?? 0, { enabled: st.page > 0 });
      drawArrow(g, l.SV_PAGE_NEXT, 'right', h['page-next'] ?? 0, { enabled: st.page < pages - 1 });
      for (let i = 0; i < pages; i++) {
        g.beginPath();
        g.arc(l.SV_PAGE_DOTS.x + (i - (pages - 1) / 2) * 26, l.SV_PAGE_DOTS.y, i === st.page ? 7 : 5, 0, TAU);
        g.fillStyle = i === st.page ? '#ffffff' : 'rgba(255, 255, 255, 0.45)';
        g.fill();
      }
    }
  }

  function drawPreview(g: CanvasRenderingContext2D, entry: Entry, h: Record<string, number>, press: (id: string) => number, keyed: string | null) {
    const l = layoutOf(entry);
    drawHeader(g, l.SV_BACK, 'SCREENSAVERS', h.back ?? 0);
    const x = l.SV_BACK.x - 38, w = l.SV_TEXT.w;
    g.font = `800 64px ${FONT}`;
    const titleSize = Math.max(48, Math.min(64, Math.floor((64 * w) / g.measureText(entry.title).width)));
    g.font = `800 ${titleSize}px ${FONT}`;
    drawShadowText(g, ellipsize(g, entry.title, w), x, l.SV_TITLE_Y, { size: titleSize, weight: 800 });
    g.font = `700 22px ${FONT}`;
    drawShadowText(g, ellipsize(g, entry.subtitle, w), x + 2, l.SV_SUBTITLE_Y, { size: 22, weight: 700, color: '#bff4ff' });
    // The rows, as Experiments' previews draw a game's settings.
    const rows = rowsOf(entry), values = allValues(entry);
    if (l.SV_OPTIONS) drawDarkGlassPanel(g, l.SV_OPTIONS, 34);
    rows.forEach((option, i) => {
      const row = l.svOption(i), prev = l.svOptionPrev(i), next = l.svOptionNext(i);
      const off = unusedShared(entry.saver, option.id);
      g.save();
      if (off) g.globalAlpha *= 0.35;
      const id = `option-${option.id}`, cy = row.y + row.h / 2;
      const arrow = (side: 'prev' | 'next') => (keyed === id || off ? { hover: 0, press: 0 } : { hover: h[`${id}-${side}`] ?? 0, press: press(`${id}-${side}`) });
      const lit = off ? 0 : Math.max(h[id] ?? 0, h[`${id}-prev`] ?? 0, h[`${id}-next`] ?? 0);
      if (lit > 0.01) {
        pill(g, row.x, row.y, row.w, row.h);
        g.fillStyle = `rgba(255, 255, 255, ${0.1 * lit})`;
        g.fill();
      }
      const labelX = row.x + 22;
      fitText(g, option.label, labelX, cy, prev.x - prev.r - 14 - labelX, 600);
      drawArrow(g, prev, 'left', arrow('prev').hover, { press: arrow('prev').press });
      drawArrow(g, next, 'right', arrow('next').hover, { press: arrow('next').press });
      fitText(g, choiceLabel(option, values[option.id]), (prev.x + next.x) / 2, cy, next.x - prev.x - prev.r - next.r - 16, 700, 'center');
      g.restore();
    });
    // What the sky follows: the place, and the live weather's state.
    const note = skyNote(entry);
    if (note) drawShadowText(g, ellipsize(g, note, w), x + 2, l.SV_NOTE_Y, { size: 20, weight: 700, color: '#dff6ff' });
    if (showLocate(entry)) {
      const r = l.SV_LOCATE, lit = h.locate ?? 0;
      g.save();
      pill(g, r.x, r.y, r.w, r.h);
      g.fillStyle = `rgba(0, 40, 90, ${0.35 + 0.15 * lit})`;
      g.fill();
      g.lineWidth = 2;
      g.strokeStyle = `rgba(255,255,255,${0.55 + 0.4 * lit})`;
      g.stroke();
      g.restore();
      fitText(g, locating.current ? 'Asking…' : 'Use my location', r.x + r.w / 2, r.y + r.h / 2, r.w - 30, 700, 'center');
    }
    drawGlassButton(g, l.SV_START, { label: 'Start', sub: 'Full screen', icon: 'play', hover: h.start ?? 0, press: press('start'), chevron: false });
  }

  // The line under the rows: what the time of day and the weather follow.
  function skyNote(entry: Entry): string {
    const saver = entry.saver;
    const follows = !saver || saver.follows?.time || saver.follows?.weather;
    const place = sky.where();
    const where = place.source === 'device' ? 'your location' : place.name ? `${place.name}, by your time zone` : 'your time zone';
    const liveWeather = st.shared.weather === 'live' && (!saver || saver.follows?.weather);
    const liveTime = st.shared.time === 'live' && (!saver || saver.follows?.time);
    const clock = clockFor(saver, host.clockChoice);
    if (!follows) return (clock === 'corner' || clock === 'large') && sky.status === 'live' ? `The clock's weather is for ${where}` : '';
    if (liveWeather && sky.status === 'unavailable') return `Live weather is unavailable right now${liveTime ? `: daylight for ${where}` : ''}`;
    if (liveWeather && liveTime) return `Daylight and weather for ${where}`;
    if (liveWeather) return `Weather for ${where}`;
    if (liveTime) return `Daylight for ${where}`;
    return '';
  }

  function drawClock(g: CanvasRenderingContext2D, choice: ClockChoice, alpha: number) {
    // (In scene: the screensaver shows the time itself.)
    if (choice === 'off' || choice === 'scene') return;
    const l = layoutOf(null), now = new Date(), state = sky.state();
    const weather = sky.liveWeather();
    g.save();
    g.globalAlpha *= alpha;
    if (choice === 'large') drawLargeClock(g, now, weather, state.live.time ? state.daylight < 0.3 : now.getHours() < 6 || now.getHours() >= 19, l.SV_LARGE_CLOCK.x, l.SV_LARGE_CLOCK.y);
    else drawCornerClock(g, now, weather, now.getHours() < 6 || now.getHours() >= 19, l.SV_CLOCK_RIGHT, l.SV_CLOCK_BOTTOM);
    g.restore();
  }

  function drawRunning(g: CanvasRenderingContext2D, designW: number) {
    const l = layoutOf(null);
    drawClock(g, clockNow(), 1);
    // A caption as a screensaver comes on (over the large clock's place, so not with it), fading in and out.
    const c = st.caption, a = Math.min(1, c.age / 0.8, (CAPTION_S - c.age) / 1.2);
    if (clockNow() !== 'large') drawCaption(g, c.title, c.line, l.SV_CAPTION.x, l.SV_CAPTION.y, Math.max(0, a));
    // The keys, for a moment after any input.
    const hint = Math.max(0, Math.min(1, (HINT_S - st.idle) / 0.6));
    if (hint > 0.005) {
      const text = 'Esc or click: back   ·   ← →  screensavers   ·   ↑ ↓  views';
      g.save();
      g.globalAlpha *= hint;
      g.font = `700 20px ${FONT}`;
      const w = g.measureText(text).width + 48, r: Rect = { x: (designW - w) / 2, y: 36, w, h: 48 };
      drawDarkGlassPanel(g, r, 24);
      drawShadowText(g, text, r.x + r.w / 2, r.y + r.h / 2 + 1, { size: 20, weight: 700, align: 'center' });
      g.restore();
    }
  }

  // Frosted glass in the buttons and the preview's panel.
  useGlassBlur(() => {
    if (st.screen === 'running') return { panes: [], alpha: 0 };
    const entry = chosen(), l = layoutOf(st.screen === 'preview' ? entry : null);
    const panes = st.screen === 'list'
      ? onPage().map((e, i) => buttonPane(ui, `saver-${e.id}`, l.svTile(i)))
      : [...(l.SV_OPTIONS ? [panelPane(l.SV_OPTIONS)] : []), buttonPane(ui, 'start', l.SV_START)];
    return { panes, alpha: st.alpha * st.swap, offsetX: (1 - st.swap) * -SWAP_SLIDE };
  });

  // Full screen: a click or tap goes back, the pointer shows and hides with movement, and the
  // screen is kept awake.
  useEffect(() => {
    const el = gl.domElement;
    let lock: { release(): Promise<void> } | null = null;
    let wanted = false;
    const wake = async () => {
      if (!wanted || lock || document.visibilityState !== 'visible') return;
      try {
        const wl = (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void>; addEventListener(t: string, f: () => void): void }> } }).wakeLock;
        const sentinel = await wl?.request('screen');
        if (!sentinel) return;
        if (!wanted) { void sentinel.release(); return; }
        lock = sentinel;
        sentinel.addEventListener('release', () => { if (lock === sentinel) lock = null; });
      } catch { /* not allowed or not supported */ }
    };
    const running = () => props.current.visible && st.screen === 'running' && st.next === 'running';
    const onMove = () => { if (running()) { st.idle = 0; ui.invalidate(); } };
    const onUp = (e: PointerEvent) => { if (running() && st.swap > 0.95 && e.button === 0) { back(false); ui.invalidate(); } };
    const onVisible = () => { void wake(); };
    let raf = 0;
    const tick = () => {
      const on = running();
      if (on !== wanted) {
        wanted = on;
        if (on) void wake();
        else if (lock) { void lock.release(); lock = null; }
      }
      // The pointer hides while it's still, full screen.
      const hide = on && st.idle > HINT_S;
      if (hide !== (el.style.cursor === 'none')) el.style.cursor = hide ? 'none' : '';
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      document.removeEventListener('visibilitychange', onVisible);
      if (lock) void lock.release();
      if (el.style.cursor === 'none') el.style.cursor = '';
    };
  // (st, host and ui are the same objects for the component's life.)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl]);

  // Opening: on the list (the last screensaver chosen comes up behind it), or straight into one
  // running full screen (a ?screensaver= link).
  useEffect(() => {
    if (!visible) return;
    st.leaving = false;
    st.shared = sharedValues();
    const begin = start ? screensaverById(start.id) ?? (start.id === SHUFFLE_ID ? null : undefined) : undefined;
    if (start && begin !== undefined) {
      const entry = begin ? entryOf(begin.id)! : SHUFFLE;
      st.chosen = entry.id;
      // The link's settings for this visit only (they aren't saved).
      if (start.values) {
        const own = resolveOptions({ options: rowsOf(entry).filter((o) => !SHARED_OPTIONS.includes(o)) }, { ...valuesOf(entry), ...start.values });
        st.values.set(entry.id, own);
        st.shared = resolveOptions({ options: SHARED_OPTIONS }, { ...st.shared, ...start.values });
      }
      st.page = Math.floor(ENTRIES.indexOf(entry) / SV_PER_PAGE);
      applyShared();
      showEntry(entry);
      st.screen = st.next = 'running';
      host.full = true;
      host.shuffle.on = entry.id === SHUFFLE_ID;
    } else {
      applyShared();
      st.screen = st.next = 'list';
      const entry = chosen();
      st.page = Math.floor(ENTRIES.indexOf(entry) / SV_PER_PAGE);
      showEntry(entry);
    }
    // In once Experiments has swapped out (a link straight to one running has nothing to wait for).
    const arriving = handoff.live && st.screen === 'list';
    st.swap = arriving ? 0 : 1;
    st.wait = arriving ? HANDOFF_WAIT : 0;
    if (arriving) st.alpha = 1;
    st.dwell = { id: null, since: 0 };
    if (ui.keyboard && st.screen === 'list') {
      const i = onPage().findIndex((e) => e.id === st.chosen);
      ui.focus(i >= 0 ? tileWidget(onPage()[i], i) : null);
    }
    ui.invalidate();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, start, st, ui]);

  // Gone: the canvas stops reporting the screens.
  useEffect(() => {
    if (visible) return;
    const { dataset } = gl.domElement;
    for (const k of ['svScreen', 'svSelectReady', 'svList', 'svPage', 'svChosen', 'svOptions', 'svOptionRows']) delete dataset[k];
    st.drawn = '';
  }, [visible, gl, st]);

  return null;
}
