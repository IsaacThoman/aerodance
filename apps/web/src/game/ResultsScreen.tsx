import { useRef } from 'react';
import { useThree } from '@react-three/fiber';
import {
  FONT, drawCaps, drawDarkGlassPanel, drawGlassButton, drawHeadline as headline, drawShadowText, ellipsize, glassCorner,
} from '../ui/draw.ts';
import type { Face, IconName, Rect } from '../ui/draw.ts';
import useCanvasUI from '../ui/useCanvasUI.ts';
import useGlassBlur, { buttonPane, panelPane } from '../ui/useGlassBlur.ts';
import { PLAYERS, REVEAL, backOut, clamp01, ranking, resultsTag, timeline } from './results.ts';
import type { ResultsShow } from './results.ts';
import { RESULTS_BOARD, resultsBoard, resultsRetry, resultsSongs } from './layout.ts';
import type { RefObject } from 'react';
import type { Song } from '../../../../packages/pose/song.ts';
import type { Grade } from '../../../../packages/score/scorer.ts';

export interface ResultsScreenProps {
  visible?: boolean;
  /** The reveal, once the song has finished (App sets it on results). */
  show: RefObject<ResultsShow | null>;
  song?: Song;
  onRetry?: () => void;
  onQuit?: () => void;
}

const GOLD: Face = ['#fff6cc', '#ffd34d', '#f0a500'];
// NEW BEST! in the S grade's soft champagne, not the brighter gold.
const CHAMPAGNE: Face = ['#fffaf0', '#f3e2a6', '#c9a85a'];
const BOARD_CORNER = 34;
// The grades are the board's only colour, pale enough to sit on its blue glass.
const GRADE_INK: Record<Grade, string> = { S: '#f3e2a6', A: '#6ef0a0', B: '#7fd4ff', C: '#d6b0ff', F: '#ff9ab8' };
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

// The scoreboard down the left: the winner (or the solo dancer) large on top with their grade,
// then everyone else in finishing order, or a solo round's judgements. Names, scores and the
// rules are white; only the grades are coloured. Scores count up, and the grades come in as
// the count finishes.
function drawBoard(g: CanvasRenderingContext2D, show: ResultsShow, t: number, count: number) {
  const { results } = show;
  const order = ranking(results);
  const board = resultsBoard(results.length);
  const { x, y, w } = board;
  const { top, row } = RESULTS_BOARD;
  const graded = clamp01((t - REVEAL + 0.2) / 0.4);
  drawDarkGlassPanel(g, board, BOARD_CORNER);
  const rule = (ry: number) => { g.fillStyle = 'rgba(255,255,255,0.28)'; g.fillRect(x + 28, ry, w - 56, 2); };
  const grade = (r: ResultsShow['results'][number], gx: number, gy: number, size: number) => {
    g.save();
    g.globalAlpha *= graded;
    drawShadowText(g, r.grade, gx, gy, { size, weight: 800, align: 'center', color: GRADE_INK[r.grade] });
    g.restore();
  };

  const first = results[order[0]];
  g.font = `700 24px ${FONT}`;
  drawShadowText(g, ellipsize(g, first.name, w - 200), x + 34, y + 42, { size: 24, weight: 700 });
  drawShadowText(g, fmt(first.score * count), x + 30, y + 98, { size: 64, weight: 800 });
  grade(first, x + w - 70, y + 82, 84);
  rule(y + top - 1);

  if (results.length === 1) {
    const j = first.judgements;
    const stats: [string, number][] = [['Perfect', j.perfect], ['Good', j.good], ['OK', j.ok], ['Miss', j.miss + j.lost], ['Combo', first.maxCombo]];
    const cw = (w - 20) / stats.length;
    g.save();
    g.globalAlpha *= graded;
    stats.forEach(([label, n], k) => {
      const cx = x + 10 + cw * (k + 0.5);
      drawShadowText(g, String(n), cx, y + top + 36, { size: 34, weight: 800, align: 'center' });
      drawShadowText(g, label, cx, y + top + 70, { size: 21, weight: 700, align: 'center', alpha: 0.85 });
    });
    g.restore();
    return;
  }
  order.slice(1).forEach((seat, k) => {
    const r = results[seat];
    const cy = y + top + k * row + row / 2 + 4;
    if (k > 0) rule(cy - row / 2);
    g.font = `800 24px ${FONT}`;
    drawShadowText(g, ellipsize(g, r.name, w - 300), x + 34, cy, { size: 24, weight: 800 });
    grade(r, x + w - 200, cy, 28);
    drawShadowText(g, fmt(r.score * count), x + w - 32, cy, { size: 28, weight: 800, align: 'right' });
  });
}

function drawResults(g: CanvasRenderingContext2D, show: ResultsShow, now: number, song: Song, width: number) {
  const { results, winner } = show;
  const { t, count, reveal } = timeline(show, now);
  const solo = results.length === 1;
  let title;
  let face: Face = ['#ffffff', '#ffffff', '#d5f3ff'];
  let pop = 1;
  if (solo) title = 'SONG COMPLETE!';
  else if (t < REVEAL) title = 'And the winner is…';
  else {
    pop = backOut(clamp01((t - REVEAL) / 0.32));
    if (winner === null) { title = "IT'S A TIE!"; face = GOLD; }
    else { const p = PLAYERS[winner % PLAYERS.length]; title = `${results[winner].name.toUpperCase()} WINS!`; face = ['#ffffff', p.light, p.color]; }
  }
  g.save();
  g.translate(width / 2, 116);
  g.scale(pop, pop);
  headline(g, title, 0, 0, t < REVEAL && !solo ? 70 : 96, face, width - 120);
  g.restore();
  g.font = `600 24px ${FONT}`;
  drawShadowText(g, ellipsize(g, [song.title, song.artist].filter(Boolean).join(' · '), width - 160), width / 2, 172, { size: 24, weight: 600, align: 'center' });

  drawBoard(g, show, t, count);

  // The featured dancer's name under them on the stage, and a best score under that.
  if (!resultsTag.visible) return;
  const featured = solo ? 0 : winner;
  if (featured === null) return;
  const tx = resultsTag.x * width;
  const ty = resultsTag.y * 900 + 26;
  g.save();
  g.globalAlpha *= solo ? 1 : reveal;
  drawCaps(g, results[featured].name.toUpperCase(), tx, ty, { size: 24, align: 'center' });
  g.restore();
  if (show.best?.isNewBest) {
    g.save();
    g.globalAlpha *= clamp01((t - REVEAL - 0.3) / 0.4);
    headline(g, 'NEW BEST!', tx, ty + 56, 40, CHAMPAGNE, 420);
    g.restore();
  } else if (show.best?.best) {
    drawShadowText(g, `Best ${fmt(show.best.best.score)} (${show.best.best.grade})`, tx, ty + 40, { size: 22, weight: 700, align: 'center', color: '#bff4ff' });
  }
}

/** The song's stage celebration: the scoreboard on the left, the winner (or the solo dancer) on the stage. */
export default function ResultsScreen({ visible = false, show, song, onRetry, onQuit }: ResultsScreenProps) {
  const gl = useThree((state) => state.gl);
  const props = useRef({ visible, show, song, onRetry, onQuit });
  props.current = { visible, show, song, onRetry, onQuit };
  const st = useRef({ alpha: 0 }).current;
  const live = () => props.current.visible && !!props.current.show.current;
  // The board, and the buttons under it, grow with the player count.
  const players = () => props.current.show.current?.results.length ?? 2;
  const retry = () => resultsRetry(players());
  const songs = () => resultsSongs(players());

  const ui = useCanvasUI({
    priority: 2.5,
    active: live,
    keyNav: true,
    // No primary widget: a stray Enter as the song ends mustn't skip the celebration.
    widgets: () => [
      { id: 'retry', rect: retry(), corner: glassCorner(RESULTS_BOARD.buttonH) },
      { id: 'quit', rect: songs(), corner: glassCorner(RESULTS_BOARD.buttonH) },
    ],
    onActivate: ({ id }) => {
      const p = props.current;
      if (id === 'retry') p.onRetry?.();
      else if (id === 'quit') p.onQuit?.();
    },
    onKey: (e) => {
      if (!live() || e.repeat || e.key !== 'Escape') return;
      props.current.onQuit?.();
      e.preventDefault();
    },
    update: (_, s) => {
      const p = props.current;
      // Gameplay already showed an opaque overlay: results and their controls must be
      // ready together, including a Play again click on the very first results frame.
      st.alpha = p.visible ? 1 : s.ease(st.alpha, 0, 8);
      // The winner's name follows them on the stage (a live dancer moves), so keep drawing.
      if (p.visible) s.invalidate();
      if (p.visible && p.show.current) {
        Object.assign(gl.domElement.dataset, {
          resultsScreen: 'stage',
          resultsWinner: String(p.show.current.winner),
        });
      } else {
        for (const key of ['resultsScreen', 'resultsWinner']) delete gl.domElement.dataset[key];
      }
    },
    opacity: () => st.alpha,
    draw: (g, s) => {
      const p = props.current;
      if (!p.show.current || !p.song) return;
      drawResults(g, p.show.current, performance.now() / 1000, p.song, s.w);
      const button = (id: string, rect: Rect, label: string, icon: IconName) => drawGlassButton(g, rect, {
        label, icon, hover: s.hover[id] ?? 0, press: s.press * (s.hover[id] ?? 0),
      });
      button('retry', retry(), 'Play again', 'replay');
      button('quit', songs(), 'Song select', 'list');
    },
  });
  // Frosted glass inside the board and its two buttons (ui/useGlassBlur.ts), just before the overlay draws.
  useGlassBlur(() => ({
    panes: props.current.show.current && props.current.song
      ? [panelPane(resultsBoard(players()), BOARD_CORNER), buttonPane(ui, 'retry', retry()), buttonPane(ui, 'quit', songs())]
      : [],
    alpha: st.alpha,
  }), { priority: 2.4 });
  return null;
}
