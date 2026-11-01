import { useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import {
  FONT, TAU, drawCaps, drawDarkGlassPanel, drawDialCount, drawDialStep, drawGlassButton, drawGlassCircle, drawHeader, drawShadowText,
  ellipsize, glassCorner, ICONS, paragraph, roundRect,
} from '../ui/draw.ts';
import type { Rect } from '../ui/draw.ts';
import useCanvasUI from '../ui/useCanvasUI.ts';
import type { Widget } from '../ui/useCanvasUI.ts';
import useGlassBlur, { buttonPane, panelPane } from '../ui/useGlassBlur.ts';
import { displayDesign } from '../display.ts';
import type { PlayerCount } from '../../../../packages/pose/choreography.ts';
import { minigameBest } from './bestScores.ts';
import { formatScore, playersLabel } from './definition.ts';
import { MG_PER_PAGE, minigameLayout, tileArt } from './layout.ts';
import { MINIGAMES } from './registry.ts';
import type { MinigameDefinition } from './types.ts';

/**
 * Minigames' list, drawn in-engine from the main menu's Minigames (menu/MainMenu.tsx):
 *
 *   list     a glass tile per game (minigames/registry.ts), three across and two down, each with
 *            its art, title, blurb, players and best score; more than six page with the arrows
 *            beside the grid. Like the Wii's channels
 *   preview  the chosen game: its art large, its description, its best for the players picked,
 *            and the players dial (only the counts it supports) over Play, which starts it
 *            (onPlay) with that many players
 *
 * Mouse, touch and the keyboard (or a Siri Remote) as on the other menus: the pearl focus ring
 * starts on the main action, Up/Down move down and up a column of tiles (on to the back button),
 * Left/Right across a row (on to the next page at its end), Enter or Space press, Escape goes back
 * (from the preview to the list, from the list to the main menu). The games' art moves gently.
 * The canvas reports data-minigame-screen (list, preview), -minigame-select-ready, -minigame-list
 * (the ids in order), -minigame-page, -minigame-chosen and -minigame-dial for tests.
 *
 * <MinigameSelect visible open={{ id, players }} onBack onPlay={(game, players) => ...} />
 */

export type MinigameScreenName = 'list' | 'preview';
export interface MinigameSelectProps {
  visible?: boolean;
  /** Opens on this game's preview with this many players (coming back from playing it). */
  open?: { id: string; players: PlayerCount } | null;
  /** The player count to start a game's dial on, where the game supports it. */
  players?: PlayerCount;
  onBack?: () => void;
  onPlay?: (game: MinigameDefinition, players: PlayerCount) => void;
}
type SelectWidget = Widget & { game?: MinigameDefinition };

const COUNT_NAMES = ['One player', 'Two players', 'Three players', 'Four players'];
// The deep aero glass a tile's art sits on, unless the game picks its own.
const TINT = ['rgba(52, 150, 226, 0.62)', 'rgba(8, 58, 132, 0.72)'] as const;
const TILE_CORNER = 30;
// The art moves, but the list redraws at most this often (each redraw uploads the overlay).
const ART_FPS = 20;
const fmt = (game: MinigameDefinition, score: number) => formatScore(game, score, { unit: true });

// A tile: the game's art in a rounded window, then its title, blurb and players and best below,
// on frosted glass (useGlassBlur) tinted the game's colours. It lifts under the pointer.
function drawTile(g: CanvasRenderingContext2D, rect: Rect, game: MinigameDefinition, hover: number, press: number, time: number, players: PlayerCount) {
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
  const best = minigameBest(game.id, game.players.includes(players) ? players : game.players[0]);
  drawShadowText(g, playersLabel(game.players), x, y0 + 92, { size: 17, weight: 700, color: '#bff4ff' });
  if (best) drawShadowText(g, `Best ${fmt(game, best.score)}`, r.x + r.w - 22, y0 + 92, { size: 17, weight: 800, align: 'right', color: '#fff2bf' });
  // The rim, brightening under the pointer.
  roundRect(g, r.x, r.y, r.w, r.h, TILE_CORNER);
  g.lineWidth = 3;
  g.strokeStyle = `rgba(255, 255, 255, ${0.6 + hover * 0.35})`;
  g.stroke();
  g.restore();
}

// An empty place on the grid: a faint frosted outline.
function drawEmptyTile(g: CanvasRenderingContext2D, r: Rect) {
  g.save();
  roundRect(g, r.x, r.y, r.w, r.h, TILE_CORNER);
  g.fillStyle = 'rgba(255, 255, 255, 0.1)';
  g.fill();
  g.setLineDash([10, 10]);
  g.lineWidth = 2.5;
  g.strokeStyle = 'rgba(255, 255, 255, 0.4)';
  g.stroke();
  g.restore();
}

// A page arrow: a glass circle with a chevron.
function drawPageArrow(g: CanvasRenderingContext2D, c: { x: number; y: number; r: number }, dir: 'left' | 'right', hover: number, enabled: boolean) {
  g.save();
  if (!enabled) g.globalAlpha *= 0.35;
  drawGlassCircle(g, c, enabled ? hover : 0);
  g.strokeStyle = '#ffffff';
  g.lineWidth = 5;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  ICONS[dir](g, c.x, c.y, c.r * 1.3);
  g.restore();
}

interface SelectState {
  alpha: number; screen: MinigameScreenName; next: MinigameScreenName; swap: number;
  page: number;
  /** The game on the preview (or last opened), and each game's dial. */
  chosen: string | null;
  dial: Map<string, PlayerCount>;
  drawnAt: number;
  drawn: string;
  reported: string;
}

export default function MinigameSelect({ visible = false, open = null, players = 1, onBack, onPlay }: MinigameSelectProps) {
  const gl = useThree((state) => state.gl);
  const size = useThree((state) => state.size);
  const layout = minigameLayout(displayDesign(size.width, size.height).w);
  const props = useRef({ visible, players, onBack, onPlay });
  props.current = { visible, players, onBack, onPlay };
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const st = useRef<SelectState>({ alpha: 0, screen: 'list', next: 'list', swap: 1, page: 0, chosen: null, dial: new Map(), drawnAt: -Infinity, drawn: '', reported: '' }).current;

  const pages = Math.max(1, Math.ceil(MINIGAMES.length / MG_PER_PAGE));
  const onPage = () => MINIGAMES.slice(st.page * MG_PER_PAGE, (st.page + 1) * MG_PER_PAGE);
  const chosen = () => MINIGAMES.find((game) => game.id === st.chosen) ?? null;
  // A game's dial: what was picked for it, else the menu's count where it supports that, else its first.
  const dialOf = (game: MinigameDefinition): PlayerCount => {
    const picked = st.dial.get(game.id);
    if (picked && game.players.includes(picked)) return picked;
    return game.players.includes(props.current.players) ? props.current.players : game.players[0];
  };
  const live = () => props.current.visible && st.alpha > 0.3 && st.screen === st.next;
  const tileWidget = (game: MinigameDefinition, i: number, primary: boolean): SelectWidget => ({ id: `game-${game.id}`, game, rect: layoutRef.current.mgTile(i), corner: TILE_CORNER, primary });
  // Tiles in column order, so Up/Down go down and up a column (Left/Right go across, onStep).
  const tileWidgets = () => {
    const games = onPage();
    const primary = Math.max(0, games.findIndex((game) => game.id === st.chosen));
    const order = games.map((_, i) => i).sort((a, b) => (a % 3) - (b % 3) || a - b);
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
        const game = chosen();
        const counts = game ? [...game.players].sort((a, b) => a - b) : [];
        return [
          { id: 'back', circle: layoutRef.current.MG_BACK },
          ...(counts.length > 1 ? [{ id: 'minus', circle: layoutRef.current.MG_MINUS }, { id: 'plus', circle: layoutRef.current.MG_PLUS }] : []),
          { id: 'play', rect: layoutRef.current.MG_PLAY, corner: glassCorner(layoutRef.current.MG_PLAY.h), primary: true },
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
      else if (wdg.id === 'back') back();
      else if (wdg.id === 'page-prev') turnPage(-1);
      else if (wdg.id === 'page-next') turnPage(1);
      else if (wdg.id === 'minus') stepDial(-1);
      else if (wdg.id === 'plus') stepDial(1);
      else if (wdg.id === 'play') {
        const game = chosen();
        if (game) props.current.onPlay?.(game, dialOf(game));
      }
      s.invalidate();
    },
    // Left/Right across a row of tiles, on to the next page at its end.
    onStep: (wdg, dir, s) => {
      if (!wdg.game) return false;
      const games = onPage(), i = games.indexOf(wdg.game), col = i % 3;
      if ((dir < 0 && col === 0) || (dir > 0 && (col === 2 || i === games.length - 1))) {
        if (!turnPage(dir)) return true;
        const next = onPage(), j = dir > 0 ? 0 : Math.min(next.length - 1, i - col + 2);
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
      const key = [st.screen, st.page, st.chosen, game ? dialOf(game) : ''].join('~');
      if (key !== st.drawn) { st.drawn = key; s.invalidate(); }
      const report = {
        minigameScreen: st.screen,
        minigameSelectReady: String(live() && st.swap > 0.95),
        minigameList: MINIGAMES.map((g) => g.id).join('|'),
        minigamePage: `${st.page + 1}/${pages}`,
        minigameChosen: st.screen === 'preview' ? st.chosen ?? '' : '',
        minigameDial: game && st.screen === 'preview' ? String(dialOf(game)) : '',
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
        games.forEach((game, i) => drawTile(g, l.mgTile(i), game, h[`game-${game.id}`] ?? 0, press(`game-${game.id}`), s.time, props.current.players));
        // The page's empty places, like the Wii's unused channels: faint glass waiting for a game.
        for (let i = games.length; i < MG_PER_PAGE && st.page === pages - 1; i++) drawEmptyTile(g, l.mgTile(i));
        if (pages > 1) {
          drawPageArrow(g, l.MG_PAGE_PREV, 'left', h['page-prev'] ?? 0, st.page > 0);
          drawPageArrow(g, l.MG_PAGE_NEXT, 'right', h['page-next'] ?? 0, st.page < pages - 1);
          for (let i = 0; i < pages; i++) {
            g.beginPath();
            g.arc(s.w / 2 + (i - (pages - 1) / 2) * 26, l.MG_PAGE_DOTS_Y, i === st.page ? 7 : 5, 0, TAU);
            g.fillStyle = i === st.page ? '#ffffff' : 'rgba(255, 255, 255, 0.45)';
            g.fill();
          }
        }
      } else {
        const game = chosen();
        if (game) drawPreview(g, game, s.time, dialOf(game), h, press);
      }
      g.restore();
    },
  });

  // The preview: words on the left, the art on the right, the dial over Play.
  function drawPreview(g: CanvasRenderingContext2D, game: MinigameDefinition, time: number, count: PlayerCount, h: Record<string, number>, press: (id: string) => number) {
    const l = layoutRef.current;
    drawHeader(g, l.MG_BACK, 'MINIGAMES', h.back ?? 0);
    const x = l.MG_BACK.x - 38, w = l.MG_TEXT.w;
    g.font = `800 64px ${FONT}`;
    drawShadowText(g, ellipsize(g, game.title, w), x, l.MG_BACK.y + 84, { size: 64, weight: 800 });
    g.font = `700 28px ${FONT}`;
    drawShadowText(g, ellipsize(g, game.blurb, w), x + 2, l.MG_BACK.y + 138, { size: 28, color: '#d8f6ff' });
    g.save();
    g.shadowColor = 'rgba(0, 34, 84, 0.75)';
    g.shadowBlur = 5;
    g.shadowOffsetY = 2;
    paragraph(g, game.description, x + 2, l.MG_BACK.y + 200, w, { size: 24, color: '#ffffff', lineH: 33 });
    g.restore();
    // The best for this many players.
    const best = minigameBest(game.id, count);
    const counts = [...game.players].sort((a, b) => a - b);
    drawShadowText(g, best ? `Best ${fmt(game, best.score)} with ${COUNT_NAMES[count - 1].toLowerCase()}` : `No best yet with ${COUNT_NAMES[count - 1].toLowerCase()}`,
      x + 2, l.MG_MINUS.y - 72, { size: 22, weight: 700, color: best ? '#fff2bf' : '#bff4ff' });
    // The players dial (just the count when the game plays with one only).
    drawCaps(g, 'PLAYERS', x + 2, l.MG_MINUS.y, { size: 20 });
    if (counts.length > 1) {
      drawDialStep(g, l.MG_MINUS, false, h.minus ?? 0, press('minus'), count > counts[0]);
      drawDialStep(g, l.MG_PLUS, true, h.plus ?? 0, press('plus'), count < counts.at(-1)!);
    }
    drawDialCount(g, count, l.MG_COUNT_X, l.MG_MINUS.y, 96);
    drawGlassButton(g, l.MG_PLAY, { label: 'Play', sub: COUNT_NAMES[count - 1], icon: 'play', hover: h.play ?? 0, press: press('play'), chevron: false });
    // The art, large, in its glass, and what it plays with under it.
    const art = l.MG_ART;
    drawDarkGlassPanel(g, art, 34);
    const inner = { x: art.x + 14, y: art.y + 14, w: art.w - 28, h: art.h - 28 };
    g.save();
    roundRect(g, inner.x, inner.y, inner.w, inner.h, 24);
    g.clip();
    game.art(g, inner, time);
    g.restore();
    const facts = [playersLabel(game.players), game.durationMs ? `${Math.round(game.durationMs / 1000)} seconds` : null].filter(Boolean).join(' · ');
    drawShadowText(g, facts, art.x + art.w / 2, art.y + art.h + 36, { size: 22, weight: 700, align: 'center', color: '#bff4ff' });
  }

  // Frosted glass in the tiles, and the preview's art panel and Play.
  useGlassBlur(() => {
    const l = layoutRef.current;
    const panes = st.screen === 'list'
      ? onPage().map((game, i) => ({ ...buttonPane(ui, `game-${game.id}`, l.mgTile(i)), corner: TILE_CORNER }))
      : [panelPane(l.MG_ART), buttonPane(ui, 'play', l.MG_PLAY)];
    return { panes, alpha: st.alpha * st.swap, offsetX: (1 - st.swap) * -24 };
  });

  // Opening the list lands on it (or on the game just played, with its players), focusing that game's tile or Play.
  useEffect(() => {
    if (!visible) return;
    const game = open ? MINIGAMES.find((g) => g.id === open.id) : null;
    if (game && open) {
      st.chosen = game.id;
      st.dial.set(game.id, open.players);
      st.page = Math.floor(MINIGAMES.indexOf(game) / MG_PER_PAGE);
    }
    st.screen = st.next = game ? 'preview' : 'list';
    st.swap = 1;
    if (ui.keyboard) ui.focus(game ? { id: 'play', rect: layoutRef.current.MG_PLAY } : null);
    ui.invalidate();
  }, [visible, open, st, ui]);

  return null;
}
