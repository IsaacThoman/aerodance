import { useEffect, useRef, useState } from 'react';
import { useThree } from '@react-three/fiber';
import {
  FONT, drawCaps, drawGlassCircle, drawGlassPanel, drawHeader, drawHeadline as headline, drawPill, drawProgress, drawShadowText, drawStatusDot,
  ellipsize, ICONS, paragraph, text,
} from '../ui/draw.ts';
import type { Face } from '../ui/draw.ts';
import useCanvasUI from '../ui/useCanvasUI.ts';
import type { CanvasUI } from '../ui/useCanvasUI.ts';
import { CameraSetup, cameraWidgets, drawCameraPicker } from '../connect/cameraSetup.ts';
import type { CameraWidget } from '../connect/cameraSetup.ts';
import { drawPairing } from '../connect/pairing.ts';
import { COUNTDOWN_MS, READY_HOLD_MS } from './GameSession.ts';
import type { GamePhase, GameSession, Readiness } from './GameSession.ts';
import { WEBCAM_STILL_MS } from './webcamCalibration.ts';
import type { CalibrationPlayerStatus, CalibrationStatus } from './webcamCalibration.ts';
import type { JudgementEvent, PlayerResult, WindowJudgement } from '../../../packages/score/scorer.ts';
import { drawWebcamPreview } from '../../../packages/pose/browser/preview.ts';
import type { CameraInput } from '../pose/CameraInput.ts';
import { PLAYERS, backOut, clamp01 } from './results.ts';
import { watchInterruptions } from './interruptions.ts';
import { getMixer } from '../audio/mixer.ts';
import {
  GAME_CALIBRATION_CAMERA, GAME_CALIBRATION_CARD, GAME_CALIBRATION_PREVIEW, GAME_CALIBRATION_PROGRESS, GAME_CALIBRATION_SKIP, GAME_PAUSE, GAME_PAUSE_PANEL, GAME_PROGRESS, GAME_QUIT, GAME_READY_BACK, GAME_READY_START, GAME_RESTART, GAME_RESUME,
  LIVE_PANEL, livePanelCenterX,
} from './layout.ts';

/**
 * The gameplay overlay, drawn in-engine over the song's stage (StageView draws the dancers
 * and the players' live characters):
 *
 *   calibrating camera setup: the preview, which starts the camera (or pairs the phone) when
 *              pressed, over the camera picker; every player holds still together for
 *              2.5 seconds, or Continue without a camera starts the song straight away
 *   ready      the countdown starts once everyone has been tracked for a second
 *              (or Start now)
 *   countdown  3, 2, 1 from the song's scheduled start
 *   playing    each player's score, combo and judgements under their live character, the
 *              song's progress, and a pause button (Escape, a hidden tab, or an interruption:
 *              a phone call taking the audio, or iOS taking the camera; interruptions.ts)
 *   paused     Resume (with a fresh countdown), Restart, Song select, and why the camera
 *              isn't tracking while iOS has it
 *   results    hands the overlay to ResultsScreen
 *
 * The canvas reports data-game-phase, -game-ready (taking input), -game-countdown, -game-time-ms and -game-scores for tests,
 * the camera's -game-camera-status / -model / -message / -interrupted, and while calibrating -game-calibration-* and -game-pairing.
 *
 * <GameScreen visible session={GameSession} camera={source} onQuit onRetry />
 */

export interface GameScreenProps {
  visible?: boolean;
  session: GameSession | null;
  /** The camera (webcam or phone), set up from the calibration screen. */
  camera: CameraInput;
  onQuit?: () => void;
  onRetry?: () => void;
}
/** A judgement on screen, since s.time = at. */
type Popup = JudgementEvent & { at: number };

const JUDGEMENT_LOOK: Record<WindowJudgement, [label: string, face: Face]> = {
  perfect: ['PERFECT!', ['#fff6cc', '#ffd34d', '#f0a500']],
  good: ['GOOD', ['#ffffff', '#b9fff0', '#2fc7d8']],
  ok: ['OK', ['#ffffff', '#e6f8ff', '#8fc8e8']],
  miss: ['MISS', ['#ffffff', '#ffd2c8', '#ff8a7a']],
  lost: ['LOST TRACKING', ['#ffffff', '#e2e9f2', '#9fb3c8']],
};
const POPUP_S = 0.9;
const CALIBRATION_STATUS: Record<CalibrationPlayerStatus, [label: string, color: string]> = {
  missing: ['Step into view', '#ffffff'],
  body: ['Keep your whole body in view', '#ffe27a'],
  moving: ['Movement detected — hold still', '#ffe27a'],
  holding: ['Hold still…', '#bff4ff'],
  ready: ['Calibrated!', '#9effdf'],
};

// The song plays with the live camera (not a replay, and not after Continue without a camera).
const usesCamera = (session: GameSession) => !!session.source && session.source.view.sourceKind !== 'replay' && !session.withoutCamera;

const fmt = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// Without a camera (tracking false) there is nothing to say about tracking.
function drawPlayerHud(g: CanvasRenderingContext2D, id: number, result: PlayerResult | undefined, readiness: Readiness | undefined, popups: readonly Popup[], now: number, tracking: boolean) {
  const cx = livePanelCenterX(id) * 1600;
  const top = (LIVE_PANEL.top + LIVE_PANEL.height) * 900 + 14;
  const p = PLAYERS[id];
  drawCaps(g, `PLAYER ${id + 1}`, cx, top + 19, { size: 18, align: 'center' });
  headline(g, (result?.score ?? 0).toLocaleString('en-US'), cx, top + 76, 46, ['#ffffff', p.light, p.color], 300);
  if (result && result.combo > 1) drawShadowText(g, `${result.combo} combo`, cx, top + 108, { size: 22, weight: 800, align: 'center', color: '#bff4ff' });
  if (tracking && readiness === 'missing') drawShadowText(g, 'Step back into view', cx, top + 138, { size: 20, weight: 700, align: 'center', color: '#ffe27a' });
  // The newest judgement pops in over the character's feet and floats up.
  const pop = popups.filter((j) => j.playerId === id && (tracking || j.judgement !== 'lost')).at(-1);
  if (pop) {
    const age = now - pop.at;
    if (age < POPUP_S) {
      const [label, face] = JUDGEMENT_LOOK[pop.judgement];
      g.save();
      g.globalAlpha *= 1 - clamp01((age - POPUP_S * 0.6) / (POPUP_S * 0.4));
      const s = backOut(clamp01(age / 0.22));
      g.translate(cx, top - 24 - age * 30);
      g.scale(s, s);
      headline(g, label, 0, 0, pop.judgement === 'lost' ? 26 : 38, face, 320);
      g.restore();
    }
  }
}

// The webcam setup card, centred: the mirrored preview with each player's status, the shared
// hold and the camera picker along the bottom. With the camera off, the preview is a big
// Start camera button.
function drawCalibration(g: CanvasRenderingContext2D, session: GameSession, calibration: CalibrationStatus, camera: CameraSetup, s: CanvasUI) {
  const h = s.hover;
  const { connection, source } = camera.target();
  const card = GAME_CALIBRATION_CARD;
  const preview = GAME_CALIBRATION_PREVIEW;
  const mid = card.x + card.w / 2;
  drawHeader(g, GAME_READY_BACK, 'CALIBRATION', h.quit ?? 0);
  drawPill(g, GAME_CALIBRATION_SKIP, { label: 'Continue', sub: 'without a camera', icon: 'play', hover: h.skip ?? 0, press: s.press * (h.skip ?? 0) });
  drawGlassPanel(g, card, 30);
  text(g, 'Stand still for 2.5 seconds', mid, card.y + 44, { size: 32, weight: 800, align: 'center' });

  drawWebcamPreview(g, source.video, connection.snapshot, preview, session.playerCount, '', { frame: connection.frame });
  const pairing = camera.pairing();
  if (pairing) drawPairing(g, { x: preview.x + 40, y: preview.y + 30, w: preview.w - 80, h: preview.h - 60 }, pairing);
  else if (!source.video && !connection.frame) drawStartCamera(g, camera, s);
  // Each player's status under their lane label (the setup preview is mirrored: player 1 is
  // on its left-hand side).
  const live = connection.status === 'connected';
  if (live) {
    const lane = preview.w / session.playerCount;
    calibration.players.forEach((status, id) => {
      const [label, color] = CALIBRATION_STATUS[status];
      g.font = `800 20px ${FONT}`;
      drawShadowText(g, ellipsize(g, label, lane - 32), preview.x + lane * (id + 0.5), preview.y + 50, { size: 20, weight: 800, align: 'center', color });
    });
  }

  drawCameraPicker(g, GAME_CALIBRATION_CAMERA, connection, h);
  drawProgress(g, GAME_CALIBRATION_PROGRESS, calibration.progress);
  const y = GAME_CALIBRATION_PROGRESS.y + 42;
  if (!live && camera.active()) {
    // Starting: what the camera is doing, after its status light.
    g.font = `600 21px ${FONT}`;
    const message = ellipsize(g, camera.message(), preview.w - 40);
    const x = mid - g.measureText(message).width / 2 + 14;
    drawStatusDot(g, x - 26, y, connection.status, 9);
    text(g, message, x, y, { size: 21, color: '#e6f8ff' });
    return;
  }
  const remaining = ((1 - calibration.progress) * WEBCAM_STILL_MS / 1000).toFixed(1);
  const message = !live ? (camera.phone() ? 'Pair your phone and prop it up, then step back until it can see your feet.' : 'Start the camera, then step back until it can see your feet.')
    : calibration.complete ? 'Calibrated! Starting…'
    : calibration.progress > 0 ? `Keep still · ${remaining} seconds to go`
    : 'The countdown starts automatically once everyone is calibrated.';
  text(g, message, mid, y, { size: 21, align: 'center', color: '#e6f8ff' });
}

// Over the empty preview: a camera button while the camera is off (the whole preview presses
// it, and shows why the last start failed), or a note while it starts.
function drawStartCamera(g: CanvasRenderingContext2D, camera: CameraSetup, s: CanvasUI) {
  const preview = GAME_CALIBRATION_PREVIEW;
  const cx = preview.x + preview.w / 2;
  const cy = preview.y + preview.h / 2;
  const phone = camera.phone();
  if (camera.active()) {
    text(g, phone ? 'Connecting to your phone…' : 'Starting camera…', cx, cy, { size: 24, weight: 700, align: 'center', color: '#e6f8ff' });
    return;
  }
  const failed = camera.failed();
  const top = failed ? cy - 40 : cy;
  const hover = s.hover['start-camera'] ?? 0;
  g.save();
  g.fillStyle = `rgba(120, 220, 255, ${hover * 0.08})`;
  g.fillRect(preview.x, preview.y, preview.w, preview.h);
  g.globalAlpha *= 0.85 + hover * 0.15;
  g.strokeStyle = '#ffffff';
  g.lineWidth = 6;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  (phone ? ICONS.phone : ICONS.camera)(g, cx, top - 24, 100);
  g.restore();
  text(g, failed ? 'Try again' : phone ? 'Pair phone' : 'Start camera', cx, top + 44, { size: 26, weight: 800, align: 'center' });
  if (failed) paragraph(g, camera.message(), cx, top + 86, preview.w - 120, { size: 19, lineH: 25, align: 'center', color: '#ffb38a' });
  // The phone is the camera picker's last entry, which is easy to miss.
  else if (!phone) text(g, 'No webcam? Choose Phone camera with the arrows below.', cx, preview.y + preview.h - 30, { size: 18, align: 'center', color: 'rgba(230, 248, 255, 0.75)' });
}

// Under the pause panel while iOS has the camera: why nobody is tracked, after its status light
// (as on the calibration screen).
function drawCameraInterrupted(g: CanvasRenderingContext2D, camera: CameraSetup, status: CameraInput['view']['status']) {
  const y = GAME_PAUSE_PANEL.y + GAME_PAUSE_PANEL.h + 44;
  g.font = `700 24px ${FONT}`;
  const message = ellipsize(g, camera.message(), 1100);
  const x = 800 - g.measureText(message).width / 2 + 14;
  drawStatusDot(g, x - 26, y, status, 9);
  drawShadowText(g, message, x, y, { size: 24, weight: 700 });
}

export default function GameScreen({ visible = false, session, camera: source, onQuit, onRetry }: GameScreenProps) {
  const gl = useThree((state) => state.gl);
  const props = useRef({ visible, session, source, onQuit, onRetry });
  props.current = { visible, session, source, onQuit, onRetry };
  const st = useRef<{ alpha: number; popups: Popup[]; reported: string; session?: GameSession | null; screen?: string }>({ alpha: 0, popups: [], reported: '' }).current;
  // The calibration screen's camera controls (the source's view is always current).
  const [camera] = useState(() => new CameraSetup(() => ({ source: props.current.source, connection: props.current.source.view })));

  const live = () => props.current.visible && phase() !== 'results' && st.alpha > 0.3;
  const phase = (): GamePhase => props.current.session?.phase ?? 'loading';
  // Webcam sessions calibrate before the ready check.
  const calibrating = () => !!props.current.session?.webcamCalibration && ['calibrating', 'ready'].includes(phase());

  const ui = useCanvasUI<CameraWidget>({
    priority: 2,
    active: live,
    keyNav: () => ['loading', 'calibrating', 'ready', 'error', 'paused', 'results'].includes(phase()),
    widgets: (): CameraWidget[] => {
      const ph = phase();
      if (calibrating()) {
        // Top to bottom: back and continue without a camera, the preview (start camera), the camera picker.
        const list: CameraWidget[] = [{ id: 'quit', circle: GAME_READY_BACK }, { id: 'skip', rect: GAME_CALIBRATION_SKIP }];
        if (!camera.active()) list.push({ id: 'start-camera', rect: GAME_CALIBRATION_PREVIEW, primary: true });
        return [...list, ...cameraWidgets(GAME_CALIBRATION_CAMERA)];
      }
      if (['ready', 'calibrating', 'loading', 'error'].includes(ph)) {
        const list: CameraWidget[] = [{ id: 'quit', circle: GAME_READY_BACK }];
        if (ph === 'ready') list.push({ id: 'start', rect: GAME_READY_START, primary: true });
        return list;
      }
      if (ph === 'countdown' || ph === 'playing') return [{ id: 'pause', circle: GAME_PAUSE, nav: false }];
      if (ph === 'paused') return [{ id: 'resume', rect: GAME_RESUME, primary: true }, { id: 'restart', rect: GAME_RESTART }, { id: 'quit', rect: GAME_QUIT }];
      return [];
    },
    onActivate: (wdg, s) => {
      const p = props.current;
      const session = p.session;
      if (wdg.id === 'start') session?.start();
      else if (wdg.id === 'pause') session?.pause();
      else if (wdg.id === 'resume') session?.resume();
      else if (wdg.id === 'restart' || wdg.id === 'retry') p.onRetry?.();
      else if (wdg.id === 'quit') p.onQuit?.();
      else if (wdg.id === 'skip') session?.continueWithoutCamera();
      else if (wdg.id === 'start-camera') camera.start();
      else if (calibrating()) camera.activate(wdg);
      s.invalidate();
    },
    onKey: (e, s) => {
      if (!live() || e.repeat) return;
      const session = props.current.session;
      const ph = phase();
      if (e.key === 'Escape') {
        if (ph === 'countdown' || ph === 'playing') session?.pause();
        else if (ph === 'paused') session?.resume();
        else if (['loading', 'calibrating', 'ready', 'error'].includes(ph)) props.current.onQuit?.();
        else return;
      } else return;
      e.preventDefault();
      s.invalidate();
    },
    update: (dt, s) => {
      const p = props.current;
      st.alpha = s.ease(st.alpha, p.visible ? 1 : 0, p.visible ? 4 : 8);
      const session = p.session;
      // Every screen (and song) starts without a keyboard cursor: one left on the calibration
      // preview mustn't land on Restart when the song pauses. Calibrating and ready share the
      // calibration screen, and flip back and forth while players step in and out.
      const screen = calibrating() ? 'calibration' : session?.phase;
      if (session !== st.session || screen !== st.screen) {
        st.session = session;
        st.screen = screen;
        if (s.keyFocus) s.focus(null);
      }
      if (!p.visible || !session) return;
      session.update(performance.now());
      // Animated every frame while a song is on: scores, the countdown, popups, readiness.
      s.invalidate();
      const now = s.time;
      st.popups = st.popups.filter((j) => now - j.at < POPUP_S);
      const scores = session.scorer.results().map((r) => r.score);
      const calibration = calibrating() ? session.calibrationStatus() : null;
      const view = p.source.view;
      const report = {
        gamePhase: session.phase,
        gameReady: String(live()),
        gameCountdown: session.phase === 'countdown' ? String(Math.ceil(session.countdownMs() / 1000)) : '',
        gameTimeMs: session.player ? String(Math.round(session.player.timeMs())) : '',
        gameScores: scores.join('|'),
        gameCalibrationProgress: calibration ? calibration.progress.toFixed(3) : '',
        gameCalibrationPlayers: calibration?.players.join('|') ?? '',
        gameCalibrationPreview: calibration ? String(!!p.source.video || !!view.frame) : '',
        gameCalibrationVideo: calibration ? String(!!p.source.video) : '',
        gameCameraStatus: view.status,
        gameCameraModel: view.model || '',
        gameCameraMessage: camera.message(),
        gameCameraInterrupted: String(camera.interrupted()),
        gamePairing: calibration ? camera.pairing()?.code ?? '' : '',
      };
      const json = JSON.stringify(report);
      if (json !== st.reported) { st.reported = json; Object.assign(gl.domElement.dataset, report); }
    },
    opacity: () => st.alpha,
    draw: (g, s) => {
      const p = props.current;
      const session = p.session;
      const h = s.hover;
      const press = (id: string) => s.press * (h[id] ?? 0);
      if (!session) return;
      const { song } = session.bundle;
      const ph = session.phase;
      const now = s.time;

      // Webcam sessions calibrate before the ready check (null otherwise).
      const calibration = calibrating() ? session.calibrationStatus() : null;
      if (calibration) {
        drawCalibration(g, session, calibration, camera, s);
        return;
      }

      if (ph === 'loading' || ph === 'error' || ph === 'ready') {
        drawHeader(g, GAME_READY_BACK, 'GET READY', h.quit ?? 0);
        g.font = `800 64px ${FONT}`;
        drawShadowText(g, ellipsize(g, song.title, 1000), 128, 270, { size: 64, weight: 800 });
        g.font = `700 30px ${FONT}`;
        drawShadowText(g, ellipsize(g, song.artist, 1000), 130, 322, { size: 30, color: '#d8f6ff' });
        if (ph === 'loading') drawShadowText(g, `Loading song${'.'.repeat(1 + (Math.floor(now * 3) % 3))}`, 800, 520, { size: 34, align: 'center' });
        if (ph === 'error') drawShadowText(g, session.error, 800, 520, { size: 30, align: 'center', color: '#ffb38a' });
        if (ph === 'ready') {
          const readiness = session.readiness();
          const hold = session.readySince === null ? 0 : clamp01((performance.now() - session.readySince) / READY_HOLD_MS);
          const allReady = readiness.every((r) => r === 'ready');
          drawPill(g, GAME_READY_START, {
            label: allReady ? 'Starting…' : 'Start now', sub: allReady ? '' : 'no tracking :(',
            icon: 'play', hover: h.start ?? 0, press: press('start'),
          });
          if (hold > 0) drawProgress(g, { x: GAME_READY_START.x + 40, y: GAME_READY_START.y + GAME_READY_START.h + 18, w: GAME_READY_START.w - 80, h: 12 }, hold);
        }
        return;
      }

      if (ph === 'results') return; // ResultsScreen owns every completed round.

      // During the song: the players' scores, judgements and the song's progress.
      const scores = session.scorer.results();
      const readiness = session.readiness();
      // Nothing to say about tracking while iOS has the camera either (the pause screen says why).
      const tracking = (!session.withoutCamera || p.source.view.status === 'connected') && !(usesCamera(session) && camera.interrupted());
      for (let id = 0; id < session.playerCount; id++) drawPlayerHud(g, id, scores[id], readiness[id], st.popups, now, tracking);
      if (ph !== 'paused') {
        drawGlassCircle(g, GAME_PAUSE, h.pause ?? 0);
        g.save();
        g.fillStyle = g.strokeStyle = '#ffffff';
        g.lineWidth = 4;
        g.lineCap = 'round';
        ICONS.pause(g, GAME_PAUSE.x, GAME_PAUSE.y, GAME_PAUSE.r * 1.4);
        g.restore();
      }
      const t = session.loaded().timeMs() - song.playableStartMs;
      const total = song.playableEndMs - song.playableStartMs;
      drawProgress(g, GAME_PROGRESS, t / total);
      g.font = `700 22px ${FONT}`;
      drawShadowText(g, ellipsize(g, song.title, 420), GAME_PROGRESS.x, GAME_PROGRESS.y - 22, { size: 22 });
      drawShadowText(g, `${fmt(t)} / ${fmt(total)}`, GAME_PROGRESS.x + GAME_PROGRESS.w, GAME_PROGRESS.y - 22, { size: 22, align: 'right' });

      if (ph === 'countdown') {
        const left = session.countdownMs();
        const n = Math.ceil(left / 1000);
        if (n > 0 && n <= COUNTDOWN_MS / 1000) {
          const into = 1 - (left / 1000 - (n - 1));
          g.save();
          g.translate(800, 470);
          const k = backOut(clamp01(into / 0.3));
          g.scale(k, k);
          g.globalAlpha *= 1 - clamp01((into - 0.75) / 0.25);
          headline(g, String(n), 0, 70, 220, ['#ffffff', '#7fd0ff', '#0a7fd8'], 400);
          g.restore();
        }
        if (session.pausedAtMs !== null) {
          drawShadowText(g, 'Get ready to pick up where you left off', 800, 620, { size: 26, weight: 700, align: 'center' });
        }
      } else if (ph === 'finishing') {
        drawShadowText(g, 'Tallying the bubbles…', 800, 470, { size: 40, weight: 800, align: 'center' });
      } else if (ph === 'paused') {
        g.save();
        g.fillStyle = 'rgba(0, 24, 60, 0.35)';
        g.fillRect(0, 0, 1600, 900);
        g.restore();
        drawGlassPanel(g, GAME_PAUSE_PANEL, 34);
        drawCaps(g, 'PAUSED', 800, GAME_PAUSE_PANEL.y + 46, { size: 30, align: 'center' });
        drawPill(g, GAME_RESUME, { label: 'Resume', icon: 'play', hover: h.resume ?? 0, press: press('resume') });
        drawPill(g, GAME_RESTART, { label: 'Restart', icon: 'replay', hover: h.restart ?? 0, press: press('restart') });
        drawPill(g, GAME_QUIT, { label: 'Song select', icon: 'list', hover: h.quit ?? 0, press: press('quit') });
        if (usesCamera(session) && camera.interrupted()) drawCameraInterrupted(g, camera, p.source.view.status);
      }
    },
  });

  // Judgements pop up under the players' characters.
  useEffect(() => {
    if (!session) return undefined;
    st.popups = [];
    return session.onJudgement((e) => { st.popups.push({ ...e, at: ui.time }); ui.invalidate(); });
  }, [session, st, ui]);

  // A hidden tab pauses the song (audio and scoring stop together).
  useEffect(() => {
    const onVisibility = () => { if (document.hidden) props.current.session?.pause(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // So does an interruption: the audio stopping, or iOS taking the camera of a song that
  // uses it. Resume is a gesture, which starts the audio again (mixer.ts).
  useEffect(() => watchInterruptions((cause) => {
    const session = props.current.session;
    if (session && (cause === 'audio' || usesCamera(session))) session.pause();
    ui.invalidate();
  }, { audio: getMixer().ctx, camera: source }), [source, ui]);

  useEffect(() => {
    if (!visible) {
      for (const key of ['gamePhase', 'gameReady', 'gameCountdown', 'gameTimeMs', 'gameScores', 'gameCalibrationProgress', 'gameCalibrationPlayers', 'gameCalibrationPreview', 'gameCalibrationVideo', 'gameCameraStatus', 'gameCameraModel', 'gameCameraMessage', 'gameCameraInterrupted', 'gamePairing']) delete gl.domElement.dataset[key];
      st.reported = '';
    }
    ui.invalidate();
  }, [visible, gl, st, ui]);

  return null;
}
