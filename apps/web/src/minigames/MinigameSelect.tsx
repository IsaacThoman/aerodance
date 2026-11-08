import { useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import {
  FONT, TAU, drawCaps, drawDarkGlassPanel, drawDialCount, drawDialStep, drawGlassButton, drawGlassCircle, drawHeader, drawShadowText,
  ellipsize, glassCorner, ICONS, pill, roundRect,
} from '../ui/draw.ts';
import type { Circle, Rect } from '../ui/draw.ts';
import useCanvasUI from '../ui/useCanvasUI.ts';
import type { Widget } from '../ui/useCanvasUI.ts';
import useGlassBlur, { buttonPane, panelPane } from '../ui/useGlassBlur.ts';
import { displayDesign } from '../display.ts';
import type { PlayerCount } from '../../../../packages/pose/choreography.ts';
import { minigameBest } from './bestScores.ts';
import type { MinigameBest } from './bestScores.ts';
import { formatScore, playersLabel } from './definition.ts';
import { MG_COLUMNS, MG_PER_PAGE, minigameLayout, tileArt } from './layout.ts';
import { minigameOptions, optionsText, resolveOptions, saveMinigameOption, stepOption } from './options.ts';
import type { MinigameOptionValues } from './options.ts';
import { MINIGAMES } from './registry.ts';
import type { MinigameDefinition } from './types.ts';

/**
 * Minigames' list, drawn in-engine from the main menu's Minigames (menu/MainMenu.tsx):
 *
 *   list     a glass tile per game (minigames/registry.ts), one column on the left, each with
 *            its art, title, blurb, players and best score; two per page, with page controls
 *            below the column and the menu dancers on the right. Like the Wii's channels
 *   preview  the chosen game's title, options and players dial on the left, Play below,
 *            and the menu's glass dancer platform on the right. The dial only steps through
 *            supported player counts; solo games show one with both steps disabled.
 *
 * Mouse, touch and the keyboard (or a Siri Remote) as on the other menus: the pearl focus ring
 * starts on the main action, Up/Down move down and up a column of tiles (on to the back button),
 * Left/Right across a row (on to the next page at its end), Enter or Space press, Escape goes back
 * (from the preview to the list, from the list to the main menu). On the preview, Up/Down go
 * through the option rows, the dial and Play, and Left/Right step the row with the cursor (Enter
 * or a press on the row steps it on). The games' art moves gently. The canvas reports
 * data-minigame-screen (list, preview), -minigame-select-ready, -minigame-list (the ids in
 * order), -minigame-page, -minigame-chosen, -minigame-dial and -minigame-options (the preview's
 * settings, assist=max|bot=medium) for tests.
 *
 * <MinigameSelect visible open={{ id, players, options }} onBack onPlay={(game, players, options) => ...} />
 */

export type MinigameScreenName = 'list' | 'preview';
export interface MinigameSelectProps {
  visible?: boolean;
  /** Opens on this game's preview with this many players and these settings (coming back from playing it). */
  open?: { id: string; players: PlayerCount; options?: MinigameOptionValues } | null;
  /** The player count to start a game's dial on, where the game supports it. */
  players?: PlayerCount;
  onBack?: () => void;
  /** The preview's player count, or null while the preview is hidden (for the menu platform). */
  onPreviewPlayersChange?: (players: PlayerCount | null) => void;
  onPlay?: (game: MinigameDefinition, players: PlayerCount, options: MinigameOptionValues) => void;
}
/** A tile; an option row, or one of its arrows (step). */
type SelectWidget = Widget & { game?: MinigameDefinition; option?: string; step?: -1 | 1 };

const COUNT_NAMES = ['One player', 'Two players', 'Three players', 'Four players'];
// The deep aero glass a tile's art sits on, unless the game picks its own.
const TINT = ['rgba(52, 150, 226, 0.62)', 'rgba(8, 58, 132, 0.72)'] as const;
const TILE_CORNER = 30;
// The art moves, but the list redraws at most this often (each redraw uploads the overlay).
const ART_FPS = 20;
const fmt = (game: MinigameDefinition, score: number) => formatScore(game, score, { unit: true });

// A tile: the game's art in a rounded window, then its title, blurb and players and best below,
// on frosted glass (useGlassBlur) tinted the game's colours. It lifts under the pointer.
function drawTile(g: CanvasRenderingContext2D, rect: Rect, game: MinigameDefinition, hover: number, press: number, time: number, best: MinigameBest | null) {
  const lift = hover * 4 - press * 3;
  const r = { ...rect, y: rect.y - lift };
  const [top, bottom] = game.tint ?? TINT;
  g.save();
  roundRect(g, r.x, r.y, r.w, r.h, TILE_CORNER);
  const body = g.createLinearGradient(0, r.y, 0, r.y + r.h);
  body.addColorStop(0, top);
  body.addColorStop(1, bottom);
  g.fillStyle = body;
  g.fill();
  if (hover > 0.01) {
    g.fillStyle = `rgba(255, 255, 255, ${0.08 * hover})`;
    g.fill();
  }
  // The art, clipped to its window, with a gloss over its top half.
  const art = tileArt(r);
  g.save();
  roundRect(g, art.x, art.y, art.w, art.h, TILE_CORNER - 10);
  g.clip();
  game.art(g, art, time);
  const gloss = g.createLinearGradient(0, art.y, 0, art.y + art.h * 0.5);
  gloss.addColorStop(0, 'rgba(255, 255, 255, 0.32)');
  gloss.addColorStop(1, 'rgba(255, 255, 255, 0)');
  g.fillStyle = gloss;
  g.fillRect(art.x, art.y, art.w, art.h * 0.5);
  g.restore();
  roundRect(g, art.x, art.y, art.w, art.h, TILE_CORNER - 10);
  g.lineWidth = 2;
  g.strokeStyle = 'rgba(255, 255, 255, 0.55)';
  g.stroke();
  // Title, blurb, then players and the best for the count last picked.
  const x = r.x + 22, w = r.w - 44, y0 = art.y + art.h;
  g.font = `800 ${r.w > 380 ? 30 : 26}px ${FONT}`;
  drawShadowText(g, ellipsize(g, game.title, w), x, y0 + 32, { size: r.w > 380 ? 30 : 26, weight: 800 });
  g.font = `600 18px ${FONT}`;
  drawShadowText(g, ellipsize(g, game.blurb, w), x, y0 + 62, { size: 18, weight: 600, color: '#d8f6ff' });
  drawShadowText(g, playersLabel(game.players), x, y0 + 92, { size: 17, weight: 700, color: '#bff4ff' });
  if (best) drawShadowText(g, `Best ${fmt(game, best.score)}`, r.x + r.w - 22, y0 + 92, { size: 17, weight: 800, align: 'right', color: '#fff2bf' });
  // The rim, brightening under the pointer.
  roundRect(g, r.x, r.y, r.w, r.h, TILE_CORNER);
  g.lineWidth = 3;
  g.strokeStyle = `rgba(255, 255, 255, ${0.6 + hover * 0.35})`;
  g.stroke();
  g.restore();
}

// An arrow, a glass circle with a chevron: the list's page arrows, and an option row's steps.
function drawArrow(g: CanvasRenderingContext2D, c: Circle, dir: 'left' | 'right', hover: number, { enabled = true, press = 0 } = {}) {
  g.save();
  if (!enabled) g.globalAlpha *= 0.35;
  const at = { ...c, y: c.y + press * 3 };
  drawGlassCircle(g, at, enabled ? hover : 0);
  g.strokeStyle = '#ffffff';
  g.lineWidth = c.r < 30 ? 4 : 5;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  ICONS[dir](g, at.x, at.y, c.r * 1.3);
  g.restore();
}

// One line of white type in maxW: 26 units, shrinking to 22 before it's cut short.
function fitText(g: CanvasRenderingContext2D, str: string, x: number, y: number, maxW: number, weight: number, align: CanvasTextAlign = 'left') {
  g.save();
  g.font = `${weight} 26px ${FONT}`;
  const w = g.measureText(str).width;
  if (w > maxW) g.font = `${weight} ${Math.max(22, Math.floor((26 * maxW) / w))}px ${FONT}`;
  g.textAlign = align;
  g.textBaseline = 'middle';
  g.fillStyle = '#ffffff';
  g.fillText(ellipsize(g, str, maxW), x, y + 1);
  g.restore();
}

type PreviewLayout = ReturnType<typeof minigameLayout>;
// The game's option rows on dark glass under its art, like the settings rows: each its label, then
// its choice on a dark track between the arrows, which step through the choices and round again
// (as the camera picker's do). A row lights under the pointer.
function drawOptions(g: CanvasRenderingContext2D, game: MinigameDefinition, values: MinigameOptionValues, l: PreviewLayout, h: Record<string, number>, press: (id: string) => number, keyed: string | null) {
  if (!l.MG_OPTIONS || !game.options) return;
  drawDarkGlassPanel(g, l.MG_OPTIONS, 34);
  game.options.forEach((option, i) => {
    const row = l.mgOption(i), prev = l.mgOptionPrev(i), next = l.mgOptionNext(i);
    const id = `option-${option.id}`, cy = row.y + row.h / 2;
    // The keyboard cursor on the row lights the row, not whichever arrow its middle falls in.
    const arrow = (side: 'prev' | 'next') => (keyed === id ? { hover: 0, press: 0 } : { hover: h[`${id}-${side}`] ?? 0, press: press(`${id}-${side}`) });
    const lit = Math.max(h[id] ?? 0, h[`${id}-prev`] ?? 0, h[`${id}-next`] ?? 0);
    if (lit > 0.01) {
      pill(g, row.x, row.y, row.w, row.h);
      g.fillStyle = `rgba(255, 255, 255, ${0.1 * lit})`;
      g.fill();
    }
    const labelX = row.x + 22;
    fitText(g, option.label, labelX, cy, prev.x - prev.r - 14 - labelX, 600);
    pill(g, prev.x, cy - 19, next.x - prev.x, 38);
    g.fillStyle = 'rgba(0, 30, 70, 0.45)';
    g.fill();
    drawArrow(g, prev, 'left', arrow('prev').hover, { press: arrow('prev').press });
    drawArrow(g, next, 'right', arrow('next').hover, { press: arrow('next').press });
    const choice = option.choices.find((c) => c.value === values[option.id]) ?? option.choices[0];
    fitText(g, choice.label, (prev.x + next.x) / 2, cy, next.x - prev.x - prev.r - next.r - 16, 700, 'center');
  });
}

interface SelectState {
  alpha: number; screen: MinigameScreenName; next: MinigameScreenName; swap: number;
  page: number;
  /** The game on the preview (or last opened), and each game's dial. */
  chosen: string | null;
  dial: Map<string, PlayerCount>;
  /** Each game's settings as chosen this visit (read from storage the first time, options.ts). */
  options: Map<string, MinigameOptionValues>;
  /** The preview's layouts, by width and option rows. */
  layouts: Map<string, PreviewLayout>;
  drawnAt: number;
  drawn: string;
  reported: string;
  previewPlayers: PlayerCount | null;
  /** Best scores read from storage, by game and players (read again each time the list opens). */
  bests: Map<string, MinigameBest | null>;
}

export default function MinigameSelect({ visible = false, open = null, players = 1, onBack, onPlay, onPreviewPlayersChange }: MinigameSelectProps) {
  const gl = useThree((state) => state.gl);
  const size = useThree((state) => state.size);
  const width = displayDesign(size.width, size.height).w;
  const layout = minigameLayout(width);
  const props = useRef({ visible, players, onBack, onPlay, onPreviewPlayersChange });
  props.current = { visible, players, onBack, onPlay, onPreviewPlayersChange };
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const widthRef = useRef(width);
  widthRef.current = width;
  const st = useRef<SelectState>({
    alpha: 0, screen: 'list', next: 'list', swap: 1, page: 0, chosen: null, dial: new Map(), options: new Map(), layouts: new Map(), drawnAt: -Infinity, drawn: '', reported: '', previewPlayers: null, bests: new Map(),
  }).current;

  const pages = Math.max(1, Math.ceil(MINIGAMES.length / MG_PER_PAGE));
  const onPage = () => MINIGAMES.slice(st.page * MG_PER_PAGE, (st.page + 1) * MG_PER_PAGE);
  const chosen = () => MINIGAMES.find((game) => game.id === st.chosen) ?? null;
  // A game's preview makes room for its option rows.
  const previewLayout = (game: MinigameDefinition | null) => {
    const n = game?.options?.length ?? 0;
    if (!n) return layoutRef.current;
    const key = `${widthRef.current}|${n}`;
    let l = st.layouts.get(key);
    if (!l) { l = minigameLayout(widthRef.current, n); st.layouts.set(key, l); }
    return l;
  };
  // A game's settings: what was chosen this visit, else what this browser remembers, else its defaults.
  const optionsOf = (game: MinigameDefinition): MinigameOptionValues => {
    let values = st.options.get(game.id);
    if (!values) { values = minigameOptions(game); st.options.set(game.id, values); }
    return values;
  };
  // An option row steps through its choices, round and round, and the game remembers the choice.
  const stepRow = (id: string, dir: -1 | 1) => {
    const game = chosen();
    if (!game) return;
    const values = optionsOf(game), value = stepOption(game, values, id, dir);
    if (value === null || value === values[id]) return;
    st.options.set(game.id, { ...values, [id]: value });
    saveMinigameOption(game, id, value);
  };
  // A game's dial: what was picked for it, else the menu's count where it supports that, else its first.
  const dialOf = (game: MinigameDefinition): PlayerCount => {
    const picked = st.dial.get(game.id);
    if (picked && game.players.includes(picked)) return picked;
    return game.players.includes(props.current.players) ? props.current.players : game.players[0];
  };
  const live = () => props.current.visible && st.alpha > 0.3 && st.screen === st.next;
  // (The list redraws often: storage is read once a game and count.)
  const bestOf = (game: MinigameDefinition, count: PlayerCount) => {
    if (game.best === false) return null;
    const key = `${game.id}|${count}`;
    if (!st.bests.has(key)) st.bests.set(key, minigameBest(game.id, count));
    return st.bests.get(key) ?? null;
  };
  const tileWidget = (game: MinigameDefinition, i: number, primary: boolean): SelectWidget => ({ id: `game-${game.id}`, game, rect: layoutRef.current.mgTile(i), corner: TILE_CORNER, primary });
  // Tiles in column order, so Up/Down go down and up a column (Left/Right go across, onStep).
  const tileWidgets = () => {
    const games = onPage();
    const primary = Math.max(0, games.findIndex((game) => game.id === st.chosen));
    const order = games.map((_, i) => i).sort((a, b) => (a % MG_COLUMNS) - (b % MG_COLUMNS) || a - b);
    return order.map((i) => tileWidget(games[i], i, i === primary));
  };
  const go = (screen: MinigameScreenName, key = ui.keyboard) => {
    if (screen === st.next) return;
    st.next = screen;
    if (!key) return;
    ui.focus(null);
    if (screen === 'list') {
      const games = onPage(), i = games.findIndex((game) => game.id === st.chosen);
      if (i >= 0) ui.focus(tileWidget(games[i], i, true));
    } else ui.focus({ id: 'play', rect: layoutRef.current.MG_PLAY });
  };
  const choose = (game: MinigameDefinition) => {
    st.chosen = game.id;
    go('preview');
  };
  const back = (key?: boolean) => {
    if (st.next === 'preview') { go('list', key); return; }
    props.current.onBack?.();
  };
  const turnPage = (dir: -1 | 1) => {
    const page = Math.max(0, Math.min(pages - 1, st.page + dir));
    if (page === st.page) return false;
    st.page = page;
    return true;
  };
  // The dial steps through the counts the game supports.
  const stepDial = (dir: -1 | 1) => {
    const game = chosen();
    if (!game) return;
    const counts = [...game.players].sort((a, b) => a - b);
    const i = counts.indexOf(dialOf(game)) + dir;
    if (i < 0 || i >= counts.length) return;
    st.dial.set(game.id, counts[i]);
  };

  const ui = useCanvasUI<SelectWidget>({
    priority: 2,
    active: live,
    keyNav: true,
    widgets: () => {
      if (st.screen === 'preview') {
        const game = chosen(), l = previewLayout(game);
        const counts = game ? [...game.players].sort((a, b) => a - b) : [];
        return [
          { id: 'back', circle: l.MG_BACK },
          // The option rows, each one stop for the keyboard. Each arrow takes its half of the
          // choice's track (listed first, so a press there is the arrow's, near misses too); the
          // row takes the rest, its label, and steps forward.
          ...(game?.options ?? []).flatMap((option, i): SelectWidget[] => {
            const row = l.mgOption(i), prev = l.mgOptionPrev(i), next = l.mgOptionNext(i);
            const left = prev.x - prev.r - 14, mid = (prev.x + next.x) / 2;
            return [
              { id: `option-${option.id}-prev`, option: option.id, step: -1, rect: { x: left, y: row.y, w: mid - left, h: row.h }, nav: false },
              { id: `option-${option.id}-next`, option: option.id, step: 1, rect: { x: mid, y: row.y, w: row.x + row.w - mid, h: row.h }, nav: false },
              { id: `option-${option.id}`, option: option.id, rect: row },
            ];
          }),
          ...(counts.length > 1 ? [{ id: 'minus', circle: l.MG_MINUS }, { id: 'plus', circle: l.MG_PLUS }] : []),
          { id: 'play', rect: l.MG_PLAY, corner: glassCorner(l.MG_PLAY.h), primary: true },
        ];
      }
      return [
        { id: 'back', circle: layoutRef.current.MG_BACK },
        ...tileWidgets(),
        ...(pages > 1 ? [{ id: 'page-prev', circle: layoutRef.current.MG_PAGE_PREV, nav: false }, { id: 'page-next', circle: layoutRef.current.MG_PAGE_NEXT, nav: false }] : []),
      ];
    },
    onActivate: (wdg, s) => {
      if (wdg.game) choose(wdg.game);
      else if (wdg.option) stepRow(wdg.option, wdg.step ?? 1);
      else if (wdg.id === 'back') back();
      else if (wdg.id === 'page-prev') turnPage(-1);
      else if (wdg.id === 'page-next') turnPage(1);
      else if (wdg.id === 'minus') stepDial(-1);
      else if (wdg.id === 'plus') stepDial(1);
      else if (wdg.id === 'play') {
        const game = chosen();
        if (game) props.current.onPlay?.(game, dialOf(game), optionsOf(game));
      }
      s.invalidate();
    },
    // Left/Right step an option row (a held key doesn't spin it round), or go across a row of
    // tiles, on to the next page at its end.
    onStep: (wdg, dir, s, repeat) => {
      if (wdg.option) {
        if (!repeat) stepRow(wdg.option, dir);
        return true;
      }
      if (!wdg.game) return false;
      const games = onPage(), i = games.indexOf(wdg.game), col = i % MG_COLUMNS;
      if ((dir < 0 && col === 0) || (dir > 0 && (col === MG_COLUMNS - 1 || i === games.length - 1))) {
        if (!turnPage(dir)) return true;
        const next = onPage(), j = dir > 0 ? 0 : Math.min(next.length - 1, i - col + MG_COLUMNS - 1);
        s.focus(tileWidget(next[j], j, false));
        return true;
      }
      s.focus(tileWidget(games[i + dir], i + dir, false));
      return true;
    },
    onKey: (e, s) => {
      if (!live() || e.repeat) return;
      if (e.key === 'Escape') back(true);
      else return;
      e.preventDefault();
      s.invalidate();
    },
    update: (dt, s) => {
      const p = props.current;
      if (st.next !== st.screen) {
        st.swap = Math.max(0, st.swap - dt * 7);
        if (st.swap === 0) st.screen = st.next;
        s.invalidate();
      } else if (st.swap < 1) {
        st.swap = Math.min(1, st.swap + dt * 6);
        s.invalidate();
      }
      st.alpha = s.ease(st.alpha, p.visible ? 1 : 0, p.visible ? 3 : 6);
      // The art moves: redraw now and then while showing.
      if (p.visible && s.time - st.drawnAt >= 1 / ART_FPS) s.invalidate();
      const game = chosen();
      const previewPlayers = p.visible && st.screen === 'preview' && game ? dialOf(game) : null;
      if (previewPlayers !== st.previewPlayers) {
        st.previewPlayers = previewPlayers;
        p.onPreviewPlayersChange?.(previewPlayers);
      }
      const settings = game ? optionsText(optionsOf(game)) : '';
      const key = [st.screen, st.page, st.chosen, game ? dialOf(game) : '', settings].join('~');
      if (key !== st.drawn) { st.drawn = key; s.invalidate(); }
      const report = {
        minigameScreen: st.screen,
        minigameSelectReady: String(live() && st.swap > 0.95),
        minigameList: MINIGAMES.map((g) => g.id).join('|'),
        minigamePage: `${st.page + 1}/${pages}`,
        minigameChosen: st.screen === 'preview' ? st.chosen ?? '' : '',
        minigameDial: game && st.screen === 'preview' ? String(dialOf(game)) : '',
        minigameOptions: st.screen === 'preview' ? settings : '',
      };
      const json = JSON.stringify(report);
      if (json !== st.reported) {
        st.reported = json;
        const { dataset } = gl.domElement;
        if (p.visible) Object.assign(dataset, report);
        else for (const k of Object.keys(report)) delete dataset[k];
      }
    },
    opacity: () => st.alpha,
    draw: (g, s) => {
      st.drawnAt = s.time;
      const l = layoutRef.current;
      const h = s.hover;
      const press = (id: string) => s.press * (h[id] ?? 0);
      const t = st.swap;
      g.save();
      g.globalAlpha = t;
      g.translate((1 - t) * -24, 0);
      if (st.screen === 'list') {
        drawHeader(g, l.MG_BACK, 'MINIGAMES', h.back ?? 0);
        const games = onPage();
        if (!games.length) {
          drawShadowText(g, 'The first minigames are on their way', l.MG_BACK.x - 38, 300, { size: 36, weight: 800 });
        }
        games.forEach((game, i) => drawTile(g, l.mgTile(i), game, h[`game-${game.id}`] ?? 0, press(`game-${game.id}`), s.time, bestOf(game, game.players.includes(props.current.players) ? props.current.players : game.players[0])));
        if (pages > 1) {
          drawArrow(g, l.MG_PAGE_PREV, 'left', h['page-prev'] ?? 0, { enabled: st.page > 0 });
          drawArrow(g, l.MG_PAGE_NEXT, 'right', h['page-next'] ?? 0, { enabled: st.page < pages - 1 });
          for (let i = 0; i < pages; i++) {
            g.beginPath();
            g.arc(l.MG_PAGE_DOTS_X + (i - (pages - 1) / 2) * 26, l.MG_PAGE_DOTS_Y, i === st.page ? 7 : 5, 0, TAU);
            g.fillStyle = i === st.page ? '#ffffff' : 'rgba(255, 255, 255, 0.45)';
            g.fill();
          }
        }
      } else {
        const game = chosen();
        if (game) drawPreview(g, game, dialOf(game), h, press);
      }
      g.restore();
    },
  });

  // The preview: options and the players dial on the left, the shared menu platform on the right.
  function drawPreview(g: CanvasRenderingContext2D, game: MinigameDefinition, count: PlayerCount, h: Record<string, number>, press: (id: string) => number) {
    const l = previewLayout(game);
    drawHeader(g, l.MG_BACK, 'MINIGAMES', h.back ?? 0);
    const x = l.MG_BACK.x - 38, w = l.MG_TEXT.w;
    // A long title shrinks to fit (down to 48) before it's cut short.
    g.font = `800 64px ${FONT}`;
    const titleSize = Math.max(48, Math.min(64, Math.floor((64 * w) / g.measureText(game.title).width)));
    g.font = `800 ${titleSize}px ${FONT}`;
    drawShadowText(g, ellipsize(g, game.title, w), x, l.MG_BACK.y + 84, { size: titleSize, weight: 800 });
    // The best for this many players.
    const best = bestOf(game, count);
    const counts = [...game.players].sort((a, b) => a - b);
    if (game.best !== false) {
      drawShadowText(g, best ? `Best ${fmt(game, best.score)} with ${COUNT_NAMES[count - 1].toLowerCase()}` : `No best yet with ${COUNT_NAMES[count - 1].toLowerCase()}`,
        x + 2, l.MG_BEST_Y, { size: 22, weight: 700, color: best ? '#fff2bf' : '#bff4ff' });
    }
    // Always show the players dial; unavailable steps are dimmed, including both for solo games.
    drawCaps(g, 'PLAYERS', x + 2, l.MG_MINUS.y, { size: 20 });
    drawDialStep(g, l.MG_MINUS, false, h.minus ?? 0, press('minus'), count > counts[0]);
    drawDialStep(g, l.MG_PLUS, true, h.plus ?? 0, press('plus'), count < counts.at(-1)!);
    drawDialCount(g, count, l.MG_COUNT_X, l.MG_MINUS.y, 120);
    drawGlassButton(g, l.MG_PLAY, { label: 'Play', sub: COUNT_NAMES[count - 1], icon: 'play', hover: h.play ?? 0, press: press('play'), chevron: false });
    drawOptions(g, game, optionsOf(game), l, h, press, ui.keyFocus);
  }

  // Frosted glass in the tiles, and the preview's options and Play.
  useGlassBlur(() => {
    const l = st.screen === 'list' ? layoutRef.current : previewLayout(chosen());
    const panes = st.screen === 'list'
      ? onPage().map((game, i) => ({ ...buttonPane(ui, `game-${game.id}`, l.mgTile(i)), corner: TILE_CORNER }))
      : [...(l.MG_OPTIONS ? [panelPane(l.MG_OPTIONS)] : []), buttonPane(ui, 'play', l.MG_PLAY)];
    return { panes, alpha: st.alpha * st.swap, offsetX: (1 - st.swap) * -24 };
  });

  // Opening the list lands on it (or on the game just played, with its players), focusing that game's tile or Play.
  useEffect(() => {
    if (!visible) return;
    st.bests.clear();
    const game = open ? MINIGAMES.find((g) => g.id === open.id) : null;
    if (game && open) {
      st.chosen = game.id;
      st.dial.set(game.id, open.players);
      // (The round may have changed a setting: ctx.setOption.)
      if (open.options) st.options.set(game.id, resolveOptions(game, open.options));
      st.page = Math.floor(MINIGAMES.indexOf(game) / MG_PER_PAGE);
    }
    st.screen = st.next = game ? 'preview' : 'list';
    st.swap = 1;
    if (ui.keyboard) ui.focus(game ? { id: 'play', rect: layoutRef.current.MG_PLAY } : null);
    ui.invalidate();
  }, [visible, open, st, ui]);

  return null;
}
