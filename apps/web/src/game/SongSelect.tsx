import { useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import {
  FONT, dancerWidth, drawDancer, drawGlassButton, drawHeader, drawShadowText, ellipsize, glassCorner, paragraph, roundRect, wrapText,
} from '../ui/draw.ts';
import type { Face, IconDraw, Point, Rect } from '../ui/draw.ts';
import useCanvasUI from '../ui/useCanvasUI.ts';
import useGlassBlur, { buttonPane } from '../ui/useGlassBlur.ts';
import type { Widget } from '../ui/useCanvasUI.ts';
import { duckMenuMusic } from '../audio/mixer.ts';
import { createSongPlayer } from '../audio/songPlayer.ts';
import type { SongPlayer } from '../audio/songPlayer.ts';
import { loadSongBundle } from '../songs/loadBundle.ts';
import type { LoadedSongBundle } from '../songs/loadBundle.ts';
import { customScoreId, customSongsSupported, listCustomSongs, loadCustomSong, savedCustomSong } from '../songs/customSongs.ts';
import { dancersOf, defaultCast, isCast, leadOf, validateCatalog } from '../../../../packages/pose/song.ts';
import type { Cast, CatalogSong } from '../../../../packages/pose/song.ts';
import type { PlayerCount } from '../../../../packages/pose/choreography.ts';
import { SCORER_VERSION } from '../../../../packages/score/scorer.ts';
import { bestScore } from './bestScores.ts';
import { PLAYERS } from './results.ts';
import type { SongRoutine } from './GameSession.ts';
import type { PoseInputView, PoseSource } from '../pose/PoseSource.ts';
import { preloadStage, resolveStage } from '../../../../packages/stages/index.ts';
import type { StageState } from '../stage/StageView.tsx';
import { gameLayout } from './layout.ts';
import { displayDesign } from '../display.ts';

/**
 * Song Select, drawn in-engine after the player count is picked (menu/MainMenu.tsx).
 *
 *   list     the published songs (songs/manifest.json, found by scripts/songCatalog.ts),
 *            then the songs imported into this browser or app (songs/customSongs.ts; Settings →
 *            Songs imports and removes them), each with a cutout of every dancer it has in
 *            the colour of the player following them. Five are in view at a time; the wheel,
 *            a drag (or swipe) and the keyboard cursor scroll the rest in, a row at a time
 *   preview  a song's music with its reference dancers on the song's stage (StageView,
 *            mounted by App from onPreviewChange; each song's stage is picked in Dance
 *            Studio), the music looping on its own while the stage camera circles them,
 *            and Dance!, which hands the bundle and the cast to the game (onDance); the menu
 *            music ducks underneath. A song with more than one dancer has Dancers beside it
 *   dancers  which dancer each player follows (the cast): players take the dancers in turn
 *            until they pick (Auto goes back to that), and the dancers on the stage, faced
 *            from the front, change colour with them. Picks last while the game is open.
 *
 * Choosing a song keeps the list up, its row loading, until the preview can show at once: the
 * bundle loads (fully verified, songs/loadBundle.ts) while the stage's code downloads, then the
 * stage is built and compiled out of sight (StageView's `prepared`) and the preview opens.
 * Back / Escape go from the dancers to the preview, from the preview to the list and from the
 * list to the player count.
 * The canvas reports data-song-screen, -song-ready, -catalog, -song-count, -custom-song-count,
 * -song-load-error, -player-slots, -preview-state, -preview-time-ms, -song-dancers and
 * -song-cast (the dancer each player follows, from 0) and -song-list-top (the first song in view)
 * for tests.
 *
 * <SongSelect visible playerCount={1} source={source} onBack
 *   stageState={{ showing, prepared, ready, stage, failed }} onPreviewChange onScreenChange onDance />
 */

export interface SongSelectProps {
  visible?: boolean;
  playerCount?: PlayerCount;
  source: Pick<PoseSource, 'view'>;
  onBack?: () => void;
  stageState?: Partial<StageState>;
  /** The routine to preview on its stage, or null when the preview closes. */
  onPreviewChange?: (routine: SongRoutine | null) => void;
  /** The screen being shown or going in. */
  onScreenChange?: (screen: SongScreen) => void;
  onDance?: (bundle: LoadedSongBundle, cast: Cast) => void;
}
export type SongScreen = 'list' | 'preview' | 'dancers';
type CatalogStatus = 'idle' | 'loading' | 'ready' | 'error';
type PreviewState = 'loading' | 'error' | SongPlayer['state'];
/** A listed song: published, or imported into this browser or app (custom). key tells them apart in the list. */
type ListedSong = CatalogSong & { custom: boolean; key: string };
/** A song row, or a player's row on the dancers screen. */
type SongWidget = Widget & { song?: ListedSong; player?: number };
interface SongSelectState {
  alpha: number; screen: SongScreen; next: SongScreen; swap: number;
  /** The list's first song in view, and where the list is on its way there (in rows). */
  top: number; scroll: number;
  /** Wheel travel short of a whole row, in rows. */
  wheel: number;
  /** A press on the list: where it went down, and once it moves, the drag scrolling the list. */
  listDrag: { id: number; y: number; scroll: number; moved: boolean; velocity: number; at: number } | null;
  /** The keyboard cursor's widget the list last scrolled to. */
  followed: string | null;
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
  previewState: PreviewState;
  previewError: string;
  /** The dancer each player follows in the open song. */
  cast: number[];
  /** The casts picked while the game is open, by castKey. */
  casts: Map<string, number[]>;
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

// The song's music plays on the preview and its dancers screen.
const playsMusic = (screen: SongScreen) => screen !== 'list';
const castKey = (key: string, playerCount: number) => `${key}|${playerCount}`;
const sameCast = (a: Cast, b: Cast) => a.length === b.length && a.every((d, i) => d === b[i]);
const inside = (p: Point, r: Rect) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
// A player's colours, light to dark: their disc, and the dancer they follow.
const playerFace = (id: number): Face => [PLAYERS[id].light, PLAYERS[id].color, PLAYERS[id].dark];
// A dancer nobody follows, or on a player's row one they don't: an empty spot on the glass.
const SPARE = 'rgba(255, 255, 255, 0.3)';
const SPARE_HOVER = 'rgba(255, 255, 255, 0.6)';
// A press on the list that travels this far (design units) drags it instead of choosing a song.
const DRAG_SLOP = 14;
// A released drag carries on for this long at the speed it was going.
const FLING_S = 0.2;

function faceFill(g: CanvasRenderingContext2D, face: Face, top: number, bottom: number) {
  const fill = g.createLinearGradient(0, top, 0, bottom);
  face.forEach((color, i) => fill.addColorStop(i / 2, color));
  return fill;
}

// A song's dancers side by side, ending at `right`, each `h` tall on `floor`, hands overlapping
// (castWidth across): each in the colour of the first player following them, or an empty spot.
function drawCast(g: CanvasRenderingContext2D, right: number, floor: number, h: number, dancers: number, cast: Cast) {
  const w = dancerWidth(h), step = w * 0.8;
  g.save();
  shadowed(g);
  for (let d = 0; d < dancers; d++) {
    const lead = leadOf(cast, d);
    const cx = right - w / 2 - (dancers - 1 - d) * step;
    drawDancer(g, cx, floor, h, lead < 0 ? SPARE : faceFill(g, playerFace(lead), floor - h, floor));
  }
  g.restore();
}
// Cutouts on the glass are shadowed like its icons and labels.
function shadowed(g: CanvasRenderingContext2D) {
  g.shadowColor = 'rgba(0, 30, 50, 0.45)';
  g.shadowBlur = 6;
  g.shadowOffsetY = 2;
}
const castWidth = (h: number, dancers: number) => dancerWidth(h) * (1 + 0.8 * (dancers - 1));
// The cutouts in a song's row: their height and the gap to the pill's right end.
const rowCutout = (rowH: number) => ({ h: Math.round(rowH * 0.68), right: rowH * 0.4 });

// The dancers on a player's row, ending at its right: where each can be picked, and drawn
// (inset) on its spot.
function castSlots(row: Rect, dancers: number): Rect[] {
  const h = row.h - 12, w = Math.round(dancerWidth(h * 0.8) + 18);
  const end = row.x + row.w - row.h * 0.36;
  return Array.from({ length: dancers }, (_, d) => ({ x: end - (dancers - d) * w - (dancers - 1 - d) * 4, y: row.y + 6, w, h }));
}
// A player's pick on their row: a lit spot behind the dancer, rimmed in their colour.
function drawPicked(g: CanvasRenderingContext2D, slot: Rect, face: Face) {
  g.save();
  roundRect(g, slot.x, slot.y, slot.w, slot.h, 14);
  g.fillStyle = 'rgba(255, 255, 255, 0.2)';
  g.fill();
  g.lineWidth = 3;
  g.strokeStyle = face[0];
  g.stroke();
  g.restore();
}
// The player's number on a disc in their colour, where a glass button has its icon.
const playerGlyph = (id: number): IconDraw => (g, cx, cy, r) => {
  const d = r * 0.9;
  g.beginPath();
  g.arc(cx, cy, d, 0, Math.PI * 2);
  g.fillStyle = faceFill(g, playerFace(id), cy - d, cy + d);
  g.fill();
  g.lineWidth = 2;
  g.strokeStyle = 'rgba(255, 255, 255, 0.8)';
  g.stroke();
  g.shadowColor = 'transparent';
  g.fillStyle = '#ffffff';
  g.font = `800 ${Math.round(d * 1.25)}px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(id + 1), cx, cy + d * 0.06);
};

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
  visible = false, playerCount = 1, source, onBack,
  stageState = {}, onPreviewChange, onScreenChange, onDance,
}: SongSelectProps) {
  const gl = useThree((state) => state.gl);
  const size = useThree((state) => state.size);
  const {
    BACK, CAST_AUTO, DANCE, DANCERS, PREVIEW_NOTE, RETRY, ROWS, SCROLLBAR, castRow, rowRect,
  } = gameLayout(displayDesign(size.width, size.height).w);
  const step = ROWS.h + ROWS.gap;
  const props = useRef({ visible, playerCount, source, onBack, stageState, onPreviewChange, onScreenChange, onDance });
  props.current = { visible, playerCount, source, onBack, stageState, onPreviewChange, onScreenChange, onDance };
  const st = useRef<SongSelectState>({
    alpha: 0, screen: 'list', next: 'list', swap: 1, top: 0, scroll: 0, wheel: 0, listDrag: null, followed: null,
    catalog: { status: 'idle', songs: [], error: '' }, catalogCtl: null,
    loading: null, chosen: null, loadError: '',
    bundle: null, player: null, routine: null, previewState: 'loading', previewError: '',
    cast: [], casts: new Map(),
    drawn: '', reported: '',
  }).current;

  const songs = () => st.catalog.songs.filter((song) => song.supportedPlayerCounts.includes(props.current.playerCount));
  const lastTop = () => Math.max(0, songs().length - ROWS.shown);
  const scrollTo = (top: number) => {
    st.top = Math.min(lastTop(), Math.max(0, Math.round(top)));
    ui.invalidate();
  };
  // Scrolls the list just far enough to bring the ith song into view.
  const reveal = (i: number) => scrollTo(Math.min(i, Math.max(st.top, i - ROWS.shown + 1)));
  // The ith song's row where the list is now, and how much of it is in view (0..1): rows fade
  // as they scroll out past either end.
  const songRect = (i: number) => rowRect(i - st.scroll);
  const inView = (i: number) => {
    const d = i - st.scroll;
    return Math.min(1, Math.max(0, Math.min(d + 1, ROWS.shown - d)));
  };
  // The songs with any of their row in view.
  const viewRange = () => [Math.max(0, Math.floor(st.scroll)), Math.min(songs().length, Math.ceil(st.scroll) + ROWS.shown)] as const;
  const live = () => props.current.visible && st.alpha > 0.3 && st.screen === st.next;
  // The song opened last is the primary one while it's in view, else the first in view.
  const primaryRow = () => {
    const i = songs().findIndex((song) => song.key === st.chosen);
    return i >= st.top && i < st.top + ROWS.shown ? i : st.top;
  };
  // Every song is a widget, so the keyboard cursor can step onto the next one out of view (the
  // list scrolls to it); only those in view take the pointer.
  const songWidget = (song: ListedSong, i: number, primary = primaryRow()): SongWidget => {
    const rect = songRect(i);
    return { id: `song-${song.key}`, song, rect, corner: glassCorner(rect.h), primary: i === primary, hit: inView(i) > 0.5 };
  };
  const castWidget = (player: number): SongWidget => {
    const rect = castRow(player, props.current.playerCount);
    return { id: `cast-${player}`, player, rect, corner: glassCorner(rect.h) };
  };
  // The preview's and the dancers screen's buttons besides the players'.
  const button = (id: string, rect: Rect, primary = false): SongWidget => ({ id, rect, corner: glassCorner(rect.h), primary });
  // The open song's dancers.
  const dancers = () => st.bundle?.choreography.tracks.length ?? 1;
  // A listed song's cast: the one picked for it, or the players taking its dancers in turn.
  const castOf = (song: ListedSong) => {
    const count = props.current.playerCount, picked = st.casts.get(castKey(song.key, count));
    return picked && isCast(picked, count, dancersOf(song)) ? picked : defaultCast(count, dancersOf(song));
  };
  // The keyboard cursor starts over on the next screen: on the dancers screen at the first
  // player; back on the list (also by Escape), on the song it opened; and back on the preview,
  // on Dancers.
  const go = (screen: SongScreen, key = ui.keyboard) => {
    if (screen === st.next) return;
    const from = st.next;
    st.next = screen;
    props.current.onScreenChange?.(screen);
    if (!key) return;
    const i = screen === 'list' ? songs().findIndex((song) => song.key === st.chosen) : -1;
    ui.focus(i >= 0 ? songWidget(songs()[i], i)
      : screen === 'dancers' ? castWidget(0)
        : screen === 'preview' && from === 'dancers' ? button('dancers', DANCERS) : null);
  };
  // Picks who follows which dancer: the preview's dancers change colour with it.
  const setCast = (cast: number[]) => {
    if (!st.bundle || !st.routine || !st.chosen) return;
    const count = props.current.playerCount;
    st.cast = cast;
    if (sameCast(cast, defaultCast(count, dancers()))) st.casts.delete(castKey(st.chosen, count));
    else st.casts.set(castKey(st.chosen, count), cast);
    st.routine = { ...st.routine, cast };
    props.current.onPreviewChange?.(st.routine);
  };
  const pick = (player: number, dancer: number) => setCast(st.cast.map((d, i) => (i === player ? dancer : d)));

  // Loads the published and imported songs. With show (a song's key), the list scrolls to it and
  // the keyboard cursor, if out, goes to it; otherwise the list stays where it was.
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
        if (i >= 0) reveal(i);
        else scrollTo(st.top);
        if (i >= 0 && ui.keyboard && st.next === 'list') ui.focus(songWidget(songs()[i], i));
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
    const count = props.current.playerCount, picked = st.chosen ? st.casts.get(castKey(st.chosen, count)) : undefined;
    st.bundle = bundle;
    st.previewState = 'loading';
    st.previewError = '';
    st.cast = picked && isCast(picked, count, dancers()) ? picked : defaultCast(count, dancers());
    const routine: SongRoutine = {
      bundle,
      cast: st.cast,
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
        if (!document.hidden && playsMusic(st.next)) player.play();
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
    if (st.next === 'dancers') { go('preview', key); return; }
    if (st.screen === 'preview' || st.screen === 'dancers') { closePreview(); go('list', key); return; }
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
    const { bundle, cast } = st;
    if (!bundle) return;
    closePreview();
    props.current.onDance?.(bundle, cast);
  };
  // The dancer under the pointer on a player's row, or -1 (the keyboard cursor points at none).
  const slotAt = (wdg: SongWidget, s: { pointer: Point | null; pointerKind: string | null }) => {
    if (!wdg.rect || !s.pointer || s.pointerKind === 'key') return -1;
    const { pointer } = s;
    return castSlots(wdg.rect, dancers()).findIndex((slot) => inside(pointer, slot));
  };

  const ui = useCanvasUI<SongWidget>({
    priority: 2,
    active: live,
    keyNav: true,
    widgets: () => {
      if (st.screen === 'dancers') {
        return [{ id: 'back', circle: BACK }, ...st.cast.map((_, i) => castWidget(i)), button('auto', CAST_AUTO), button('dance', DANCE, true)];
      }
      if (st.screen === 'preview') {
        return [{ id: 'back', circle: BACK }, ...(dancers() > 1 ? [button('dancers', DANCERS)] : []), button('dance', DANCE, true)];
      }
      const list: SongWidget[] = [{ id: 'back', circle: BACK }];
      if (st.catalog.status === 'ready') {
        const primary = primaryRow();
        if (!st.loading) songs().forEach((song, i) => list.push(songWidget(song, i, primary)));
      }
      if (st.catalog.status === 'error') list.push(button('retry', RETRY, true));
      return list;
    },
    onActivate: (wdg, s) => {
      if (wdg.song) chooseSong(wdg.song);
      // A dancer on the player's row, or (the keyboard, or beside them) the next one.
      else if (wdg.player !== undefined) {
        const slot = slotAt(wdg, s);
        pick(wdg.player, slot >= 0 ? slot : (st.cast[wdg.player] + 1) % dancers());
      } else if (wdg.id === 'dancers') go('dancers');
      else if (wdg.id === 'auto') setCast(defaultCast(props.current.playerCount, dancers()));
      else if (wdg.id === 'back') back();
      else if (wdg.id === 'retry') fetchCatalog();
      else if (wdg.id === 'dance') dance();
      s.invalidate();
    },
    // Left / Right on a player's row step through the dancers.
    onStep: (wdg, dir) => {
      if (wdg.player === undefined) return false;
      pick(wdg.player, (st.cast[wdg.player] + dir + dancers()) % dancers());
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
      // The list scrolls to the song the keyboard cursor steps onto, and eases to its top row
      // (a drag moves it directly).
      if (s.keyFocus !== st.followed) {
        st.followed = s.keyFocus;
        const i = songs().findIndex((song) => `song-${song.key}` === s.keyFocus);
        if (i >= 0) reveal(i);
      }
      st.top = Math.min(st.top, lastTop());
      if (!st.listDrag?.moved) st.scroll = s.ease(st.scroll, st.top, 14);
      // A chosen song waits on the list until its stage is prepared (or failed).
      if (st.bundle && st.loading && st.next === 'list') {
        const want = resolveStage(st.bundle.song.stage);
        if (p.stageState.stage === want && (p.stageState.prepared || p.stageState.failed)) showPreview();
      }
      // Pose packets arrive far more often than the React tree needs to change.
      // Read the current view alongside the rest of the canvas's live state.
      const c = p.source.view;
      const slots = Array.from({ length: p.playerCount }, (_, i) => slotStatus(c, i).label);
      // The dancer under the pointer lights up on its player's row.
      const hovering = st.screen === 'dancers' ? st.cast.map((_, i) => slotAt(castWidget(i), s)).join() : '';
      const key = [
        st.screen, st.catalog.status, st.top, st.loading?.id, st.loadError, st.previewState, st.previewError,
        p.stageState.stage, p.stageState.ready, p.stageState.failed, st.cast.join(), hovering,
      ].join('~');
      if (key !== st.drawn) { st.drawn = key; s.invalidate(); }
      if (st.catalog.status === 'loading' || st.loading) s.invalidate();

      const report = {
        songScreen: st.screen,
        songReady: String(live() && st.swap > 0.95),
        catalog: st.catalog.status === 'ready' && !songs().length ? 'empty' : st.catalog.status,
        songCount: String(songs().length),
        customSongCount: String(songs().filter((song) => song.custom).length),
        songLoadError: st.loadError,
        playerSlots: slots.join('|'),
        previewState: st.screen === 'preview' ? (st.previewError ? 'error' : st.previewState) : '',
        previewTimeMs: st.routine ? String(Math.round(st.routine.timeMs())) : '',
        songDancers: st.bundle ? String(dancers()) : '',
        songCast: st.bundle ? st.cast.join('|') : '',
        songListTop: String(st.top),
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
              : 'No playable songs have been published yet. Each routine needs music and choreography for its dancers.', ROWS.x, ROWS.y + 96, ROWS.w, { size: 25, color: '#ffffff' });
          g.restore();
        } else {
          const [first, end] = viewRange();
          for (let i = first; i < end; i++) {
            const song = list[i], shown = inView(i);
            if (shown <= 0) continue;
            const rect = songRect(i);
            const id = `song-${song.key}`;
            const loadingThis = st.loading?.id === song.key;
            // Every dancer the song has, at the row's right end.
            const cutout = rowCutout(rect.h), count = dancersOf(song), cast = castOf(song);
            const best = bestScore(song.key, p.playerCount, SCORER_VERSION);
            // Catalog difficulty is free-form display text.
            const difficulty = typeof song.difficulty === 'string' || typeof song.difficulty === 'number' ? String(song.difficulty) : 'Routine';
            const sub = loadingThis ? `Loading${dots}` : [song.custom ? 'Custom' : null, song.artist, difficulty, song.stage ? resolveStage(song.stage) : null,
              best ? `Best ${best.score.toLocaleString('en-US')} ${best.grade}` : null].filter(Boolean).join(' · ');
            // (The button shortens the title and line under it to stop short of the dancers.)
            g.save();
            g.globalAlpha *= shown;
            drawGlassButton(g, rect, {
              label: song.title, sub, icon: 'note', reserve: cutout.right + castWidth(cutout.h, count) + 10 - rect.h * 0.3,
              hover: h[id] ?? 0, press: press(id), disabled: !!st.loading && !loadingThis,
              content: (c, r) => drawCast(c, r.x + r.w - cutout.right, r.y + (r.h + cutout.h) / 2, cutout.h, count, cast),
            });
            g.restore();
          }
          // More songs than fit: a scrollbar beside them, its thumb the share in view.
          if (list.length > ROWS.shown) {
            const bar = SCROLLBAR, thumb = Math.max(bar.w * 5, (bar.h * ROWS.shown) / list.length);
            g.save();
            roundRect(g, bar.x, bar.y, bar.w, bar.h, bar.w / 2);
            g.fillStyle = 'rgba(0, 30, 60, 0.3)';
            g.fill();
            g.lineWidth = 1.5;
            g.strokeStyle = 'rgba(255, 255, 255, 0.45)';
            g.stroke();
            shadowed(g);
            roundRect(g, bar.x, bar.y + ((bar.h - thumb) * st.scroll) / lastTop(), bar.w, thumb, bar.w / 2);
            g.fillStyle = '#ffffff';
            g.fill();
            g.restore();
          }
        }
        // A song that wouldn't load: two lines at most, under the list.
        if (st.loadError && st.catalog.status === 'ready') {
          g.font = `700 22px ${FONT}`;
          const lines = wrapText(g, st.loadError, ROWS.w + 60);
          const shown = lines.length > 2 ? [lines[0], ellipsize(g, lines.slice(1).join(' '), ROWS.w + 60)] : lines;
          shown.forEach((line, i) => drawShadowText(g, line, ROWS.x, ROWS.y + ROWS.shown * step + 6 + i * 28, { size: 22, color: '#ffb38a' }));
        }
      } else if (st.bundle && st.screen === 'dancers') {
        const { song } = st.bundle;
        const count = dancers();
        drawHeader(g, BACK, 'DANCERS', h.back ?? 0);
        g.font = `800 64px ${FONT}`;
        drawShadowText(g, ellipsize(g, song.title, s.w - BACK.x - 90), BACK.x - 38, BACK.y + 84, { size: 64, weight: 800 });
        g.font = `700 30px ${FONT}`;
        drawShadowText(g, ellipsize(g, `Pick the dancer each player follows · ${count} dancers`, s.w - BACK.x - 90), BACK.x - 36, BACK.y + 140, { size: 30, color: '#d8f6ff' });
        st.cast.forEach((dancer, player) => {
          const wdg = castWidget(player);
          const id = wdg.id, hovered = slotAt(wdg, s);
          const sharing = st.cast.flatMap((d, other) => (d === dancer && other !== player ? [`P${other + 1}`] : []));
          const row = castRow(player, p.playerCount);
          // The text stops short of the dancers.
          drawGlassButton(g, row, {
            label: `Player ${player + 1}`,
            sub: `Dancer ${dancer + 1}${sharing.length ? ` · with ${sharing.join(' & ')}` : ''}`,
            reserve: row.x + row.w - row.h * 0.3 - castSlots(row, count)[0].x + 10,
            icon: playerGlyph(player), hover: h[id] ?? 0, press: press(id),
            content: (c, r) => castSlots(r, count).forEach((slot, d) => {
              const tall = slot.h * 0.8, floor = slot.y + (slot.h + tall) / 2;
              if (d === dancer) drawPicked(c, slot, playerFace(player));
              const fill = d === dancer ? faceFill(c, playerFace(player), floor - tall, floor) : d === hovered ? SPARE_HOVER : SPARE;
              c.save();
              shadowed(c);
              drawDancer(c, slot.x + slot.w / 2, floor, tall, fill);
              c.restore();
            }),
          });
        });
        drawGlassButton(g, CAST_AUTO, { label: 'Auto', sub: 'Take turns', icon: 'replay', hover: h.auto ?? 0, press: press('auto') });
        drawGlassButton(g, DANCE, { label: 'Dance!', sub: COUNT_NAMES[p.playerCount - 1], icon: 'play', hover: h.dance ?? 0, press: press('dance') });
      } else if (st.bundle) {
        const { song } = st.bundle;
        drawHeader(g, BACK, 'PREVIEW', h.back ?? 0);
        g.font = `800 64px ${FONT}`;
        drawShadowText(g, ellipsize(g, song.title, s.w - BACK.x - 90), BACK.x - 38, BACK.y + 84, { size: 64, weight: 800 });
        g.font = `700 30px ${FONT}`;
        drawShadowText(g, ellipsize(g, `${song.artist} · ${resolveStage(song.stage)}`, s.w - BACK.x - 90), BACK.x - 36, BACK.y + 140, { size: 30, color: '#d8f6ff' });

        const stageFailed = p.stageState.failed && p.stageState.stage === resolveStage(song.stage);
        const error = st.previewError || (stageFailed ? "This song's stage couldn't load." : p.stageState.dancersFailed ? 'Character preview could not load.' : '');
        const count = dancers();
        if (error) paragraph(g, error, PREVIEW_NOTE.x, PREVIEW_NOTE.y - 42, (count > 1 ? DANCERS.x : DANCE.x) - PREVIEW_NOTE.x - 40, { size: 26, color: '#ffb38a' });
        if (count > 1) {
          const custom = !sameCast(st.cast, defaultCast(p.playerCount, count));
          drawGlassButton(g, DANCERS, { label: 'Dancers', sub: `${count} dancers · ${custom ? 'Picked' : 'Auto'}`, icon: 'dancer', hover: h.dancers ?? 0, press: press('dancers') });
        }
        drawGlassButton(g, DANCE, { label: 'Dance!', sub: COUNT_NAMES[p.playerCount - 1], icon: 'play', hover: h.dance ?? 0, press: press('dance') });
      }
      g.restore();
    },
  });

  // The songs in view, fading with their rows.
  const songPanes = () => {
    const list = songs(), [first, end] = viewRange(), panes = [];
    for (let i = first; i < end; i++) {
      if (inView(i) > 0) panes.push({ ...buttonPane(ui, `song-${list[i].key}`, songRect(i)), alpha: inView(i) });
    }
    return panes;
  };
  // Frosted glass inside the buttons drawn above (ui/useGlassBlur.ts), fading and sliding with them.
  useGlassBlur(() => {
    const pane = (wdg: SongWidget) => buttonPane(ui, wdg.id, wdg.rect ?? DANCE);
    const panes = st.screen === 'dancers' ? (st.bundle ? [...st.cast.map((_, i) => pane(castWidget(i))), pane(button('auto', CAST_AUTO)), pane(button('dance', DANCE))] : [])
      : st.screen === 'preview' ? (st.bundle ? [...(dancers() > 1 ? [pane(button('dancers', DANCERS))] : []), pane(button('dance', DANCE))] : [])
        : st.catalog.status === 'error' ? [buttonPane(ui, 'retry', RETRY)]
          : st.catalog.status === 'ready' ? songPanes() : [];
    return { panes, alpha: st.alpha * st.swap, offsetX: (1 - st.swap) * -24 };
  });

  // Opening Song Select loads the catalog; leaving it stops everything.
  useEffect(() => {
    if (visible) {
      st.screen = st.next = 'list';
      onScreenChange?.('list');
      st.swap = 1;
      st.top = st.scroll = st.wheel = 0;
      st.listDrag = null;
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

  // The list scrolls a row per wheel notch (or per row's height of trackpad travel) and by
  // dragging it: a press on it that moves drags it instead of choosing a song, and settles on a
  // whole row when let go.
  // Scrolling takes over from the keyboard cursor, as the mouse does.
  useEffect(() => {
    const el = gl.domElement;
    const scrolls = () => live() && st.screen === 'list' && st.catalog.status === 'ready' && !st.loading && lastTop() > 0;
    const toDesign = (e: MouseEvent): Point => {
      const r = el.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * ui.w, y: ((e.clientY - r.top) / r.height) * ui.h };
    };
    const onWheel = (e: WheelEvent) => {
      if (!scrolls() || !e.deltaY) return;
      const r = el.getBoundingClientRect();
      // A wheel's notch (big, or in lines or pages) is a row; a trackpad's pixels move the list.
      const rows = e.deltaMode !== 0 || Math.abs(e.deltaY) >= 50 ? Math.sign(e.deltaY) : ((e.deltaY / r.height) * ui.h) / step;
      if (Math.sign(rows) !== Math.sign(st.wheel)) st.wheel = 0;
      st.wheel += rows;
      const whole = Math.trunc(st.wheel);
      if (!whole) return;
      st.wheel -= whole;
      if (ui.keyFocus) ui.focus(null);
      scrollTo(st.top + whole);
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || !scrolls()) return;
      const p = toDesign(e), { ROWS: rows } = gameLayout(ui.w);
      if (p.x < rows.x || p.x > rows.x + rows.w || p.y < rows.y || p.y > rows.y + rows.shown * step) return;
      st.listDrag = { id: e.pointerId, y: p.y, scroll: st.scroll, moved: false, velocity: 0, at: e.timeStamp };
    };
    const onMove = (e: PointerEvent) => {
      const drag = st.listDrag;
      if (!drag || e.pointerId !== drag.id) return;
      const dy = toDesign(e).y - drag.y;
      if (!drag.moved) {
        if (Math.abs(dy) < DRAG_SLOP) return;
        // A drag, not a press: the song under it isn't chosen on release.
        drag.moved = true;
        drag.y += Math.sign(dy) * DRAG_SLOP;
        ui.pressed = null;
        return;
      }
      const scroll = Math.min(lastTop(), Math.max(0, drag.scroll - dy / step));
      const dt = (e.timeStamp - drag.at) / 1000;
      if (dt > 0) drag.velocity = drag.velocity * 0.5 + ((scroll - st.scroll) / dt) * 0.5;
      drag.at = e.timeStamp;
      st.scroll = scroll;
      ui.invalidate();
    };
    const onUp = (e: PointerEvent) => {
      const drag = st.listDrag;
      if (!drag || e.pointerId !== drag.id) return;
      st.listDrag = null;
      // A drag that stopped before letting go doesn't fling.
      if (drag.moved) scrollTo(st.scroll + (e.timeStamp - drag.at < 100 ? drag.velocity * FLING_S : 0));
    };
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, st]);

  // A hidden tab pauses the song.
  useEffect(() => {
    // A song still waiting on its stage stays quiet.
    const onVisibility = () => { if (document.hidden) st.player?.pause(); else if (playsMusic(st.next)) st.player?.play(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [st]);

  useEffect(() => () => {
    st.player?.dispose();
    duckMenuMusic(false);
  }, [st]);

  return null;
}
