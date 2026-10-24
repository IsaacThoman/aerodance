import type { CSSProperties } from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import Scene from './Scene.tsx';
import MainMenu, { DEFAULT_PLAYERS } from './menu/MainMenu.tsx';
import type { MenuScreen } from './menu/MainMenu.tsx';
import MenuDancers from './menu/MenuDancers.tsx';
import { loadSound, saveSound } from './menu/soundSettings.ts';
import { loadGraphics, saveGraphics } from './menu/graphicsSettings.ts';
import { applySound, duckMenuMusic } from './audio/mixer.ts';
import SongSelect from './game/SongSelect.tsx';
import GameScreen from './game/GameScreen.tsx';
import ResultsScreen from './game/ResultsScreen.tsx';
import { GameSession } from './game/GameSession.ts';
import type { GamePhase, SongRoutine } from './game/GameSession.ts';
import { recordResults } from './game/bestScores.ts';
import { PLAYERS, leadersOf, winnerOf } from './game/results.ts';
import type { ResultsShow } from './game/results.ts';
import StageView from './stage/StageView.tsx';
import StatsOverlay from './stats/StatsOverlay.tsx';
import { diagnostic } from './diagnostics.ts';
import type { StageState } from './stage/StageView.tsx';
import type { LoadedSongBundle } from './songs/loadBundle.ts';
import { resolveStage } from '../../../packages/stages/catalog.ts';
import type { PlayerCount } from '../../../packages/pose/choreography.ts';
import { CameraInput } from './pose/CameraInput.ts';
import { ReplayPoseSource, parseRecording } from './pose/ReplayPoseSource.ts';
import type { PoseSource } from './pose/PoseSource.ts';
import { DISPLAY_MODES, RENDER_SIZE, displayModeFor } from './display.ts';
import { isBackgroundId } from './backdrop/backgrounds.ts';
import type { DisplayMode } from './display.ts';

function FixedRenderResolution() {
  const gl = useThree((state) => state.gl);
  const size = useThree((state) => state.size);

  useLayoutEffect(() => {
    // Fiber tracks the displayed size for projection and pointer events. As on Wii,
    // both display modes use the same buffer; widescreen is anamorphic.
    gl.setSize(RENDER_SIZE.w, RENDER_SIZE.h, false);
    gl.domElement.dataset.displayMode = displayModeFor(size.width, size.height);
  }, [gl, size.width, size.height]);

  return null;
}

// ?input=ghost plays with an autoplay ghost that copies the routine (?ghostLagMs=300 dances
// late); ?input=recording&recording=<url> replays a pose recording. ?record downloads each
// song's live poses as a recording on the results screen.
const params = new URLSearchParams(location.search);
function replaySource() {
  const input = params.get('input');
  if (input === 'ghost') return new ReplayPoseSource({ mode: 'ghost', lagMs: Number(params.get('ghostLagMs')) || 0 });
  const recording = params.get('recording');
  if (input !== 'recording' || !recording) return null;
  const source = new ReplayPoseSource({ mode: 'recording' });
  fetch(recording).then((r) => r.arrayBuffer()).then((bytes) => { source.recording = parseRecording(new Uint8Array(bytes)); })
    .catch((err: unknown) => console.error('pose recording could not load:', err instanceof Error ? err.message : err));
  return source;
}

const backgroundParam = params.get('background');
const BACKGROUND_PARAM = isBackgroundId(backgroundParam) ? backgroundParam : null;

type AppScreen = 'menu' | 'songs' | 'game';

function download(name: string, bytes: Uint8Array<ArrayBuffer>) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function App() {
  const viewport = useRef<HTMLDivElement>(null);
  // Settings → Graphics picks 4:3 or 16:9, or Auto: the one that fills more of the screen.
  const [graphics, setGraphics] = useState(loadGraphics);
  const [fittedMode, setFittedMode] = useState<DisplayMode>(() => displayModeFor(innerWidth, innerHeight));
  const displayMode = graphics.aspect === 'auto' ? fittedMode : graphics.aspect;
  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el) return;
    // Observe the safe available area, independently of the letterboxed frame.
    const observer = new ResizeObserver(([entry]) => setFittedMode(displayModeFor(entry.contentRect.width, entry.contentRect.height)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // 'menu' (MainMenu, opening on menuScreen), 'songs' (Song Select) or 'game' (a song).
  const [screen, setScreen] = useState<AppScreen>('menu');
  const [menuScreen, setMenuScreen] = useState<MenuScreen>('main');
  // The menu screen actually showing.
  const [menuShown, setMenuShown] = useState<MenuScreen>('main');
  const [playerCount, setPlayerCount] = useState<PlayerCount>(DEFAULT_PLAYERS);
  // The players screen's dial; it only becomes playerCount once Let's dance is pressed.
  const [dialCount, setDialCount] = useState<PlayerCount>(DEFAULT_PLAYERS);
  // The live camera (this computer's webcam or a paired phone), with optional URL replay.
  const [source] = useState(() => new CameraInput());
  const [replay] = useState(replaySource);
  const [connection, setConnection] = useState(source.view);
  const [replayView, setReplayView] = useState(replay?.view ?? null);
  const activeSource: PoseSource = replay ?? source;
  // Song Select's preview: the routine to dance, and how its stage is doing.
  const [preview, setPreview] = useState<SongRoutine | null>(null);
  const [stage, setStage] = useState<StageState>({ showing: false, prepared: false, ready: false, stage: null, failed: false });
  const menuOpen = screen === 'menu';
  const selectedConnection = replay && replayView ? replayView : connection;
  // The song being danced, its phase, and the results screen's reveal (StageView and
  // GameScreen both read it).
  const [game, setGame] = useState<GameSession | null>(null);
  const [gamePhase, setGamePhase] = useState<GamePhase | null>(null);
  const resultsShow = useRef<ResultsShow | null>(null);
  const [sound, setSound] = useState(loadSound);

  useEffect(() => {
    if (!replay) return undefined;
    const unsubscribe = replay.subscribe(setReplayView);
    replay.connect();
    return () => { unsubscribe(); replay.disconnect(); };
  }, [replay]);

  useEffect(() => {
    const unsubscribe = source.subscribe(setConnection);
    // Leaving the page releases the camera.
    const disconnect = () => source.disconnect();
    window.addEventListener('pagehide', disconnect);
    return () => {
      window.removeEventListener('pagehide', disconnect);
      unsubscribe();
      source.disconnect();
    };
  }, [source]);

  const choosePlayers = useCallback((count: PlayerCount) => {
    if (source.view.configuring) return;
    setPlayerCount(count);
    replay?.setPlayerCount(count);
    source.setPlayerCount(count).catch(() => {});
    setScreen('songs');
  }, [source, replay]);
  const leaveSongs = useCallback(() => {
    setMenuScreen('players');
    setScreen('menu');
  }, []);

  // Dance! on Song Select: a new GameSession for the bundle, on the song's stage.
  const startGame = useCallback((bundle: LoadedSongBundle) => {
    const session = new GameSession({ bundle, playerCount, source: activeSource, record: params.has('record') });
    resultsShow.current = null;
    setGame(session);
    setGamePhase(session.phase);
    setScreen('game');
    duckMenuMusic(true);
    session.load();
  }, [playerCount, activeSource]);
  const endGame = useCallback(() => {
    setGame((session) => { session?.dispose(); return null; });
    setGamePhase(null);
    duckMenuMusic(false);
  }, []);
  const quitGame = useCallback(() => {
    endGame();
    setScreen('songs');
  }, [endGame]);
  const retryGame = useCallback(() => {
    const bundle = game?.bundle;
    endGame();
    if (bundle) startGame(bundle);
  }, [game, endGame, startGame]);

  // The session's phases drive the stage (results).
  useEffect(() => {
    if (!game) return undefined;
    return game.onChange((session) => {
      setGamePhase(session.phase);
      if (session.phase !== 'results' || !session.results) return;
      const results = session.results.map((r, i) => ({ ...PLAYERS[i], ...r }));
      const best = recordResults(session.bundle.scoreId, session.playerCount, session.results);
      resultsShow.current = { key: `${session.bundle.song.songId}|${performance.now()}`, start: performance.now() / 1000 + 0.3, results, winner: winnerOf(results), leaders: leadersOf(results), best };
      if (session.recordingBytes) download(`${session.bundle.song.songId}-poses.adpose`, session.recordingBytes);
    });
  }, [game]);

  useEffect(() => { saveSound(sound); applySound(sound); }, [sound]);
  useEffect(() => { saveGraphics(graphics); }, [graphics]);
  // A paired phone dims its screen while a song is on.
  useEffect(() => {
    source.setPlaying(!!gamePhase && ['countdown', 'playing', 'paused', 'finishing'].includes(gamePhase));
  }, [source, gamePhase]);
  // ...and sends its camera's picture only while the calibration screen shows it.
  useEffect(() => {
    source.setPreview(screen === 'game' && gamePhase === 'calibrating');
  }, [source, screen, gamePhase]);

  const songsOpen = screen === 'songs';
  const resultsVisible = screen === 'game' && gamePhase === 'results';
  const gameRoutine = useMemo(() => game?.routine() ?? null, [game]);
  // The players' live poses, for the winner left on stage after the results' reveal.
  const gameLive = useMemo(() => (game ? {
    livePose: (id: number, now: number) => game.livePose(id, now),
    calibration: (id: number) => game.live[id]?.calibration ?? null,
  } : null), [game]);
  // Settings → Graphics → Stats, or ?diag=stats for the full set whatever the setting.
  const statsMode = diagnostic('stats') ? 'full' : graphics.stats;
  // Settings → Graphics → Background, unless ?background=<id> picks one for this visit.
  const background = BACKGROUND_PARAM ?? graphics.background;
  // Every song dances on its own stage, picked in Dance Studio (openreef if unset or unknown).
  const stageId = resolveStage((game?.bundle ?? preview?.bundle)?.song.stage);

  return (
    <div ref={viewport} className="display-viewport">
      <div className="canvas-frame display" style={{ '--display-aspect': DISPLAY_MODES[displayMode].aspect } as CSSProperties}>
        <Canvas dpr={1} flat gl={{ antialias: false }} camera={{ fov: 66, near: 0.3, far: 6500 }}>
          <FixedRenderResolution />
          <Scene paused={stage.showing} background={background} />
          <StageView
            active={(songsOpen && !!preview) || screen === 'game'}
            orbiting={songsOpen && !!preview}
            stageId={stageId}
            routine={game ? gameRoutine : preview}
            results={resultsVisible ? resultsShow : null}
            live={gameLive}
            onState={setStage}
          />
          <MenuDancers
            visible={((menuOpen && menuShown !== 'settings') || songsOpen) && !stage.showing && !diagnostic('nodancers')}
            raised={songsOpen}
            // One dancer per player: the dial's count on the players screen, the chosen count on
            // Song Select, and the duet everywhere else.
            count={songsOpen ? playerCount : menuOpen && menuShown === 'players' ? dialCount : 2}
          />
          <MainMenu
            visible={menuOpen}
            initialScreen={menuScreen}
            playerCount={dialCount}
            onPlayerCountChange={setDialCount}
            onStart={choosePlayers}
            onScreenChange={setMenuShown}
            sound={sound}
            onSoundChange={setSound}
            graphics={graphics}
            onGraphicsChange={setGraphics}
          />
          <SongSelect
            visible={songsOpen}
            playerCount={playerCount}
            connection={selectedConnection}
            onBack={leaveSongs}
            stageState={stage}
            onPreviewChange={setPreview}
            onDance={startGame}
          />
          <GameScreen
            visible={screen === 'game' && !!game}
            session={game}
            camera={source}
            onQuit={quitGame}
            onRetry={retryGame}
          />
          <ResultsScreen
            visible={resultsVisible}
            show={resultsShow}
            song={game?.bundle.song}
            onQuit={quitGame}
            onRetry={retryGame}
          />
          {statsMode !== 'off' && (
            <StatsOverlay
              mode={statsMode}
              source={activeSource}
              game={game}
              screen={menuOpen ? `menu/${menuShown}` : songsOpen ? 'songs' : `game/${gamePhase ?? 'loading'}`}
            />
          )}
        </Canvas>
      </div>
    </div>
  );
}
