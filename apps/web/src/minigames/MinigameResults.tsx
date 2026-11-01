import { useRef } from 'react';
import { useThree } from '@react-three/fiber';
import { FONT, drawDarkGlassPanel, drawGlassButton, drawHeadline as headline, drawShadowText, ellipsize, glassCorner } from '../ui/draw.ts';
import type { Face, IconName, Rect } from '../ui/draw.ts';
import useCanvasUI from '../ui/useCanvasUI.ts';
import useGlassBlur, { buttonPane, panelPane } from '../ui/useGlassBlur.ts';
import { displayDesign } from '../display.ts';
import { PLAYERS, backOut, clamp01, easeOut } from '../game/results.ts';
import { topScore } from './bestScores.ts';
import type { MinigameBestRecord } from './bestScores.ts';
import { minigameLayout } from './layout.ts';
import { formatScore } from './definition.ts';
import type { MinigameDefinition } from './types.ts';

/*
 * A minigame round's results, shared by every game: the winner (or the solo player's score, or a
 * co-op team's) in
 * the song results' headline style, a scoreboard with everyone in finishing order (scores count
 * up, formatted the game's way: ScoreFormat), NEW BEST! when the top score beat this game's best
 * for this many players (bestScores.ts), then Play again and Minigames. Escape goes to Minigames.
 * The game's scene stays behind it.
 *
 * The canvas reports data-minigame-results (shown), -minigame-winner (the winning player from 0,
 * '' for a tie or a solo round) and -minigame-new-best for tests.
 *
 * <MinigameResults visible show={showRef} onRetry onQuit />
 */

/** A round's results, as App hands them over when the session reaches results. */
export interface MinigameResultsShow {
  key: string;
  game: MinigameDefinition;
  scores: number[];
  /** Seconds on the performance.now() clock when the reveal starts. */
  start: number;
  best: MinigameBestRecord;
}
export interface MinigameResultsProps {
  visible?: boolean;
  show: { current: MinigameResultsShow | null };
  onRetry?: () => void;
  onQuit?: () => void;
}

const GOLD: Face = ['#fff6cc', '#ffd34d', '#f0a500'];
const CHAMPAGNE: Face = ['#fffaf0', '#f3e2a6', '#c9a85a'];
// Scores count up over this long, then the winner is announced.
const COUNT_S = [0.4, 1.5] as const;

/** Players in finishing order, best first (ties in player order). */
export function finishingOrder(scores: readonly number[], better: 'higher' | 'lower' = 'higher') {
  return scores.map((_, i) => i).sort((a, b) => (better === 'lower' ? scores[a] - scores[b] : scores[b] - scores[a]) || a - b);
}
/** The scores the board shows: a co-op game's players are one team, with the team's score. */
export function resultSeats(game: Pick<MinigameDefinition, 'coop' | 'score'>, scores: readonly number[]) {
  return game.coop && scores.length > 1 ? [topScore(scores, game.score?.better)] : scores;
}
/** The single winner, or null for a tie or a solo round. */
export function minigameWinner(scores: readonly number[], better: 'higher' | 'lower' = 'higher') {
  if (scores.length < 2) return null;
  const [first, second] = finishingOrder(scores, better);
  return scores[first] === scores[second] ? null : first;
}

export default function MinigameResults({ visible = false, show, onRetry, onQuit }: MinigameResultsProps) {
  const gl = useThree((state) => state.gl);
  const size = useThree((state) => state.size);
  const layout = minigameLayout(displayDesign(size.width, size.height).w);
  const props = useRef({ visible, show, onRetry, onQuit, layout });
  props.current = { visible, show, onRetry, onQuit, layout };
  const st = useRef({ alpha: 0 }).current;
  const live = () => props.current.visible && !!props.current.show.current;
  const players = () => { const shown = props.current.show.current; return shown ? resultSeats(shown.game, shown.scores).length : 1; };

  const ui = useCanvasUI({
    priority: 2.5,
    active: live,
    keyNav: true,
    // No primary widget: a stray Enter as the round ends mustn't skip the results.
    widgets: () => [
      { id: 'retry', rect: props.current.layout.mgResultsRetry(players()), corner: glassCorner(84) },
      { id: 'quit', rect: props.current.layout.mgResultsQuit(players()), corner: glassCorner(84) },
    ],
    onActivate: ({ id }) => {
      if (id === 'retry') props.current.onRetry?.();
      else if (id === 'quit') props.current.onQuit?.();
    },
    onKey: (e) => {
      if (!live() || e.repeat || e.key !== 'Escape') return;
      props.current.onQuit?.();
      e.preventDefault();
    },
    update: (_, s) => {
      const p = props.current, shown = p.show.current;
      st.alpha = p.visible ? s.ease(st.alpha, 1, 6) : s.ease(st.alpha, 0, 8);
      if (p.visible) s.invalidate();
      const { dataset } = gl.domElement;
      if (p.visible && shown) {
        const winner = minigameWinner(resultSeats(shown.game, shown.scores), shown.game.score?.better);
        Object.assign(dataset, { minigameResults: 'shown', minigameWinner: winner === null ? '' : String(winner), minigameNewBest: String(shown.best.isNewBest) });
      } else for (const key of ['minigameResults', 'minigameWinner', 'minigameNewBest']) delete dataset[key];
    },
    opacity: () => st.alpha,
    draw: (g, s) => {
      const shown = props.current.show.current;
      if (!shown) return;
      drawBoard(g, shown, s.w, props.current.layout);
      const button = (id: string, rect: Rect, label: string, icon: IconName) => drawGlassButton(g, rect, { label, icon, hover: s.hover[id] ?? 0, press: s.press * (s.hover[id] ?? 0) });
      button('retry', props.current.layout.mgResultsRetry(players()), 'Play again', 'replay');
      button('quit', props.current.layout.mgResultsQuit(players()), 'Minigames', 'bubbles');
    },
  });

  useGlassBlur(() => {
    const { layout: l, show: shown } = props.current;
    return {
      panes: shown.current ? [panelPane(l.mgResultsBoard(players()), 34), buttonPane(ui, 'retry', l.mgResultsRetry(players())), buttonPane(ui, 'quit', l.mgResultsQuit(players()))] : [],
      alpha: st.alpha,
    };
  }, { priority: 2.4 });
  return null;
}

// The headline, then the board: the top player large, everyone else a row each.
function drawBoard(g: CanvasRenderingContext2D, show: MinigameResultsShow, width: number, layout: ReturnType<typeof minigameLayout>) {
  const { game } = show;
  const scores = resultSeats(game, show.scores), team = scores.length < show.scores.length;
  const better = game.score?.better ?? 'higher';
  const t = performance.now() / 1000 - show.start;
  const count = easeOut(clamp01((t - COUNT_S[0]) / (COUNT_S[1] - COUNT_S[0])));
  const revealed = t >= COUNT_S[1];
  const winner = minigameWinner(scores, better);
  const order = finishingOrder(scores, better);
  // Counting up from nothing, or (lower is better) down from the worst.
  const shownScore = (score: number) => (better === 'lower' ? score : score * count);

  let title = scores.length === 1 ? 'WELL PLAYED!' : 'And the winner is…', face: Face = ['#ffffff', '#ffffff', '#d5f3ff'], pop = 1;
  if (scores.length > 1 && revealed) {
    pop = backOut(clamp01((t - COUNT_S[1]) / 0.32));
    if (winner === null) { title = "IT'S A TIE!"; face = GOLD; }
    else { const p = PLAYERS[winner]; title = `${p.name.toUpperCase()} WINS!`; face = ['#ffffff', p.light, p.color]; }
  }
  g.save();
  g.translate(width / 2, 116);
  g.scale(pop, pop);
  headline(g, title, 0, 0, scores.length > 1 && !revealed ? 70 : 96, face, width - 120);
  g.restore();
  g.font = `600 24px ${FONT}`;
  drawShadowText(g, ellipsize(g, game.title, width - 160), width / 2, 172, { size: 24, weight: 600, align: 'center' });

  const board = layout.mgResultsBoard(scores.length);
  drawDarkGlassPanel(g, board, 34);
  const first = order[0], p = PLAYERS[first];
  drawShadowText(g, team ? 'Your team' : scores.length === 1 ? 'Your score' : p.name, board.x + 34, board.y + 42, { size: 24, weight: 700 });
  headline(g, formatScore(game, shownScore(scores[first]), { unit: true }), board.x + board.w / 2, board.y + 118, 64, ['#ffffff', p.light, p.color], board.w - 80);
  // A new best beside the top score once it has counted up, or the best to beat.
  g.save();
  g.globalAlpha *= clamp01((t - COUNT_S[1]) / 0.4);
  if (show.best.isNewBest) headline(g, 'NEW BEST!', board.x + board.w - 120, board.y + 52, 30, CHAMPAGNE, 220);
  else if (show.best.best) drawShadowText(g, `Best ${formatScore(game, show.best.best.score, { unit: true })}`, board.x + board.w - 34, board.y + 42, { size: 22, weight: 700, align: 'right', color: '#bff4ff' });
  g.restore();
  order.slice(1).forEach((seat, k) => {
    const cy = board.y + 150 + k * 72 + 36 + 4;
    g.fillStyle = 'rgba(255,255,255,0.28)';
    g.fillRect(board.x + 28, cy - 37, board.w - 56, 2);
    drawShadowText(g, PLAYERS[seat].name, board.x + 34, cy, { size: 26, weight: 800, color: PLAYERS[seat].light });
    drawShadowText(g, formatScore(game, shownScore(scores[seat]), { unit: true }), board.x + board.w - 34, cy, { size: 30, weight: 800, align: 'right' });
  });
}
