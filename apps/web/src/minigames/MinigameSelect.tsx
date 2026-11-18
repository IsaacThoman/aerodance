import { useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import {
  FONT, TAU, drawCaps, drawDarkGlassPanel, drawDialCount, drawDialStep, drawGlassButton, drawGlassCircle, drawHeader, drawShadowText,
  ellipsize, glassCorner, ICONS, pill,
} from '../ui/draw.ts';
import type { Circle, Rect } from '../ui/draw.ts';
import useCanvasUI from '../ui/useCanvasUI.ts';
import type { Widget } from '../ui/useCanvasUI.ts';
import useGlassBlur, { buttonPane, panelPane } from '../ui/useGlassBlur.ts';
import { displayDesign } from '../display.ts';
import type { PlayerCount } from '../../../../packages/pose/choreography.ts';
import { minigameBest } from './bestScores.ts';
import type { MinigameBest } from './bestScores.ts';
import { formatScore, forPlayers } from './definition.ts';
import { MG_COLUMNS, MG_PER_PAGE, minigameLayout } from './layout.ts';
import { minigameOptions, optionKey, optionsText, resolveOptions, saveMinigameOption, stepOption } from './options.ts';
import type { MinigameOptionValues } from './options.ts';
import { MINIGAMES } from './registry.ts';
import type { MinigameDefinition, MinigameOption } from './types.ts';
import { PLAYERS } from '../game/results.ts';
import type { PlayerLook } from '../game/results.ts';

/**
 * Minigames' list, drawn in-engine from the main menu's Minigames (menu/MainMenu.tsx):
 *
 *   list     a compact glass button per game (minigames/registry.ts), one column on the left, each with
 *            its monochrome icon and title; four per page, with page controls
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
 * or a press on the row steps it on). The canvas reports
 * data-minigame-screen (list, preview), -minigame-select-ready, -minigame-list (the ids in
 * order), -minigame-page, -minigame-chosen, -minigame-dial and -minigame-options (the preview's
 * settings, scene=biodome|botShots=medium|botReturns=everything) for tests.
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
/** A widget: a game's tile, or a setting's (its key, options.ts optionKey) arrow, row or player chip. */
type SelectWidget = Widget & { game?: MinigameDefinition; option?: string; step?: -1 | 1; chip?: { row: number; player: number; count: number } };

const COUNT_NAMES = ['One player', 'Two players', 'Three players', 'Four players'];
const fmt = (game: MinigameDefinition, score: number) => formatScore(game, score, { unit: true });

// A compact game button using the same glass, monochrome icons and title as the main menu.
function drawTile(g: CanvasRenderingContext2D, rect: Rect, game: MinigameDefinition, hover: number, press: number) {
  drawGlassButton(g, rect, { label: game.title, icon: game.icon, hover, press, chevron: false });
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
// The game's option rows on dark glass, like the settings rows: each its label, then
// its choice between the arrows, which step through the choices and round again
// (as the camera picker's do). A row lights under the pointer. One that isn't for this
// many players (MinigameOption.players) is dimmed, as the dial's unavailable steps are.
// A per-player row has a chip for each player instead, in their colour, which steps on
// with a press.
function drawOptions(g: CanvasRenderingContext2D, game: MinigameDefinition, values: MinigameOptionValues, count: PlayerCount, l: PreviewLayout, h: Record<string, number>, press: (id: string) => number, keyed: string | null) {
  if (!l.MG_OPTIONS || !game.options) return;
  drawDarkGlassPanel(g, l.MG_OPTIONS, 34);
  game.options.forEach((option, i) => {
    const row = l.mgOption(i), prev = l.mgOptionPrev(i), next = l.mgOptionNext(i);
    const off = !forPlayers(option, count);
    g.save();
    if (off) g.globalAlpha *= 0.35;
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
    if (option.perPlayer) {
      fitText(g, option.label, labelX, cy, l.mgOptionPlayer(i, 0, count).x - 12 - labelX, 600);
      for (let player = 0; player < count; player++) {
        const id = `option-${optionKey(option.id, player)}`;
        drawPlayerChip(g, l.mgOptionPlayer(i, player, count), PLAYERS[player], choiceOf(option, values[optionKey(option.id, player)]).label,
          off ? 0 : keyed === id ? 1 : h[id] ?? 0, off ? 0 : press(id));
      }
      g.restore();
      return;
    }
    fitText(g, option.label, labelX, cy, prev.x - prev.r - 14 - labelX, 600);
    drawArrow(g, prev, 'left', arrow('prev').hover, { press: arrow('prev').press });
    drawArrow(g, next, 'right', arrow('next').hover, { press: arrow('next').press });
    fitText(g, choiceOf(option, values[option.id]).label, (prev.x + next.x) / 2, cy, next.x - prev.x - prev.r - next.r - 16, 700, 'center');
    g.restore();
  });
}

const choiceOf = (option: MinigameOption, value: string | undefined) => option.choices.find((c) => c.value === value) ?? option.choices[0];

// A player's chip on a per-player row: a pill tinted and edged in their colour (their dancer's
// on the platform), their choice on it in white.
function drawPlayerChip(g: CanvasRenderingContext2D, rect: Rect, look: PlayerLook, label: string, lit: number, pressed: number) {
  g.save();
  const inset = pressed * 2;
  pill(g, rect.x + inset, rect.y + inset, rect.w - 2 * inset, rect.h - 2 * inset);
  g.globalAlpha *= 0.32 + 0.2 * lit;
  g.fillStyle = look.color;
  g.fill();
  g.restore();
  g.save();
  pill(g, rect.x + inset, rect.y + inset, rect.w - 2 * inset, rect.h - 2 * inset);
  g.lineWidth = 2.5;
  g.strokeStyle = look.light;
  g.globalAlpha *= 0.75 + 0.25 * lit;
  g.stroke();
  g.restore();
  g.save();
  g.font = `700 24px ${FONT}`;
  const w = g.measureText(label).width, room = rect.w - 20;
  if (w > room) g.font = `700 ${Math.max(16, Math.floor((24 * room) / w))}px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#ffffff';
  g.shadowColor = 'rgba(0, 20, 60, 0.45)';
  g.shadowBlur = 4;
  g.fillText(ellipsize(g, label, room), rect.x + rect.w / 2, rect.y + rect.h / 2 + 1);
  g.restore();
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
    alpha: 0, screen: 'list', next: 'list', swap: 1, page: 0, chosen: null, dial: new Map(), options: new Map(), layouts: new Map(), drawn: '', reported: '', previewPlayers: null, bests: new Map(),
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
  // A player's chip on a per-player option row.
  const chipWidget = (option: MinigameOption, row: number, player: number, count: number, l: PreviewLayout): SelectWidget => {
    const rect = l.mgOptionPlayer(row, player, count), key = optionKey(option.id, player);
    return { id: `option-${key}`, option: key, step: 1, rect, corner: rect.h / 2, chip: { row, player, count } };
  };
  const tileWidget = (game: MinigameDefinition, i: number, primary: boolean): SelectWidget => ({ id: `game-${game.id}`, game, rect: layoutRef.current.mgTile(i), corner: glassCorner(layoutRef.current.mgTile(i).h), primary });
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
            // (A row for other player counts takes no presses.)
            const count = dialOf(game!);
            if (!forPlayers(option, count)) return [];
            // A per-player row: a chip each, stepped on by a press.
            if (option.perPlayer) return Array.from({ length: count }, (_, player) => chipWidget(option, i, player, count, l));
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
    // Left/Right step an option row (a held key doesn't spin it round), go across a per-player
    // row's chips (a press steps one), or go across a row of tiles, on to the next page at its end.
    onStep: (wdg, dir, s, repeat) => {
      if (wdg.chip) {
        const { row, player, count } = wdg.chip, game = chosen(), option = game?.options?.[row];
        if (option && player + dir >= 0 && player + dir < count) s.focus(chipWidget(option, row, player + dir, count, previewLayout(game)));
        return true;
      }
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
        // (Rows, as the layout counts them: a per-player setting is a row of several values.)
        minigameOptionRows: st.screen === 'preview' && game ? String(game.options?.length ?? 0) : '',
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
      const l = layoutRef.current;
      const h = s.hover;
      const press = (id: string) => s.press * (h[id] ?? 0);
      const t = st.swap;
      g.save();
      g.globalAlpha = t;
      g.translate((1 - t) * -24, 0);
      if (st.screen === 'list') {
        drawHeader(g, l.MG_BACK, 'EXPERIMENTS', h.back ?? 0);
        const games = onPage();
        if (!games.length) {
          drawShadowText(g, 'The first experiments are on their way', l.MG_BACK.x - 38, 300, { size: 36, weight: 800 });
        }
        games.forEach((game, i) => drawTile(g, l.mgTile(i), game, h[`game-${game.id}`] ?? 0, press(`game-${game.id}`)));
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
    drawHeader(g, l.MG_BACK, 'EXPERIMENTS', h.back ?? 0);
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
    drawOptions(g, game, optionsOf(game), count, l, h, press, ui.keyFocus);
  }

  // Frosted glass in the tiles, and the preview's options and Play.
  useGlassBlur(() => {
    const l = st.screen === 'list' ? layoutRef.current : previewLayout(chosen());
    const panes = st.screen === 'list'
      ? onPage().map((game, i) => buttonPane(ui, `game-${game.id}`, l.mgTile(i)))
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
