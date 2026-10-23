import { useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import {
  FONT, ICONS, drawCaps, drawDarkGlassPanel, drawGlassButton, drawGlassCircle, drawHeader, drawShadowText, ellipsize, glassCorner,
  paragraph, roundRect, wrapText,
} from '../ui/draw.ts';
import type { Circle, IconName, Rect } from '../ui/draw.ts';
import { WAVES, cutoutWidth, drawAeroCutout, traceAeroCutout } from '../ui/aeroCutout.ts';
import useCanvasUI from '../ui/useCanvasUI.ts';
import useGlassBlur, { buttonPane, panelPane } from '../ui/useGlassBlur.ts';
import type { CanvasUI, Widget } from '../ui/useCanvasUI.ts';
import { duckMenuMusic } from '../audio/mixer.ts';
import { createSongPlayer } from '../audio/songPlayer.ts';
import type { SongPlayer } from '../audio/songPlayer.ts';
import { loadSongBundle } from '../songs/loadBundle.ts';
import type { LoadedSongBundle } from '../songs/loadBundle.ts';
import { customScoreId, customSongsSupported, listCustomSongs, loadCustomSong, savedCustomSong } from '../songs/customSongs.ts';
import { songDancers, validateCatalog } from '../../../../packages/pose/song.ts';
import type { CatalogSong } from '../../../../packages/pose/song.ts';
import { autoCast } from '../../../../packages/pose/choreography.ts';
import type { Cast, PlayerCount } from '../../../../packages/pose/choreography.ts';
import { SCORER_VERSION } from '../../../../packages/score/scorer.ts';
import { bestScore } from './bestScores.ts';
import type { SongRoutine } from './GameSession.ts';
import type { PoseInputView } from '../pose/PoseSource.ts';
import { preloadStage, resolveStage } from '../../../../packages/stages/index.ts';
import type { StageState } from '../stage/StageView.tsx';
import { gameLayout } from './layout.ts';
import { PLAYERS } from './results.ts';
import { displayDesign } from '../display.ts';

/**
 * Song Select, drawn in-engine after the player count is picked (menu/MainMenu.tsx).
 *
 *   list     the published songs (songs/manifest.json, found by scripts/songCatalog.ts),
 *            then the songs imported into this browser or app (songs/customSongs.ts; Settings →
 *            Songs imports and removes them), four to a page
 *            Each song's button shows a cutout of every dancer it was recorded with.
 *   preview  a song's music with its reference dancers on the song's stage (StageView,
 *            mounted by App from onPreviewChange; each song's stage is picked in Dance
 *            Studio), the music looping on its own while the stage camera circles them,
 *            and Dance!, which hands the bundle and the cast to the game (onDance); the
 *            menu music ducks underneath. Dancers (for a song of two or more) opens:
 *   cast     who dances which dancer: a column per player, each picking one of the song's
 *            dancers (by its cutout, or Left/Right); the stage's coaches take the colours of
 *            the players dancing them. Without a pick, the players are cast by where they
 *            stand (autoCast), as Auto puts back. Dance! starts from here too.
 *
 * Choosing a song keeps the list up, its row loading, until the preview can show at once: the
 * bundle loads (fully verified, songs/loadBundle.ts) while the stage's code downloads, then the
 * stage is built and compiled out of sight (StageView's `prepared`) and the preview opens.
 * Back / Escape go from the dancers to the preview, from the preview to the list and from the
 * list to the player count.
 * The canvas reports data-song-screen, -song-ready, -catalog, -song-count, -custom-song-count,
 * -song-dancers (the page's songs' dancer counts), -song-load-error, -player-slots,
 * -preview-state, -preview-time-ms, -cast (each player's dancer) and -cast-auto for tests.
 *
 * <SongSelect visible playerCount={1} connection={view} onBack
 *   stageState={{ showing, prepared, ready, stage, failed }} onPreviewChange onDance={(bundle, cast) => ...} />
 */

export interface SongSelectProps {
  visible?: boolean;
  playerCount?: PlayerCount;
  connection: PoseInputView;
  onBack?: () => void;
  stageState?: Partial<StageState>;
  /** The routine to preview on its stage, or null when the preview closes. */
  onPreviewChange?: (routine: SongRoutine | null) => void;
  /** The Dancers screen opened (true) or closed: the stage camera faces the dancers meanwhile. */
  onCastingChange?: (casting: boolean) => void;
  onDance?: (bundle: LoadedSongBundle, cast: Cast) => void;
}
type SongScreen = 'list' | 'preview' | 'cast';
type CatalogStatus = 'idle' | 'loading' | 'ready' | 'error';
type PreviewState = 'loading' | 'error' | SongPlayer['state'];
/** A listed song: published, or imported into this browser or app (custom). key tells them apart in the list. */
type ListedSong = CatalogSong & { custom: boolean; key: string };
type SongWidget = Widget & { song?: ListedSong };
interface SongSelectState {
  alpha: number; screen: SongScreen; next: SongScreen; swap: number; page: number;
  catalog: { status: CatalogStatus; songs: ListedSong[]; error: string };
  catalogCtl: AbortController | null;
  /** The song (key) whose bundle is loading. */
  loading: { id: string; controller: AbortController } | null;
  /** The last song (key) opened, for the keyboard cursor coming back to the list. */
  chosen: string | null;
  loadError: string;
  bundle: LoadedSongBundle | null;
  player: SongPlayer | null;
  routine: SongRoutine | null;
  /** The players' picks of dancers, or null to cast them by where they stand; and whose song they're for. */
  cast: number[] | null;
  castSong: string | null;
  /** The Dancers screen is (about to be) up, as onCastingChange last heard. */
  casting: boolean;
  previewState: PreviewState;
  previewError: string;
  drawn: string;
  reported: string;
}

const CATALOG_URL = () => new URL(`${import.meta.env.BASE_URL}songs/manifest.json`, window.location.href).href;
const ACTIVE = ['connecting'];
const CUSTOM_SONGS = customSongsSupported();
const IMPORTED_TIMEOUT_MS = 5000;
const listed = (songs: readonly CatalogSong[], custom: boolean): ListedSong[] => songs.map((song) => ({ ...song, custom, key: custom ? customScoreId(song.id) : song.id }));
const message = (error: unknown) => (error instanceof Error ? error.message : '');

const COUNT_NAMES = ['One player', 'Two players', 'Three players', 'Four players'];
const INK_EYES = 'rgba(12, 47, 82, 0.9)';
// Over the Dancers panel: which player is which.
const CAST_HINTS = [
  'Pick the dancer you’ll dance.',
  'Player 1 stands on the left, Player 2 on the right.',
  'Player 1 stands furthest left, then 2 and 3.',
  'Player 1 stands furthest left, then 2, 3 and 4.',
];

// A white cutout of each of a song's dancers, side by side at the right end of its button: as
// many as it was recorded with, however many are playing.
function dancerCutouts(dancers: number, rowH: number) {
  const height = Math.round(rowH * 0.64);
  const w = cutoutWidth(height);
  const step = w * 0.86;
  return {
    width: w + (dancers - 1) * step + rowH * 0.12,
    draw: (g: CanvasRenderingContext2D, rect: Rect) => {
      const right = rect.x + rect.w - rect.h * 0.28 - w / 2;
      for (let i = 0; i < dancers; i++) drawAeroCutout(g, right - (dancers - 1 - i) * step, rect.y + rect.h * 0.85, height, { fill: '#ffffff', eyes: INK_EYES });
    },
  };
}

// Each player's tracking, from the pose input (reported for tests as data-player-slots).
function slotStatus(connection: PoseInputView, id: number): { label: string; kind?: 'detected' } {
  if (connection.snapshot?.poses?.some((p) => p.playerId === id)) return { label: 'Detected', kind: 'detected' };
  if (connection.interrupted) return { label: 'Camera interrupted' };
  if (connection.status === 'initializing') return { label: 'Camera starting…' };
  if (connection.status === 'connected') return { label: 'Step into view' };
  if (ACTIVE.includes(connection.status)) return { label: 'Connecting…' };
  return { label: 'Camera off' };
}

export default function SongSelect({
  visible = false, playerCount = 1, connection, onBack,
  stageState = {}, onPreviewChange, onCastingChange, onDance,
}: SongSelectProps) {
  const gl = useThree((state) => state.gl);
  const size = useThree((state) => state.size);
  const { BACK, CAST_AUTO, DANCE, DANCERS, PAGE_DOWN, PAGE_UP, PREVIEW_NOTE, RETRY, ROWS, castColumn, castPanel, castSlot, rowRect } = gameLayout(displayDesign(size.width, size.height).w);
  const props = useRef({ visible, playerCount, connection, onBack, stageState, onPreviewChange, onCastingChange, onDance });
  props.current = { visible, playerCount, connection, onBack, stageState, onPreviewChange, onCastingChange, onDance };
  const st = useRef<SongSelectState>({
    alpha: 0, screen: 'list', next: 'list', swap: 1, page: 0,
    catalog: { status: 'idle', songs: [], error: '' }, catalogCtl: null,
    loading: null, chosen: null, loadError: '',
    bundle: null, player: null, routine: null, cast: null, castSong: null, casting: false, previewState: 'loading', previewError: '',
    drawn: '', reported: '',
  }).current;

  const songs = () => st.catalog.songs.filter((song) => song.supportedPlayerCounts.includes(props.current.playerCount));
  const pages = () => Math.max(1, Math.ceil(songs().length / ROWS.perPage));
  const pageSongs = () => songs().slice(st.page * ROWS.perPage, (st.page + 1) * ROWS.perPage);
  const live = () => props.current.visible && st.alpha > 0.3 && st.screen === st.next;
  // The song opened last is the primary one while it's on the page, else the first.
  const primaryRow = () => Math.max(0, pageSongs().findIndex((song) => song.key === st.chosen));
  const songWidget = (song: ListedSong, i: number): SongWidget => ({ id: `song-${song.key}`, song, rect: rowRect(i), corner: glassCorner(rowRect(i).h), primary: i === primaryRow() });
  // The keyboard cursor starts over on the next screen; back on the list (also by Escape), on
  // the song it opened, and on the dancers, on player 1.
  const go = (screen: SongScreen, key = ui.keyboard) => {
    if (screen === st.next) return;
    st.next = screen;
    if (!key) return;
    if (screen === 'cast') { ui.focus(castWidget(0)); return; }
    const i = screen === 'list' ? pageSongs().findIndex((song) => song.key === st.chosen) : -1;
    ui.focus(i >= 0 ? songWidget(pageSongs()[i], i) : null);
  };

  // The previewed song's dancers, and who dances each: the players' picks, or by where they stand.
  const dancers = () => st.bundle?.choreography.tracks.length ?? 0;
  const cast = (): Cast => (st.cast?.length === props.current.playerCount ? st.cast : autoCast(props.current.playerCount, dancers()));
  const castWidget = (player: number): Widget => ({ id: `cast-${player}`, rect: castColumn(player), corner: 24 });
  // A new cast goes to the stage (its coaches recolour) in a new routine. Picking what the
  // players would be cast anyway is no pick at all.
  const recast = (picks: number[] | null) => {
    const auto = autoCast(props.current.playerCount, dancers());
    st.cast = picks && picks.some((d, i) => d !== auto[i]) ? picks : null;
    if (!st.routine) return;
    st.routine = { ...st.routine, cast: cast() };
    props.current.onPreviewChange?.(st.routine);
  };
  const pick = (player: number, dancer: number) => recast(cast().map((d, i) => (i === player ? dancer : d)));
  const step = (player: number, dir: number) => pick(player, (cast()[player] + dir + dancers()) % dancers());

  // Loads the published and imported songs. With show (a song's key), the list turns to its page
  // and the keyboard cursor, if out, goes to it; otherwise the page stays where it was.
  const fetchCatalog = (show?: string) => {
    st.catalogCtl?.abort();
    const ctl = new AbortController();
    st.catalogCtl = ctl;
    st.catalog = { status: 'loading', songs: [], error: '' };
    const published = fetch(CATALOG_URL(), { signal: ctl.signal, cache: 'no-store' })
      .then((response) => {
        if (!response.ok) throw Error('Song catalog could not load.');
        return response.json();
      })
      .then((data: unknown) => validateCatalog(data).songs);
    // Saved songs that can't be read (or take too long) leave the published songs listed (if
    // those don't load, the list shows the error and Retry).
    const imported = CUSTOM_SONGS ? Promise.race([
      listCustomSongs(),
      new Promise<never>((_, reject) => setTimeout(() => reject(Error('timed out')), IMPORTED_TIMEOUT_MS)),
    ]).catch((error: unknown) => { console.warn('Imported songs could not load:', error); return []; }) : [];
    Promise.all([published, imported])
      .then(([shipped, custom]) => {
        if (ctl.signal.aborted) return;
        st.catalog = { status: 'ready', songs: [...listed(shipped, false), ...listed(custom, true)], error: '' };
        const i = show ? songs().findIndex((song) => song.key === show) : -1;
        st.page = i >= 0 ? Math.floor(i / ROWS.perPage) : Math.min(st.page, pages() - 1);
        if (i >= 0 && ui.keyboard && st.next === 'list') ui.focus(songWidget(songs()[i], i % ROWS.perPage));
      })
      .catch((error: unknown) => {
        if (ctl.signal.aborted) return;
        st.catalog = { status: 'error', songs: [], error: message(error) || 'Song catalog could not load.' };
      })
      .finally(() => { if (!ctl.signal.aborted) ui.invalidate(); });
  };

  const closePreview = () => {
    st.player?.dispose();
    st.player = null;
    st.bundle = null;
    st.routine = null;
    duckMenuMusic(false);
    props.current.onPreviewChange?.(null);
  };

  // The preview's stage is mounted out of sight (StageView) while the list stays up with the
  // song's row loading; showPreview opens the preview once it's built and compiled.
  const openPreview = (bundle: LoadedSongBundle) => {
    const { song } = bundle;
    st.bundle = bundle;
    st.previewState = 'loading';
    st.previewError = '';
    // The players' picks last while they come back to the same song.
    if (st.castSong !== bundle.scoreId) st.cast = null;
    st.castSong = bundle.scoreId;
    const routine: SongRoutine = {
      bundle,
      playerCount: props.current.playerCount,
      cast: cast(),
      // While the timeline is dragged the dancers follow the knob.
      timeMs: () => st.player?.timeMs() ?? song.playableStartMs,
      playing: () => st.player?.state === 'playing',
    };
    st.routine = routine;
    props.current.onPreviewChange?.(routine);
    // The audio decodes meanwhile; it plays once the preview is open.
    createSongPlayer(bundle.audio, { startMs: song.playableStartMs, endMs: song.playableEndMs }, { untilHeard: false })
      .then((player) => {
        if (st.bundle !== bundle) { player.dispose(); return; }
        st.player = player;
        // The preview plays straight away and loops: at the end it starts over.
        player.onChange(() => {
          if (player.ended && st.player === player && !document.hidden) player.play();
          st.previewState = player.state;
          ui.invalidate();
        });
        if (!document.hidden && st.next !== 'list') player.play();
        st.previewState = player.state;
      })
      .catch(() => {
        if (st.bundle !== bundle) return;
        st.previewState = 'error';
        st.previewError = 'This browser could not decode the song audio.';
      })
      .finally(() => ui.invalidate());
  };

  // Once the preview's stage is in (or failed): the music starts and the preview opens.
  const showPreview = () => {
    st.loading = null;
    duckMenuMusic(true);
    go('preview');
    if (!document.hidden) st.player?.play();
  };

  const chooseSong = (entry: ListedSong) => {
    st.loading?.controller.abort();
    const controller = new AbortController();
    st.loading = { id: entry.key, controller };
    st.chosen = entry.key;
    st.loadError = '';
    const { signal } = controller;
    // The stage's code downloads alongside the bundle.
    preloadStage(resolveStage(entry.stage));
    (entry.custom ? loadCustomSong(entry, { signal }) : loadSongBundle(entry, CATALOG_URL(), { signal }))
      .then((bundle) => { if (!signal.aborted && props.current.visible) openPreview(bundle); })
      .catch((error: unknown) => {
        if (signal.aborted) return;
        st.loadError = message(error);
        if (entry.custom) explainFailure(entry, st.loadError);
      })
      .finally(() => {
        if (controller.signal.aborted) return;
        // An opened bundle keeps the row loading until its stage is in (showPreview).
        if (!st.bundle) st.loading = null;
        ui.invalidate();
      });
  };

  const back = (key?: boolean) => {
    if (st.screen === 'cast') {
      // The cursor comes back to Dancers.
      go('preview', false);
      if (key || ui.keyboard) ui.focus({ id: 'dancers', rect: DANCERS });
      return;
    }
    if (st.screen === 'preview') { closePreview(); go('list', key); return; }
    // Escape counts as the keyboard: the cursor comes along to the players screen.
    if (key && !ui.keyboard) ui.focus({ id: 'back', circle: BACK });
    st.loading?.controller.abort();
    st.loading = null;
    props.current.onBack?.();
  };
  // An imported song that won't open: another tab may have replaced or removed it since the list
  // loaded (then the list updates), or it's damaged (Settings → Songs removes it).
  const explainFailure = (entry: ListedSong, reason: string) => {
    savedCustomSong(entry.id)
      .then((saved) => {
        if (!props.current.visible || st.next !== 'list' || st.loading) return;
        if (saved && saved.sha256 === entry.sha256 && saved.bundleRevision === entry.bundleRevision) {
          st.loadError = `“${entry.title}” can't be played: ${reason} You can remove it in Settings.`;
        } else {
          st.loadError = `“${entry.title}” has changed since the list loaded.`;
          fetchCatalog(saved ? entry.key : undefined);
        }
      })
      .catch(() => { /* The saved copy can't be read either: the load error stands. */ })
      .finally(() => ui.invalidate());
  };
  const dance = () => {
    const { bundle } = st;
    if (!bundle) return;
    const picked = cast();
    closePreview();
    props.current.onDance?.(bundle, picked);
  };

  // The Dancers panel: a column per player, with a cutout of each of the song's dancers. The
  // one they dance waves (its outer hand) in their colour; the rest stand faint, brightening
  // under the pointer.
  const drawCast = (g: CanvasRenderingContext2D, s: CanvasUI<SongWidget>) => {
    const players = props.current.playerCount, n = dancers(), picks = cast(), h = s.hover;
    const panel = castPanel(players);
    drawShadowText(g, CAST_HINTS[players - 1], panel.x + 6, panel.y - 28, { size: 22, weight: 700, color: '#d8f6ff' });
    drawDarkGlassPanel(g, panel, 30);
    for (let player = 0; player < players; player++) {
      const column = castColumn(player);
      const look = PLAYERS[player];
      const cx = column.x + column.w / 2;
      // The keyboard cursor on the column leaves the pointer over whichever cutout is in its
      // middle: then the column lights up, not that cutout.
      const keyed = s.keyFocus === `cast-${player}`;
      const slotHover = (dancer: number) => (keyed ? 0 : h[`cast-${player}-${dancer}`] ?? 0);
      const over = keyed ? 1 : Math.max(h[`cast-${player}`] ?? 0, ...Array.from({ length: n }, (_, d) => slotHover(d)));
      g.save();
      if (over > 0.01) {
        roundRect(g, column.x + 8, column.y + 8, column.w - 16, column.h - 16, 22);
        g.fillStyle = `rgba(255, 255, 255, ${0.08 * over})`;
        g.fill();
      }
      if (player) {
        g.fillStyle = 'rgba(255, 255, 255, 0.22)';
        g.fillRect(column.x - 1, column.y + 26, 2, column.h - 52);
      }
      g.restore();
      drawCaps(g, `PLAYER ${player + 1}`, cx, column.y + 28, { size: 16, align: 'center' });
      for (let dancer = 0; dancer < n; dancer++) {
        const slot = castSlot(n)(player)(dancer);
        const height = Math.min(slot.h - 12, slot.w * 1.4);
        const x = slot.x + slot.w / 2, foot = slot.y + slot.h - 8;
        const wave = WAVES[dancer < (n - 1) / 2 ? 0 : 1];
        g.save();
        if (picks[player] === dancer) {
          // A white rim: the outline stroked wide, then the cutout filled over its inner half.
          g.shadowColor = 'rgba(0, 30, 50, 0.6)';
          g.shadowBlur = 8;
          g.shadowOffsetY = 3;
          traceAeroCutout(g, x, foot, height, wave);
          g.lineWidth = 5;
          g.lineJoin = 'round';
          g.strokeStyle = '#ffffff';
          g.stroke();
          g.shadowColor = 'transparent';
          const fill = g.createLinearGradient(0, foot - height, 0, foot);
          fill.addColorStop(0, look.light);
          fill.addColorStop(1, look.color);
          drawAeroCutout(g, x, foot, height, { fill, pose: wave });
        } else {
          drawAeroCutout(g, x, foot, height, { fill: `rgba(255, 255, 255, ${0.3 + 0.4 * slotHover(dancer)})`, eyes: 'rgba(12, 47, 82, 0.5)' });
        }
        g.restore();
      }
      drawShadowText(g, `Dancer ${picks[player] + 1}`, cx, column.y + column.h - 26, { size: 22, weight: 800, align: 'center', color: look.light });
    }
    drawGlassButton(g, CAST_AUTO, { label: 'Auto', sub: 'Where you stand', icon: 'replay', hover: h.auto ?? 0, press: s.press * (h.auto ?? 0) });
  };

  const ui = useCanvasUI<SongWidget>({
    priority: 2,
    active: live,
    keyNav: true,
    widgets: () => {
      const danceButton: SongWidget = { id: 'dance', rect: DANCE, corner: glassCorner(DANCE.h), primary: true };
      // A solo has nobody else to dance.
      if (st.screen === 'preview') return [{ id: 'back', circle: BACK }, ...(dancers() > 1 ? [{ id: 'dancers', rect: DANCERS, corner: glassCorner(DANCERS.h) }] : []), danceButton];
      if (st.screen === 'cast') {
        const players = Array.from({ length: props.current.playerCount }, (_, player) => player);
        // Each dancer's cutout picks them (before its column, which is under it), and the
        // column steps through them with Left/Right or a press.
        const slots = players.flatMap((player) => Array.from({ length: dancers() }, (_, dancer): SongWidget => ({ id: `cast-${player}-${dancer}`, rect: castSlot(dancers())(player)(dancer), corner: 12, nav: false })));
        return [{ id: 'back', circle: BACK }, ...slots, ...players.map(castWidget), { id: 'auto', rect: CAST_AUTO, corner: glassCorner(CAST_AUTO.h) }, danceButton];
      }
      const list: SongWidget[] = [{ id: 'back', circle: BACK }];
      if (st.catalog.status === 'ready') {
        if (!st.loading) pageSongs().forEach((song, i) => list.push(songWidget(song, i)));
        if (st.page > 0) list.push({ id: 'page-up', circle: PAGE_UP });
        if (st.page < pages() - 1) list.push({ id: 'page-down', circle: PAGE_DOWN });
      }
      if (st.catalog.status === 'error') list.push({ id: 'retry', rect: RETRY, corner: glassCorner(RETRY.h), primary: true });
      return list;
    },
    onActivate: (wdg, s) => {
      const picked = /^cast-(\d)-(\d)$/.exec(wdg.id), column = /^cast-(\d)$/.exec(wdg.id);
      if (wdg.song) chooseSong(wdg.song);
      else if (picked) pick(Number(picked[1]), Number(picked[2]));
      else if (column) step(Number(column[1]), 1);
      else if (wdg.id === 'dancers') go('cast');
      else if (wdg.id === 'auto') recast(null);
      else if (wdg.id === 'back') back();
      else if (wdg.id === 'page-up' || wdg.id === 'page-down') {
        const up = wdg.id === 'page-up';
        st.page = Math.min(pages() - 1, Math.max(0, st.page + (up ? -1 : 1)));
        // The keyboard cursor stays on the arrow, or once it's gone (the first or last page),
        // goes to the song beside it: the last one going up, the first going down.
        const arrow = up ? st.page > 0 : st.page < pages() - 1;
        const row = up ? pageSongs().length - 1 : 0;
        if (s.keyboard && !arrow && row >= 0) s.focus(songWidget(pageSongs()[row], row));
      }
      else if (wdg.id === 'retry') fetchCatalog();
      else if (wdg.id === 'dance') dance();
      s.invalidate();
    },
    // Left/Right on a player's column picks the dancer beside theirs.
    onStep: (wdg, dir, s, repeat) => {
      const column = /^cast-(\d)$/.exec(wdg.id);
      if (!column || !live()) return false;
      if (!repeat) step(Number(column[1]), dir);
      s.invalidate();
      return true;
    },
    onKey: (e, s) => {
      // A held key shouldn't run through screens.
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
      const casting = p.visible && st.next === 'cast';
      if (casting !== st.casting) { st.casting = casting; p.onCastingChange?.(casting); }
      // A chosen song waits on the list until its stage is prepared (or failed).
      if (st.bundle && st.loading && st.next === 'list') {
        const want = resolveStage(st.bundle.song.stage);
        if (p.stageState.stage === want && (p.stageState.prepared || p.stageState.failed)) showPreview();
      }
      const c = p.connection;
      const slots = Array.from({ length: p.playerCount }, (_, i) => slotStatus(c, i).label);
      const key = [
        st.screen, st.catalog.status, st.page, st.loading?.id, st.loadError, st.previewState, st.previewError,
        p.stageState.stage, p.stageState.ready, p.stageState.failed, st.bundle ? cast().join() : '',
      ].join('~');
      if (key !== st.drawn) { st.drawn = key; s.invalidate(); }
      if (st.catalog.status === 'loading' || st.loading) s.invalidate();

      const report = {
        songScreen: st.screen,
        songReady: String(live() && st.swap > 0.95),
        catalog: st.catalog.status === 'ready' && !songs().length ? 'empty' : st.catalog.status,
        songCount: String(songs().length),
        customSongCount: String(songs().filter((song) => song.custom).length),
        songDancers: st.catalog.status === 'ready' ? pageSongs().map(songDancers).join('|') : '',
        songLoadError: st.loadError,
        playerSlots: slots.join('|'),
        previewState: st.screen !== 'list' ? (st.previewError ? 'error' : st.previewState) : '',
        previewTimeMs: st.routine ? String(Math.round(st.routine.timeMs())) : '',
        cast: st.bundle ? cast().join('|') : '',
        castAuto: st.bundle ? String(!st.cast) : '',
      };
      const json = JSON.stringify(report);
      if (json !== st.reported) { st.reported = json; Object.assign(gl.domElement.dataset, report); }
    },
    opacity: () => st.alpha,
    draw: (g, s) => {
      const p = props.current;
      const h = s.hover;
      const press = (id: string) => s.press * (h[id] ?? 0);
      const t = st.swap;
      g.save();
      g.globalAlpha = t;
      g.translate((1 - t) * -24, 0);

      if (st.screen === 'list') {
        drawHeader(g, BACK, 'SONG SELECT', h.back ?? 0);

        const dots = '.'.repeat(1 + (Math.floor(s.time * 3) % 3));
        const list = songs();
        if (st.catalog.status === 'loading') {
          drawShadowText(g, `Loading songs${dots}`, ROWS.x, ROWS.y + 46, { size: 30, weight: 700 });
        } else if (st.catalog.status === 'error') {
          g.font = `700 28px ${FONT}`;
          drawShadowText(g, ellipsize(g, st.catalog.error, ROWS.w), ROWS.x, ROWS.y + 46, { size: 28, color: '#ffb38a' });
          drawGlassButton(g, RETRY, { label: 'Retry', icon: 'replay', hover: h.retry ?? 0, press: press('retry') });
        } else if (!list.length) {
          // Songs published before three and four players were supported only list one and two.
          const others = st.catalog.songs.length > 0;
          const heading = others ? `No songs for ${COUNT_NAMES[p.playerCount - 1].toLowerCase()} yet` : 'The first routine is on its way';
          // Smaller where it would run past the list (the 4:3 list is narrower).
          g.font = `800 38px ${FONT}`;
          const size = Math.min(38, Math.floor((38 * ROWS.w) / g.measureText(heading).width));
          drawShadowText(g, heading, ROWS.x, ROWS.y + 40, { size, weight: 800 });
          g.save();
          g.shadowColor = 'rgba(0, 34, 84, 0.75)';
          g.shadowBlur = 5;
          g.shadowOffsetY = 2;
          paragraph(g, others
            ? 'Re-export these songs from Dance Studio to dance them with three or four players, or pick fewer players.'
            : CUSTOM_SONGS ? 'No playable songs have been published yet. Import one exported from Dance Studio in Settings → Songs.'
              : 'No playable songs have been published yet. Each routine needs music and choreography for both players.', ROWS.x, ROWS.y + 96, ROWS.w, { size: 25, color: '#ffffff' });
          g.restore();
        } else {
          pageSongs().forEach((song, i) => {
            const rect = rowRect(i);
            const id = `song-${song.key}`;
            const loadingThis = st.loading?.id === song.key;
            const best = bestScore(song.key, p.playerCount, SCORER_VERSION);
            // Catalog difficulty is free-form display text.
            const difficulty = typeof song.difficulty === 'string' || typeof song.difficulty === 'number' ? String(song.difficulty) : 'Routine';
            const sub = loadingThis ? `Loading${dots}` : [song.custom ? 'Custom' : null, song.artist, difficulty, song.stage ? resolveStage(song.stage) : null,
              best ? `Best ${best.score.toLocaleString('en-US')} ${best.grade}` : null].filter(Boolean).join(' · ');
            // (The button shortens the title and line under it to fit.)
            drawGlassButton(g, rect, {
              label: song.title, sub, icon: 'note',
              hover: h[id] ?? 0, press: press(id), disabled: !!st.loading && !loadingThis,
              trailing: dancerCutouts(songDancers(song), rect.h),
            });
          });
          if (pages() > 1) {
            const pagers: [Circle, string, IconName, boolean][] = [[PAGE_UP, 'page-up', 'up', st.page > 0], [PAGE_DOWN, 'page-down', 'down', st.page < pages() - 1]];
            for (const [c, id, icon, on] of pagers) {
              g.save();
              if (!on) g.globalAlpha *= 0.35;
              drawGlassCircle(g, c, on ? h[id] ?? 0 : 0);
              g.lineWidth = 4;
              g.lineCap = 'round';
              g.lineJoin = 'round';
              g.strokeStyle = '#ffffff';
              ICONS[icon](g, c.x, c.y, c.r * 1.5);
              g.restore();
            }
            drawShadowText(g, `${st.page + 1}/${pages()}`, PAGE_UP.x, (PAGE_UP.y + PAGE_DOWN.y) / 2, { size: 22, weight: 700, align: 'center' });
          }
        }
        // A song that wouldn't load: two lines at most, under the list.
        if (st.loadError && st.catalog.status === 'ready') {
          g.font = `700 22px ${FONT}`;
          const lines = wrapText(g, st.loadError, ROWS.w + 60);
          const shown = lines.length > 2 ? [lines[0], ellipsize(g, lines.slice(1).join(' '), ROWS.w + 60)] : lines;
          shown.forEach((line, i) => drawShadowText(g, line, ROWS.x, ROWS.y + ROWS.perPage * (ROWS.h + ROWS.gap) + 6 + i * 28, { size: 22, color: '#ffb38a' }));
        }
      } else if (st.bundle) {
        const { song } = st.bundle;
        const casting = st.screen === 'cast';
        drawHeader(g, BACK, casting ? 'DANCERS' : 'PREVIEW', h.back ?? 0);
        g.font = `800 64px ${FONT}`;
        drawShadowText(g, ellipsize(g, song.title, s.w - BACK.x - 90), BACK.x - 38, BACK.y + 84, { size: 64, weight: 800 });
        g.font = `700 30px ${FONT}`;
        drawShadowText(g, ellipsize(g, `${song.artist} · ${resolveStage(song.stage)}`, s.w - BACK.x - 90), BACK.x - 36, BACK.y + 140, { size: 30, color: '#d8f6ff' });

        if (casting) drawCast(g, s);
        else {
          const stageFailed = p.stageState.failed && p.stageState.stage === resolveStage(song.stage);
          const error = st.previewError || (stageFailed ? "This song's stage couldn't load." : p.stageState.dancersFailed ? 'Character preview could not load.' : '');
          const right = dancers() > 1 ? DANCERS.x : DANCE.x;
          if (error) paragraph(g, error, PREVIEW_NOTE.x, PREVIEW_NOTE.y - 42, right - PREVIEW_NOTE.x - 40, { size: 26, color: '#ffb38a' });
          if (dancers() > 1) drawGlassButton(g, DANCERS, { label: 'Dancers', sub: st.cast ? 'Picked' : 'Auto', icon: 'dancers', hover: h.dancers ?? 0, press: press('dancers') });
        }
        drawGlassButton(g, DANCE, { label: 'Dance!', sub: COUNT_NAMES[p.playerCount - 1], icon: 'play', hover: h.dance ?? 0, press: press('dance') });
      }
      g.restore();
    },
  });

  // Frosted glass inside the buttons drawn above (ui/useGlassBlur.ts), fading and sliding with them.
  useGlassBlur(() => {
    const panes = st.screen === 'preview' ? (st.bundle ? [...(dancers() > 1 ? [buttonPane(ui, 'dancers', DANCERS)] : []), buttonPane(ui, 'dance', DANCE)] : [])
      : st.screen === 'cast' ? (st.bundle ? [panelPane(castPanel(props.current.playerCount), 30), buttonPane(ui, 'auto', CAST_AUTO), buttonPane(ui, 'dance', DANCE)] : [])
      : st.catalog.status === 'error' ? [buttonPane(ui, 'retry', RETRY)]
        : st.catalog.status === 'ready' ? pageSongs().map((song, i) => buttonPane(ui, `song-${song.key}`, rowRect(i))) : [];
    return { panes, alpha: st.alpha * st.swap, offsetX: (1 - st.swap) * -24 };
  });

  // Opening Song Select loads the catalog; leaving it stops everything.
  useEffect(() => {
    if (visible) {
      st.screen = st.next = 'list';
      st.swap = 1;
      st.page = 0;
      st.loadError = '';
      fetchCatalog();
      ui.invalidate();
      return undefined;
    }
    st.catalogCtl?.abort();
    st.loading?.controller.abort();
    st.loading = null;
    if (st.bundle) closePreview();
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // A hidden tab pauses the song.
  useEffect(() => {
    // A song still waiting on its stage stays quiet.
    const onVisibility = () => { if (document.hidden) st.player?.pause(); else if (st.next !== 'list') st.player?.play(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [st]);

  useEffect(() => () => {
    st.player?.dispose();
    duckMenuMusic(false);
  }, [st]);

  return null;
}
