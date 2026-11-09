import { useEffect, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  FONT, ICONS, drawCaps, drawDarkGlassPanel, drawDisc, drawGlassButton, drawHeader, drawHeadline as headline, drawProgress, drawShadowText,
  ellipsize, glassCorner, wrapText,
} from '../ui/draw.ts';
import type { Face } from '../ui/draw.ts';
import useCanvasUI from '../ui/useCanvasUI.ts';
import useGlassBlur, { buttonPane, panelPane } from '../ui/useGlassBlur.ts';
import { CameraSetup, cameraWidgets } from '../connect/cameraSetup.ts';
import type { CameraWidget } from '../connect/cameraSetup.ts';
import { drawCalibration, drawCameraInterrupted } from '../game/calibrationCard.ts';
import { gameLayout, PLAYER_HUD_TOP, playerHudX } from '../game/layout.ts';
import { PLAYERS, backOut, clamp01 } from '../game/results.ts';
import { watchInterruptions } from '../game/interruptions.ts';
import { getMixer } from '../audio/mixer.ts';
import type { CameraInput } from '../pose/CameraInput.ts';
import { displayDesign } from '../display.ts';
import { minigameLayout } from './layout.ts';
import { COUNTDOWN_MS, FINISH_MS, RAISE_START_MS } from './MinigameSession.ts';
import type { MinigameSession } from './MinigameSession.ts';
import { formatScore } from './definition.ts';
import type { MinigamePhase } from './types.ts';

/**
 * A minigame's host overlay, drawn in-engine over the game (which App mounts: MinigameView):
 *
 *   calibrating  the song game's camera setup card (game/calibrationCard.ts): the preview starts
 *                the camera, the arrows pick one, every player holds still for 2.5 seconds; No
 *                camera can't play a minigame, so the card asks for one
 *   howto        the game's how-to card, and Start, or a hand held up for a moment
 *   countdown    3, 2, 1, over the game (again after a pause)
 *   playing      the HUD: each player's score in the top corners (as in a song), the round's
 *                time left under the pause icon at the top centre, a nudge for anyone out of
 *                view; Escape, the pause icon, a hidden tab or an interruption (the audio taken
 *                for a call, the camera muted: game/interruptions.ts) pauses
 *   paused       Resume (counting down again), Restart and Minigames, and why the game can't go
 *                on yet: the camera is muted
 *   finishing    Time's up! (or Finish!), then MinigameResults takes over
 *   error        the game wouldn't load or crashed: say so, and go back
 *
 * It also drives the session each frame before the game's own frames (useFrame priority -1).
 * The canvas reports data-minigame-phase, -minigame-id, -minigame-ready, -minigame-players,
 * -minigame-scores, -minigame-time-ms, -minigame-remaining-ms, -minigame-countdown,
 * -minigame-present, -minigame-gesture (the last gesture seen: player:type[:direction][:hand]),
 * -minigame-raise (the how-to card's raise-to-start, 0-1), the camera's -minigame-camera-status,
 * -minigame-hands (ctx.handTracking(), for a game with `tracking: 'hands'`),
 * while calibrating -minigame-calibration-players / -progress, and the game's own data-mg-*.
 *
 * <MinigameScreen visible session={session} camera={source} onQuit onRetry />
 */

export interface MinigameScreenProps {
  visible?: boolean;
  session: MinigameSession | null;
  camera: CameraInput;
  onQuit?: () => void;
  onRetry?: () => void;
}

// The pause screen's veil over the game.
const VEIL = 0.35;
/** How long a player has to be out of view before the HUD tells them to step back in. */
const NUDGE_MS = 1500;
/** A timed round its game finishes this close to the end (to say how it ended) is time up too. */
const TIMES_UP_SLACK_MS = 250;
const READY_FACE: Face = ['#ffffff', '#7fd0ff', '#0a7fd8'];
const DATA_KEYS = ['minigamePhase', 'minigameId', 'minigameReady', 'minigamePlayers', 'minigameScores', 'minigameTimeMs', 'minigameRemainingMs',
  'minigameCountdown', 'minigamePresent', 'minigameGesture', 'minigameRaise', 'minigameCameraStatus', 'minigameHands', 'minigameCalibrationPlayers', 'minigameCalibrationProgress', 'minigameError'];

export default function MinigameScreen({ visible = false, session, camera: source, onQuit, onRetry }: MinigameScreenProps) {
  const gl = useThree((state) => state.gl);
  const size = useThree((state) => state.size);
  const width = displayDesign(size.width, size.height).w;
  const g16 = gameLayout(width);
  const mg = minigameLayout(width);
  const props = useRef({ visible, session, source, onQuit, onRetry });
  props.current = { visible, session, source, onQuit, onRetry };
  const layouts = useRef({ g16, mg });
  layouts.current = { g16, mg };
  const st = useRef({ alpha: 0, reported: '', screen: '' as string, session: null as MinigameSession | null, countdown: 0, dataKeys: new Set<string>() }).current;
  const [camera] = useState(() => new CameraSetup(() => ({ source: props.current.source, connection: props.current.source.view })));
  const phase = (): MinigamePhase => props.current.session?.phase() ?? 'loading';
  const live = () => !!props.current.visible && phase() !== 'results' && st.alpha > 0.3;
  // Played with the live camera (not a replay).
  const usesCamera = () => { const own = props.current.session?.source; return !!own && own.view.sourceKind !== 'replay'; };

  // The session moves first each frame: the game's frames (-0.5) see this frame's poses and phase.
  useFrame(() => {
    const p = props.current;
    if (p.visible && p.session) p.session.advance(performance.now());
  }, -1);

  const ui = useCanvasUI<CameraWidget>({
    priority: 2.3,
    active: live,
    keyNav: () => ['loading', 'calibrating', 'howto', 'paused', 'error'].includes(phase()),
    widgets: (): CameraWidget[] => {
      const { g16: G, mg: M } = layouts.current;
      const ph = phase();
      if (ph === 'calibrating') {
        const list: CameraWidget[] = [{ id: 'quit', circle: G.GAME_READY_BACK }];
        if (!camera.none() && !camera.active() && !camera.pairsItself()) list.push({ id: 'start-camera', rect: G.GAME_CALIBRATION_PREVIEW, primary: true });
        return [...list, ...cameraWidgets(G.GAME_CALIBRATION_CAMERA)];
      }
      if (ph === 'loading') return [{ id: 'quit', circle: G.GAME_READY_BACK }];
      if (ph === 'howto') return [{ id: 'quit', circle: G.GAME_READY_BACK }, { id: 'start', rect: M.MG_HOWTO_START, corner: glassCorner(M.MG_HOWTO_START.h), primary: true }];
      if (ph === 'error') return [{ id: 'quit', circle: G.GAME_READY_BACK }, { id: 'leave', rect: M.MG_HOWTO_START, corner: glassCorner(M.MG_HOWTO_START.h), primary: true }];
      if (ph === 'countdown' || ph === 'playing') return [{ id: 'pause', circle: G.GAME_PAUSE, nav: false }];
      if (ph === 'paused') {
        const corner = glassCorner(G.GAME_RESUME.h);
        return [{ id: 'resume', rect: G.GAME_RESUME, corner, primary: true }, { id: 'restart', rect: G.GAME_RESTART, corner }, { id: 'quit', rect: G.GAME_QUIT, corner }];
      }
      return [];
    },
    onActivate: (wdg, s) => {
      const p = props.current, session = p.session;
      if (wdg.id === 'start') session?.start();
      else if (wdg.id === 'pause') session?.pause();
      else if (wdg.id === 'resume') session?.resume();
      else if (wdg.id === 'restart') p.onRetry?.();
      else if (wdg.id === 'quit' || wdg.id === 'leave') p.onQuit?.();
      else if (wdg.id === 'start-camera') camera.start();
      else if (phase() === 'calibrating') camera.activate(wdg);
      s.invalidate();
    },
    onKey: (e, s) => {
      if (!live() || e.repeat || e.key !== 'Escape') return;
      const session = props.current.session, ph = phase();
      if (ph === 'countdown' || ph === 'playing') session?.pause();
      else if (ph === 'paused') session?.resume();
      else if (['loading', 'calibrating', 'howto', 'error'].includes(ph)) props.current.onQuit?.();
      else return;
      e.preventDefault();
      s.invalidate();
    },
    update: (_, s) => {
      const p = props.current;
      st.alpha = s.ease(st.alpha, p.visible ? 1 : 0, p.visible ? 4 : 8);
      const session = p.session;
      // Every screen starts without a keyboard cursor (one left on the camera preview mustn't land on Restart).
      const screen = !session ? '' : session.phase() === 'countdown' || session.phase() === 'playing' ? 'round' : session.phase();
      if (session !== st.session || screen !== st.screen) {
        st.session = session;
        st.screen = screen;
        if (s.keyFocus) s.focus(null);
      }
      if (!p.visible || !session) return;
      const now = performance.now();
      const ph = session.phase();
      if (ph === 'calibrating') camera.update();
      st.countdown = ph === 'countdown' ? Math.ceil((COUNTDOWN_MS - (now - session.countdownAt)) / 1000) : 0;
      s.invalidate();
      const calibration = ph === 'calibrating' ? session.calibrationStatus(now) : null;
      const last = session.lastGesture;
      const report: Record<string, string> = {
        minigamePhase: ph,
        minigameId: session.game.id,
        minigameReady: String(live()),
        minigamePlayers: String(session.playerCount),
        minigameScores: session.scores().join('|'),
        minigameTimeMs: String(Math.round(session.timeMs())),
        minigameRemainingMs: Number.isFinite(session.remainingMs()) ? String(Math.round(session.remainingMs())) : '',
        minigameCountdown: ph === 'countdown' ? String(st.countdown) : '',
        minigamePresent: session.presence(now).map((on) => (on ? 1 : 0)).join('|'),
        minigameGesture: last ? [last.player, last.type, last.direction, last.hand].filter((v) => v !== undefined).join(':') : '',
        minigameRaise: ph === 'howto' && session.raisedSince !== null ? clamp01((now - session.raisedSince) / RAISE_START_MS).toFixed(2) : '',
        minigameCameraStatus: p.source.view.status,
        minigameHands: session.handTracking() ?? '',
        minigameCalibrationPlayers: calibration?.players.join('|') ?? '',
        minigameCalibrationProgress: calibration ? calibration.progress.toFixed(3) : '',
        minigameError: session.error,
        ...session.reported,
      };
      const json = JSON.stringify(report);
      if (json !== st.reported) {
        st.reported = json;
        const { dataset } = gl.domElement;
        for (const key of st.dataKeys) if (!(key in report)) delete dataset[key];
        st.dataKeys = new Set(Object.keys(report));
        Object.assign(dataset, report);
      }
    },
    opacity: () => st.alpha,
    draw: (g, s) => {
      const session = props.current.session;
      if (!session) return;
      const { g16: G, mg: M } = layouts.current;
      const h = s.hover;
      const press = (id: string) => s.press * (h[id] ?? 0);
      const ph = session.phase();
      const now = performance.now();
      const game = session.game;

      if (ph === 'calibrating') {
        const calibration = session.calibrationStatus(now);
        if (calibration) drawCalibration(g, session, calibration, camera, s, { title: game.title.toUpperCase(), withoutCamera: false, feet: !!game.fullBody });
        return;
      }
      if (ph === 'loading' || ph === 'error') {
        drawHeader(g, G.GAME_READY_BACK, 'EXPERIMENTS', h.quit ?? 0);
        g.font = `800 64px ${FONT}`;
        drawShadowText(g, ellipsize(g, game.title, s.w - 200), G.GAME_READY_BACK.x - 38, 270, { size: 64, weight: 800 });
        if (ph === 'loading') drawShadowText(g, `Loading${'.'.repeat(1 + (Math.floor(s.time * 3) % 3))}`, s.w / 2, 520, { size: 34, align: 'center' });
        else {
          g.font = `700 28px ${FONT}`;
          drawShadowText(g, ellipsize(g, session.error, s.w - 160), s.w / 2, 500, { size: 28, align: 'center', color: '#ffb38a' });
          drawGlassButton(g, M.MG_HOWTO_START, { label: 'Experiments', icon: 'list', hover: h.leave ?? 0, press: press('leave') });
        }
        return;
      }
      if (ph === 'howto') {
        drawHowTo(g, session, s.w, h, press, now);
        return;
      }
      if (ph === 'results') return; // MinigameResults has the screen.

      // The round: the HUD, then the countdown, Time's up or the pause screen over it.
      drawHud(g, session, s.w, now, ph === 'paused' ? 0 : h.pause ?? 0, ph !== 'paused');
      if (ph === 'countdown') {
        const left = COUNTDOWN_MS - (now - session.countdownAt);
        const n = Math.ceil(left / 1000);
        if (n > 0 && n <= COUNTDOWN_MS / 1000) {
          const into = 1 - (left / 1000 - (n - 1));
          g.save();
          g.translate(s.w / 2, 470);
          const k = backOut(clamp01(into / 0.3));
          g.scale(k, k);
          g.globalAlpha *= 1 - clamp01((into - 0.75) / 0.25);
          headline(g, String(n), 0, 70, 220, READY_FACE, 400);
          g.restore();
        }
        if (session.timeMs() > 0) drawShadowText(g, 'Get ready to carry on', s.w / 2, 640, { size: 26, weight: 700, align: 'center' });
      } else if (ph === 'finishing') {
        const k = backOut(clamp01((now - (session.finishAt ?? now) + FINISH_MS) / 300));
        g.save();
        g.translate(s.w / 2, 470);
        g.scale(k, k);
        headline(g, (game.durationMs && session.remainingMs() <= TIMES_UP_SLACK_MS) || session.outcome?.timeUp ? "TIME'S UP!" : 'FINISH!', 0, 30, 120, ['#fff6cc', '#ffd34d', '#f0a500'], s.w - 120);
        g.restore();
      } else if (ph === 'paused') {
        g.save();
        g.fillStyle = `rgba(0, 24, 60, ${VEIL})`;
        g.fillRect(0, 0, s.w, s.h);
        g.restore();
        drawDarkGlassPanel(g, G.GAME_PAUSE_PANEL, 34);
        drawCaps(g, 'PAUSED', s.w / 2, G.GAME_PAUSE_PANEL.y + 46, { size: 30, align: 'center' });
        drawGlassButton(g, G.GAME_RESUME, { label: 'Resume', icon: 'play', hover: h.resume ?? 0, press: press('resume') });
        drawGlassButton(g, G.GAME_RESTART, { label: 'Restart', icon: 'replay', hover: h.restart ?? 0, press: press('restart') });
        drawGlassButton(g, G.GAME_QUIT, { label: 'Experiments', icon: 'list', hover: h.quit ?? 0, press: press('quit') });
        const y = G.GAME_PAUSE_PANEL.y + G.GAME_PAUSE_PANEL.h + 44;
        if (usesCamera() && camera.interrupted()) drawCameraInterrupted(g, camera, props.current.source.view.status, y, s.w);
      }
    },
  });

  // The how-to card: the game's steps, each with its picture, then raise a hand or press Start.
  function drawHowTo(g: CanvasRenderingContext2D, session: MinigameSession, w: number, h: Record<string, number>, press: (id: string) => number, now: number) {
    const { g16: G, mg: M } = layouts.current;
    const card = M.MG_HOWTO, game = session.game;
    drawHeader(g, G.GAME_READY_BACK, game.title.toUpperCase(), h.quit ?? 0);
    drawDarkGlassPanel(g, card, 34);
    drawCaps(g, 'HOW TO PLAY', w / 2, card.y + 46, { size: 24, align: 'center' });
    const steps = game.howTo.slice(0, 4);
    const rowH = Math.min(96, (card.h - 250) / steps.length);
    steps.forEach((step, i) => {
      const cy = card.y + 110 + rowH * (i + 0.5);
      const cx = card.x + 86;
      drawDisc(g, cx, cy, 32);
      g.save();
      g.strokeStyle = '#ffffff';
      g.fillStyle = '#ffffff';
      g.lineWidth = 5;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      if (typeof step.icon === 'function') step.icon(g, cx, cy, 32);
      else if (step.icon === 'gear') ICONS.gear(g, cx, cy, 32);
      else ICONS[step.icon ?? 'play'](g, cx, cy, 32);
      g.restore();
      g.font = `700 26px ${FONT}`;
      const lines = wrapText(g, step.text, card.w - 190).slice(0, 2);
      lines.forEach((line, k) => drawShadowText(g, line, cx + 58, cy + (k - (lines.length - 1) / 2) * 32, { size: 26, weight: 700 }));
    });
    // Who's in view, then the way to start.
    const presence = session.presence(now);
    const missing = presence.flatMap((on, id) => (on ? [] : [`P${id + 1}`]));
    const raise = session.raisedSince === null ? 0 : clamp01((now - session.raisedSince) / RAISE_START_MS);
    const hint = missing.length ? `${missing.join(', ')}: step into view` : 'Raise a hand to start, or press Start';
    drawShadowText(g, hint, w / 2, M.MG_HOWTO_START.y - 34, { size: 22, weight: 700, align: 'center', color: missing.length ? '#ffe27a' : '#bff4ff' });
    if (raise > 0) drawProgress(g, { x: M.MG_HOWTO_START.x + 30, y: M.MG_HOWTO_START.y - 16, w: M.MG_HOWTO_START.w - 60, h: 8 }, raise);
    drawGlassButton(g, M.MG_HOWTO_START, { label: 'Start', icon: 'play', sub: `${session.playerCount} player${session.playerCount > 1 ? 's' : ''}`, hover: h.start ?? 0, press: press('start') });
  }

  // The HUD: each player's score in the top corners, the time left under the pause icon.
  function drawHud(g: CanvasRenderingContext2D, session: MinigameSession, w: number, now: number, pauseHover: number, pauseIcon: boolean) {
    const { g16: G, mg: M } = layouts.current;
    const game = session.game, count = session.playerCount;
    // A few dropped frames (a blurred arm, a slow phone) mustn't flash "Step back" at a player standing in view.
    const presence = session.presence(now, NUDGE_MS);
    if (game.hud?.scores !== false) {
      const crowd = count > 2;
      session.scores().forEach((score, id) => {
        const cx = playerHudX(id, count, w) * w, top = PLAYER_HUD_TOP, p = PLAYERS[id];
        drawCaps(g, `PLAYER ${id + 1}`, cx, top + 19, { size: 18, align: 'center' });
        headline(g, formatScore(game, score), cx, top + (crowd ? 66 : 76), crowd ? 36 : 46, ['#ffffff', p.light, p.color], crowd ? 200 : 300);
        if (!presence[id] && usesCamera()) drawShadowText(g, crowd ? 'Step back in' : 'Step back into view', cx, top + (crowd ? 96 : 110), { size: crowd ? 17 : 20, weight: 700, align: 'center', color: '#ffe27a' });
      });
    } else {
      // Without the scores, still nudge whoever is out of view.
      const missing = presence.flatMap((on, id) => (on ? [] : [`P${id + 1}`]));
      if (missing.length && usesCamera()) drawShadowText(g, `${missing.join(', ')}: step back into view`, w / 2, 860, { size: 22, weight: 700, align: 'center', color: '#ffe27a' });
    }
    if (pauseIcon) {
      g.save();
      g.strokeStyle = `rgb(${200 + pauseHover * 55}, ${205 + pauseHover * 50}, ${212 + pauseHover * 43})`;
      g.lineWidth = 4;
      g.lineCap = 'round';
      g.shadowColor = 'rgba(0, 34, 84, 0.6)';
      g.shadowBlur = 6;
      ICONS.pause(g, G.GAME_PAUSE.x, G.GAME_PAUSE.y, 36);
      g.restore();
    }
    if (game.hud?.timer !== false && game.durationMs) {
      const secs = Math.ceil(session.remainingMs() / 1000);
      const urgent = secs <= 5 && session.phase() === 'playing';
      headline(g, String(secs), w / 2, M.MG_TIMER_Y + 24, 52, urgent ? ['#fff6cc', '#ffd34d', '#f0a500'] : ['#ffffff', '#e6f8ff', '#9fd8ff'], 200);
    }
  }

  // Frosted glass in the how-to card, its Start button and the pause panel.
  useGlassBlur(() => {
    const p = props.current;
    const { g16: G, mg: M } = layouts.current;
    const ph = phase();
    const panes = !p.visible || !p.session ? []
      : ph === 'calibrating' ? [panelPane(G.GAME_CALIBRATION_CARD, 30)]
        : ph === 'howto' ? [panelPane(M.MG_HOWTO), buttonPane(ui, 'start', M.MG_HOWTO_START)]
          : ph === 'paused' ? [panelPane(G.GAME_PAUSE_PANEL)]
            : ph === 'error' ? [buttonPane(ui, 'leave', M.MG_HOWTO_START)] : [];
    return { panes, alpha: st.alpha };
  }, { priority: 2.25 });

  // A hidden tab pauses the round.
  useEffect(() => {
    const onVisibility = () => { if (document.hidden) props.current.session?.pause(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);
  // So does an interruption: the audio stopping, or iOS taking the camera.
  useEffect(() => watchInterruptions(() => { props.current.session?.pause(); ui.invalidate(); }, { audio: getMixer().ctx, camera: source }), [source, ui]);

  useEffect(() => {
    if (!visible) {
      for (const key of [...DATA_KEYS, ...st.dataKeys]) delete gl.domElement.dataset[key];
      st.dataKeys.clear();
      st.reported = '';
    }
    ui.invalidate();
  }, [visible, gl, st, ui]);

  return null;
}
