import { useRef } from 'react';
import { useThree } from '@react-three/fiber';
import {
  FONT, drawCaps, drawHeadline as headline, drawPill, drawShadowText, ellipsize,
} from '../ui/draw.ts';
import type { Face, IconName, Rect } from '../ui/draw.ts';
import useCanvasUI from '../ui/useCanvasUI.ts';
import { PLAYERS, REVEAL, backOut, clamp01, timeline } from './results.ts';
import type { ResultsShow } from './results.ts';
import { RESULTS_RETRY, RESULTS_SONGS } from './layout.ts';
import type { RefObject } from 'react';
import type { Song } from '../../../packages/pose/song.ts';

export interface ResultsScreenProps {
  visible?: boolean;
  /** The reveal, once the song has finished (App sets it on results). */
  show: RefObject<ResultsShow | null>;
  song?: Song;
  onRetry?: () => void;
  onQuit?: () => void;
}

const GOLD: Face = ['#fff6cc', '#ffd34d', '#f0a500'];
const pct = (x: number) => `${Math.round(x * 100)}%`;

function drawResults(g: CanvasRenderingContext2D, show: ResultsShow, now: number, song: Song) {
  const { results, winner, leaders } = show;
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
  g.translate(800, 116);
  g.scale(pop, pop);
  headline(g, title, 0, 0, t < REVEAL && !solo ? 70 : 96, face, 1200);
  g.restore();
  g.font = `600 24px ${FONT}`;
  drawShadowText(g, ellipsize(g, [song.title, song.artist].filter(Boolean).join(' · '), 1100), 800, 172, { size: 24, weight: 600, align: 'center' });

  // One score centred, two side by side, or three or four in narrower columns.
  const crowd = results.length > 2;
  const column = crowd ? 1600 / (results.length + 0.5) : 600;
  results.forEach((r, i) => {
    const x = 800 + (i - (results.length - 1) / 2) * column;
    const p = PLAYERS[i % PLAYERS.length];
    const win = !solo && winner === i;
    // With three or four players a tie can leave others behind: they fade like a loser.
    const lose = !solo && !leaders.includes(i);
    g.save();
    g.globalAlpha *= lose ? 1 - 0.2 * reveal : 1;
    const status = solo ? 'FINAL SCORE' : winner === null && leaders.includes(i) && t >= REVEAL ? 'TIED' : null;
    if (status) drawCaps(g, status, x, 590, { size: 20, align: 'center' });
    g.font = `800 22px ${FONT}`;
    drawCaps(g, ellipsize(g, r.name.toUpperCase(), Math.min(350, column - 40)), x, 625, { size: 22, align: 'center' });
    const grow = win ? 0.12 * backOut(clamp01((t - REVEAL) / 0.32)) : 0;
    g.save();
    g.translate(x, 700);
    g.scale(1 + grow, 1 + grow);
    headline(g, Math.round(r.score * count).toLocaleString('en-US'), 0, 0, crowd ? 62 : 78, win && reveal > 0 ? GOLD : ['#ffffff', p.light, p.color], Math.min(520, column - 40));
    g.restore();
    // Grade, accuracy and judgements once the count finishes.
    g.globalAlpha *= clamp01((t - REVEAL + 0.2) / 0.4);
    const j = r.judgements;
    drawShadowText(g, `Grade ${r.grade} · ${pct(r.accuracy)}`, x, crowd ? 738 : 742, { size: crowd ? 22 : 24, weight: 800, align: 'center' });
    const counts = `${j.perfect} Perfect · ${j.good} Good · ${j.ok} OK · ${j.miss + j.lost} Miss`;
    const combo = `combo ${r.maxCombo}`;
    const size = crowd ? 17 : 19;
    const width = Math.min(560, column - 30);
    g.font = `700 ${size}px ${FONT}`;
    // Narrow columns put the max combo on a line of its own, or after OK and Miss when a long
    // song's counts don't fit on one.
    const lines = !crowd ? [`${counts} · ${combo}`]
      : g.measureText(counts).width <= width ? [counts, combo]
      : [`${j.perfect} Perfect · ${j.good} Good`, `${j.ok} OK · ${j.miss + j.lost} Miss · ${combo}`];
    lines.forEach((line, k) => drawShadowText(g, ellipsize(g, line, width), x, (crowd ? 762 : 770) + k * 21, { size, weight: 700, align: 'center', color: '#e6f8ff' }));
    if (r.coverage < 0.8) drawShadowText(g, `Tracked for ${pct(r.coverage)} of the song`, x, 560, { size: 19, weight: 700, align: 'center', color: '#ffe27a' });
    g.restore();
  });
  if (show.best?.isNewBest) {
    g.save();
    g.globalAlpha *= clamp01((t - REVEAL - 0.3) / 0.4);
    headline(g, 'NEW BEST!', 800, 232, 40, GOLD, 600);
    g.restore();
  } else if (show.best?.best) {
    drawShadowText(g, `Best ${show.best.best.score.toLocaleString('en-US')} (${show.best.best.grade})`, 800, 222, { size: 22, weight: 700, align: 'center', color: '#bff4ff' });
  }
}

/** The song's stage celebration: the winner (or the solo score), grades and a new best. */
export default function ResultsScreen({ visible = false, show, song, onRetry, onQuit }: ResultsScreenProps) {
  const gl = useThree((state) => state.gl);
  const props = useRef({ visible, show, song, onRetry, onQuit });
  props.current = { visible, show, song, onRetry, onQuit };
  const st = useRef({ alpha: 0 }).current;
  const live = () => props.current.visible && !!props.current.show.current;

  useCanvasUI({
    priority: 2.5,
    active: live,
    keyNav: true,
    // No primary widget: a stray Enter as the song ends mustn't skip the celebration.
    widgets: () => [{ id: 'retry', rect: RESULTS_RETRY }, { id: 'quit', rect: RESULTS_SONGS }],
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
      // The reveal and score count animate; after them the picture holds still (the buttons'
      // hover still redraws it).
      if (p.visible && (!p.show.current || timeline(p.show.current, performance.now() / 1000).t < REVEAL + 1)) s.invalidate();
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
      drawResults(g, p.show.current, performance.now() / 1000, p.song);
      const button = (id: string, rect: Rect, label: string, icon: IconName) => drawPill(g, rect, {
        label, icon, hover: s.hover[id] ?? 0, press: s.press * (s.hover[id] ?? 0),
      });
      button('retry', RESULTS_RETRY, 'Play again', 'replay');
      button('quit', RESULTS_SONGS, 'Song select', 'list');
    },
  });
  return null;
}
