import type { CSSProperties } from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import Scene from './Scene.tsx';
import MainMenu, { DEFAULT_PLAYERS } from './menu/MainMenu.tsx';
import type { MenuScreen } from './menu/MainMenu.tsx';
import MenuDancers from './menu/MenuDancers.tsx';
import { loadSound, saveSound } from './menu/soundSettings.ts';
import { loadGraphics, saveGraphics } from './menu/graphicsSettings.ts';
import { applySound, duckMenuMusic } from './audio/mixer.ts';
import SongSelect from './game/SongSelect.tsx';
import type { SongScreen } from './game/SongSelect.tsx';
import { CAST_LIFT, CAST_SHIFT } from './game/layout.ts';
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
import type { Cast } from '../../../packages/pose/song.ts';
import { CameraInput } from './pose/CameraInput.ts';
import { ReplayPoseSource, parseRecording } from './pose/ReplayPoseSource.ts';
import type { PoseSource } from './pose/PoseSource.ts';
import { DISPLAY_MODES, displayModeFor } from './display.ts';
import FixedRenderResolution from './FixedRenderResolution.tsx';
import { isBackgroundId } from './backdrop/backgrounds.ts';
import type { DisplayMode } from './display.ts';
import { transferCode } from './songs/transferLink.ts';
import MinigameSelect from './minigames/MinigameSelect.tsx';
import type { MinigameSelectProps } from './minigames/MinigameSelect.tsx';
import MinigameScreen from './minigames/MinigameScreen.tsx';
import MinigameResults from './minigames/MinigameResults.tsx';
import type { MinigameResultsShow } from './minigames/MinigameResults.tsx';
import MinigameView from './minigames/MinigameView.tsx';
import { MinigameSession } from './minigames/MinigameSession.ts';
import { recordMinigameBest } from './minigames/bestScores.ts';
import type { MinigameDefinition, MinigamePhase } from './minigames/types.ts';
import type { MinigameOptionValues } from './minigames/options.ts';
import { createPuppetInput } from './pose/puppet/puppetCamera.ts';

// ?input=ghost plays with an autoplay ghost that copies the routine (?ghostLagMs=300 dances
// late); ?input=recording&recording=<url> replays a pose recording. ?record downloads each
// song's live poses as a recording on the results screen. ?input=puppet makes the camera a
// puppet camera: pretend people, posed from window.puppet or `node scripts/play.ts puppet`
// (pose/puppet/), tracked by the real webcam pipeline.
const params = new URLSearchParams(location.search);
// ?transfer=<code>, a transfer QR code's link (songs/transferLink.ts), opens Settings → Songs →
// Transfer songs joining it. It comes off the address once read, so reloading doesn't join again.
const startTransfer = transferCode();
if (startTransfer) {
  params.delete('transfer');
  const search = params.toString();
  history.replaceState(history.state, '', `${location.pathname}${search ? `?${search}` : ''}${location.hash}`);
}
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

type AppScreen = 'menu' | 'songs' | 'game' | 'minigames' | 'minigame';

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
  // 'menu' (MainMenu, opening on menuScreen), 'songs' (Song Select), 'game' (a song),
  // 'minigames' (their list) or 'minigame' (one being played).
  const [screen, setScreen] = useState<AppScreen>('menu');
  const [menuScreen, setMenuScreen] = useState<MenuScreen>(startTransfer ? 'transfer' : 'main');
  // The menu screen actually showing.
  const [menuShown, setMenuShown] = useState<MenuScreen>(startTransfer ? 'transfer' : 'main');
  const [playerCount, setPlayerCount] = useState<PlayerCount>(DEFAULT_PLAYERS);
  // The players screen's dial; it only becomes playerCount once Let's dance is pressed.
  const [dialCount, setDialCount] = useState<PlayerCount>(DEFAULT_PLAYERS);
  // The live camera (this computer's webcam, a paired phone, or ?input=puppet's puppet camera), with optional URL replay.
  const [source] = useState(() => (params.get('input') === 'puppet' ? createPuppetInput(params) : new CameraInput()));
  const [replay] = useState(replaySource);
  const activeSource: PoseSource = replay ?? source;
  // Song Select's preview: the routine to dance, and how its stage is doing. On the dancers
  // screen the stage camera faces the dancers instead of circling them, raised above the pills.
  const [preview, setPreview] = useState<SongRoutine | null>(null);
  const [songScreen, setSongScreen] = useState<SongScreen>('list');
  const [stage, setStage] = useState<StageState>({ showing: false, prepared: false, ready: false, stage: null, failed: false });
  const menuOpen = screen === 'menu';
  // The song being danced, its phase, and the results screen's reveal (StageView and
  // GameScreen both read it).
  const [game, setGame] = useState<GameSession | null>(null);
  const [gamePhase, setGamePhase] = useState<GamePhase | null>(null);
  const resultsShow = useRef<ResultsShow | null>(null);
  // The minigame being played, its phase and its results; the game the list reopens on afterwards.
  const [minigame, setMinigame] = useState<MinigameSession | null>(null);
  const [minigamePhase, setMinigamePhase] = useState<MinigamePhase | null>(null);
  const minigameResults = useRef<MinigameResultsShow | null>(null);
  const [minigameOpen, setMinigameOpen] = useState<MinigameSelectProps['open']>(null);
  const [minigamePreviewPlayers, setMinigamePreviewPlayers] = useState<PlayerCount | null>(null);
  // The main menu's button a keyboard cursor goes back to (Minigames, coming back from their list).
  const [menuRefocus, setMenuRefocus] = useState<string | undefined>(undefined);
  const [sound, setSound] = useState(loadSound);
  // The skyline flight, unless ?background=<id> shows a backdrop for this visit.
  const background = BACKGROUND_PARAM ?? 'skyline';

  useEffect(() => {
    if (!replay) return undefined;
    replay.connect();
    return () => replay.disconnect();
  }, [replay]);

  useEffect(() => {
    // Leaving the page releases the camera.
    const disconnect = () => source.disconnect();
    window.addEventListener('pagehide', disconnect);
    return () => {
      window.removeEventListener('pagehide', disconnect);
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
    setMenuRefocus(undefined);
    setScreen('menu');
  }, []);

  // Minigames: their list from the main menu, and back.
  const openMinigames = useCallback(() => {
    setMinigameOpen(null);
    setScreen('minigames');
  }, []);
  const leaveMinigames = useCallback(() => {
    setMenuScreen('main');
    setMenuRefocus('minigames');
    setScreen('menu');
  }, []);
  // Play on a game's preview: a session with that many players and its settings, the camera set up for them.
  const startMinigame = useCallback((game: MinigameDefinition, count: PlayerCount, options?: MinigameOptionValues) => {
    replay?.setPlayerCount(count);
    source.setPlayerCount(count).catch(() => {});
    const session = new MinigameSession({ game, playerCount: count, source: activeSource, options });
    // In development (and with the puppet camera), window.minigame is the round, for poking at
    // from play.ts: `eval "minigame.players[0].body[16]"`.
    if (import.meta.env.DEV || params.get('input') === 'puppet') Reflect.set(window, 'minigame', session);
    minigameResults.current = null;
    setMinigame(session);
    setMinigamePhase(session.phase());
    setScreen('minigame');
    duckMenuMusic(true);
    void session.load();
  }, [source, replay, activeSource]);
  const endMinigame = useCallback(() => {
    setMinigame((session) => { session?.dispose(); return null; });
    setMinigamePhase(null);
    duckMenuMusic(false);
  }, []);
  const quitMinigame = useCallback(() => {
    if (minigame) setMinigameOpen({ id: minigame.game.id, players: minigame.playerCount, options: minigame.options });
    endMinigame();
    setScreen('minigames');
  }, [minigame, endMinigame]);
  const retryMinigame = useCallback(() => {
    if (!minigame) return;
    const { game, playerCount: count, options } = minigame;
    endMinigame();
    startMinigame(game, count, options);
  }, [minigame, endMinigame, startMinigame]);
  // A round's results: its best saved, and the results screen's reveal.
  useEffect(() => {
    if (!minigame) return undefined;
    return minigame.onChange((session) => {
      setMinigamePhase(session.phase());
      if (session.phase() !== 'results' || !session.results) return;
      // (A round the game keeps out of the best scores shows none.)
      const best = session.outcome?.best === false ? { previous: null, best: null, isNewBest: false }
        : recordMinigameBest(session.game.id, session.playerCount, session.results, session.game.score?.better);
      // (A game whose players chose to play together says so as it goes: setCoop.)
      const game = session.coop === !!session.game.coop ? session.game : { ...session.game, coop: session.coop };
      minigameResults.current = { game, scores: session.results, start: performance.now() / 1000 + 0.2, best, outcome: session.outcome };
    });
  }, [minigame]);

  // Dance! on Song Select: a new GameSession for the bundle and the dancers the players follow,
  // on the song's stage.
  const startGame = useCallback((bundle: LoadedSongBundle, cast: Cast) => {
    const session = new GameSession({ bundle, playerCount, cast, source: activeSource, record: params.has('record') });
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
    const bundle = game?.bundle, cast = game?.cast;
    endGame();
    if (bundle && cast) startGame(bundle, cast);
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
  // A paired phone dims its screen while a song or a minigame round is on.
  useEffect(() => {
    source.setPlaying((!!gamePhase && ['countdown', 'playing', 'paused', 'finishing'].includes(gamePhase))
      || (!!minigamePhase && ['countdown', 'playing', 'paused', 'finishing'].includes(minigamePhase)));
  }, [source, gamePhase, minigamePhase]);
  // ...and sends its camera's picture only while a calibration screen shows it.
  useEffect(() => {
    source.setPreview((screen === 'game' && gamePhase === 'calibrating') || (screen === 'minigame' && minigamePhase === 'calibrating'));
  }, [source, screen, gamePhase, minigamePhase]);

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
  // Every song dances on its own stage, picked in Dance Studio (openreef if unset or unknown).
  const stageId = resolveStage((game?.bundle ?? preview?.bundle)?.song.stage);
  // A minigame's scene (minigames/types.ts): a stage (its game inside the stage's scene), a
  // background of its own, or the menu's.
  const minigameScene = screen === 'minigame' && minigame ? minigame.game.scene ?? 'menu' : null;
  const minigameStage = typeof minigameScene === 'object' && minigameScene && 'stage' in minigameScene ? minigameScene.stage : null;
  const minigameBackground = typeof minigameScene === 'object' && minigameScene && 'background' in minigameScene ? minigameScene.background : null;
  const minigameView = minigame ? <MinigameView key={minigame.key} session={minigame} /> : null;

  return (
    <div ref={viewport} className="display-viewport">
      <div className="canvas-frame display" style={{ '--display-aspect': DISPLAY_MODES[displayMode].aspect } as CSSProperties}>
        <Canvas dpr={1} flat gl={{ antialias: false }} camera={{ fov: 66, near: 0.3, far: 6500 }}>
          <FixedRenderResolution />
          <Scene paused={stage.showing} background={minigameBackground ?? background} />
          <StageView
            active={(songsOpen && !!preview) || screen === 'game' || !!minigameStage}
            orbiting={songsOpen && !!preview && songScreen !== 'dancers'}
            lift={songsOpen && !!preview && songScreen === 'dancers' ? CAST_LIFT : 0}
            shift={songsOpen && !!preview && songScreen === 'dancers' ? CAST_SHIFT : 0}
            stageId={minigameStage ?? stageId}
            routine={minigameStage ? null : game ? gameRoutine : preview}
            results={resultsVisible ? resultsShow : null}
            live={gameLive}
            dancers={!minigameStage}
            onState={setStage}
          >
            {minigameStage && minigameView}
          </StageView>
          {!minigameStage && minigameView}
          <MenuDancers
            visible={((menuOpen && menuShown !== 'settings' && menuShown !== 'transfer') || songsOpen || (screen === 'minigames' && minigamePreviewPlayers !== null)) && !stage.showing && !diagnostic('nodancers')}
            raised={songsOpen}
            // One dancer per player: the dial's count on the players screen, the chosen count on
            // Song Select and minigame previews, and the duet everywhere else.
            count={screen === 'minigames' ? minigamePreviewPlayers ?? 1 : songsOpen ? playerCount : menuOpen && menuShown === 'players' ? dialCount : 2}
          />
          <MainMenu
            visible={menuOpen}
            initialScreen={menuScreen}
            transferCode={startTransfer}
            playerCount={dialCount}
            onPlayerCountChange={setDialCount}
            onStart={choosePlayers}
            onMinigames={openMinigames}
            refocus={menuRefocus}
            onScreenChange={setMenuShown}
            sound={sound}
            onSoundChange={setSound}
            graphics={graphics}
            onGraphicsChange={setGraphics}
          />
          <SongSelect
            visible={songsOpen}
            playerCount={playerCount}
            source={activeSource}
            onBack={leaveSongs}
            stageState={stage}
            onPreviewChange={setPreview}
            onScreenChange={setSongScreen}
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
          <MinigameSelect
            visible={screen === 'minigames'}
            open={minigameOpen}
            players={playerCount}
            onPreviewPlayersChange={setMinigamePreviewPlayers}
            onBack={leaveMinigames}
            onPlay={startMinigame}
          />
          <MinigameScreen
            visible={screen === 'minigame' && !!minigame}
            session={minigame}
            camera={source}
            onQuit={quitMinigame}
            onRetry={retryMinigame}
          />
          <MinigameResults
            visible={screen === 'minigame' && minigamePhase === 'results'}
            show={minigameResults}
            onQuit={quitMinigame}
            onRetry={retryMinigame}
          />
          {statsMode !== 'off' && (
            <StatsOverlay
              mode={statsMode}
              source={activeSource}
              game={game}
              screen={menuOpen ? `menu/${menuShown}` : songsOpen ? 'songs' : screen === 'minigames' ? 'minigames'
                : screen === 'minigame' ? `minigame/${minigamePhase ?? 'loading'}` : `game/${gamePhase ?? 'loading'}`}
            />
          )}
        </Canvas>
      </div>
    </div>
  );
}
