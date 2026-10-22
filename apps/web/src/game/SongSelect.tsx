import { useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import {
  FONT, ICONS, drawGlassCircle, drawHeader, drawPill, drawShadowText, ellipsize, paragraph,
} from '../ui/draw.ts';
import type { Circle, IconName } from '../ui/draw.ts';
import useCanvasUI from '../ui/useCanvasUI.ts';
import type { Widget } from '../ui/useCanvasUI.ts';
import { duckMenuMusic } from '../audio/mixer.ts';
import { createSongPlayer } from '../audio/songPlayer.ts';
import type { SongPlayer } from '../audio/songPlayer.ts';
import { loadSongBundle } from '../songs/loadBundle.ts';
import type { LoadedSongBundle } from '../songs/loadBundle.ts';
import { validateCatalog } from '../../../../packages/pose/song.ts';
import type { CatalogSong } from '../../../../packages/pose/song.ts';
import type { PlayerCount } from '../../../../packages/pose/choreography.ts';
import { SCORER_VERSION } from '../../../../packages/score/scorer.ts';
import { bestScore } from './bestScores.ts';
import type { SongRoutine } from './GameSession.ts';
import type { PoseInputView } from '../pose/PoseSource.ts';
import { preloadStage, resolveStage } from '../../../../packages/stages/index.ts';
import type { StageState } from '../stage/StageView.tsx';
import { gameLayout } from './layout.ts';
import { displayDesign } from '../display.ts';

/**
 * Song Select, drawn in-engine after the player count is picked (menu/MainMenu.tsx).
 *
 *   list     the published songs (songs/manifest.json, found by scripts/songCatalog.ts),
 *            four to a page
 *   preview  a song's music with its reference dancers on the song's stage (StageView,
 *            mounted by App from onPreviewChange; each song's stage is picked in Dance
 *            Studio), the music looping on its own while the stage camera circles them,
 *            and Dance!, which hands the bundle to the game (onDance); the menu music
 *            ducks underneath
 *
 * Choosing a song keeps the list up, its row loading, until the preview can show at once: the
 * bundle loads (fully verified, songs/loadBundle.ts) while the stage's code downloads, then the
 * stage is built and compiled out of sight (StageView's `prepared`) and the preview opens.
 * Back / Escape go from the preview to the list and from the list to the player count.
 * The canvas reports data-song-screen, -song-ready, -catalog, -song-count, -player-slots, -preview-state
 * and -preview-time-ms for tests.
 *
 * <SongSelect visible playerCount={1} connection={view} onBack
 *   stageState={{ showing, prepared, ready, stage, failed }} onPreviewChange onDance />
 */

export interface SongSelectProps {
  visible?: boolean;
  playerCount?: PlayerCount;
  connection: PoseInputView;
  onBack?: () => void;
  stageState?: Partial<StageState>;
  /** The routine to preview on its stage, or null when the preview closes. */
  onPreviewChange?: (routine: SongRoutine | null) => void;
  onDance?: (bundle: LoadedSongBundle) => void;
}
type SongScreen = 'list' | 'preview';
type CatalogStatus = 'idle' | 'loading' | 'ready' | 'error';
type PreviewState = 'loading' | 'error' | SongPlayer['state'];
type SongWidget = Widget & { song?: CatalogSong };
interface SongSelectState {
  alpha: number; screen: SongScreen; next: SongScreen; swap: number; page: number;
  catalog: { status: CatalogStatus; songs: CatalogSong[]; error: string };
  catalogCtl: AbortController | null;
  loading: { id: string; controller: AbortController } | null;
  /** The last song opened, for the keyboard cursor coming back to the list. */
  chosen: string | null;
  loadError: string;
  bundle: LoadedSongBundle | null;
  player: SongPlayer | null;
  routine: SongRoutine | null;
  previewState: PreviewState;
  previewError: string;
  drawn: string;
  reported: string;
}

const CATALOG_URL = () => new URL(`${import.meta.env.BASE_URL}songs/manifest.json`, window.location.href).href;
const ACTIVE = ['connecting'];
const message = (error: unknown) => (error instanceof Error ? error.message : '');

const COUNT_NAMES = ['One player', 'Two players', 'Three players', 'Four players'];

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
  stageState = {}, onPreviewChange, onDance,
}: SongSelectProps) {
  const gl = useThree((state) => state.gl);
  const size = useThree((state) => state.size);
  const { BACK, DANCE, PAGE_DOWN, PAGE_UP, PREVIEW_NOTE, RETRY, ROWS, rowRect } = gameLayout(displayDesign(size.width, size.height).w);
  const props = useRef({ visible, playerCount, connection, onBack, stageState, onPreviewChange, onDance });
  props.current = { visible, playerCount, connection, onBack, stageState, onPreviewChange, onDance };
  const st = useRef<SongSelectState>({
    alpha: 0, screen: 'list', next: 'list', swap: 1, page: 0,
    catalog: { status: 'idle', songs: [], error: '' }, catalogCtl: null,
    loading: null, chosen: null, loadError: '',
    bundle: null, player: null, routine: null, previewState: 'loading', previewError: '',
    drawn: '', reported: '',
  }).current;

  const songs = () => st.catalog.songs.filter((song) => song.supportedPlayerCounts.includes(props.current.playerCount));
  const pages = () => Math.max(1, Math.ceil(songs().length / ROWS.perPage));
  const pageSongs = () => songs().slice(st.page * ROWS.perPage, (st.page + 1) * ROWS.perPage);
  const live = () => props.current.visible && st.alpha > 0.3 && st.screen === st.next;
  // The song opened last is the primary one while it's on the page, else the first.
  const primaryRow = () => Math.max(0, pageSongs().findIndex((song) => song.id === st.chosen));
  const songWidget = (song: CatalogSong, i: number): SongWidget => ({ id: `song-${song.id}`, song, rect: rowRect(i), primary: i === primaryRow() });
  // The keyboard cursor starts over on the next screen; back on the list (also by Escape), on
  // the song it opened.
  const go = (screen: SongScreen, key = ui.keyboard) => {
    if (screen === st.next) return;
    st.next = screen;
    if (!key) return;
    const i = screen === 'list' ? pageSongs().findIndex((song) => song.id === st.chosen) : -1;
    ui.focus(i >= 0 ? songWidget(pageSongs()[i], i) : null);
  };

  const fetchCatalog = () => {
    st.catalogCtl?.abort();
    const ctl = new AbortController();
    st.catalogCtl = ctl;
    st.catalog = { status: 'loading', songs: [], error: '' };
    fetch(CATALOG_URL(), { signal: ctl.signal, cache: 'no-store' })
      .then((response) => {
        if (!response.ok) throw Error('Song catalog could not load.');
        return response.json();
      })
      .then((data: unknown) => {
        const catalog = validateCatalog(data);
        st.catalog = { status: 'ready', songs: catalog.songs, error: '' };
        st.page = 0;
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
    const routine: SongRoutine = {
      bundle,
      playerCount: props.current.playerCount,
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
        if (!document.hidden && st.next === 'preview') player.play();
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

  const chooseSong = (entry: CatalogSong) => {
    st.loading?.controller.abort();
    const controller = new AbortController();
    st.loading = { id: entry.id, controller };
    st.chosen = entry.id;
    st.loadError = '';
    // The stage's code downloads alongside the bundle.
    preloadStage(resolveStage(entry.stage));
    loadSongBundle(entry, CATALOG_URL(), { signal: controller.signal })
      .then((bundle) => { if (!controller.signal.aborted && props.current.visible) openPreview(bundle); })
      .catch((error: unknown) => { if (!controller.signal.aborted) st.loadError = message(error); })
      .finally(() => {
        if (controller.signal.aborted) return;
        // An opened bundle keeps the row loading until its stage is in (showPreview).
        if (!st.bundle) st.loading = null;
        ui.invalidate();
      });
  };

  const back = (key?: boolean) => {
    if (st.screen === 'preview') { closePreview(); go('list', key); return; }
    // Escape counts as the keyboard: the cursor comes along to the players screen.
    if (key && !ui.keyboard) ui.focus({ id: 'back', circle: BACK });
    st.loading?.controller.abort();
    st.loading = null;
    props.current.onBack?.();
  };
  const dance = () => {
    const { bundle } = st;
    if (!bundle) return;
    closePreview();
    props.current.onDance?.(bundle);
  };

  const ui = useCanvasUI<SongWidget>({
    priority: 2,
    active: live,
    keyNav: true,
    widgets: () => {
      if (st.screen === 'preview') {
        const list: SongWidget[] = [
          { id: 'back', circle: BACK },
          { id: 'dance', rect: DANCE, primary: true },
        ];
        return list;
      }
      const list: SongWidget[] = [{ id: 'back', circle: BACK }];
      if (st.catalog.status === 'ready') {
        if (!st.loading) pageSongs().forEach((song, i) => list.push(songWidget(song, i)));
        if (st.page > 0) list.push({ id: 'page-up', circle: PAGE_UP });
        if (st.page < pages() - 1) list.push({ id: 'page-down', circle: PAGE_DOWN });
      }
      if (st.catalog.status === 'error') list.push({ id: 'retry', rect: RETRY, primary: true });
      return list;
    },
    onActivate: (wdg, s) => {
      if (wdg.song) chooseSong(wdg.song);
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
      // A chosen song waits on the list until its stage is prepared (or failed).
      if (st.bundle && st.loading && st.next === 'list') {
        const want = resolveStage(st.bundle.song.stage);
        if (p.stageState.stage === want && (p.stageState.prepared || p.stageState.failed)) showPreview();
      }
      const c = p.connection;
      const slots = Array.from({ length: p.playerCount }, (_, i) => slotStatus(c, i).label);
      const key = [
        st.screen, st.catalog.status, st.page, st.loading?.id, st.loadError, st.previewState, st.previewError,
        p.stageState.stage, p.stageState.ready, p.stageState.failed,
      ].join('~');
      if (key !== st.drawn) { st.drawn = key; s.invalidate(); }
      if (st.catalog.status === 'loading' || st.loading) s.invalidate();

      const report = {
        songScreen: st.screen,
        songReady: String(live() && st.swap > 0.95),
        catalog: st.catalog.status === 'ready' && !songs().length ? 'empty' : st.catalog.status,
        songCount: String(songs().length),
        playerSlots: slots.join('|'),
        previewState: st.screen === 'preview' ? (st.previewError ? 'error' : st.previewState) : '',
        previewTimeMs: st.routine ? String(Math.round(st.routine.timeMs())) : '',
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
          drawPill(g, RETRY, { label: 'Retry', icon: 'replay', hover: h.retry ?? 0, press: press('retry') });
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
            : 'No playable songs have been published yet. Each routine needs music and choreography for both players.', ROWS.x, ROWS.y + 96, ROWS.w, { size: 25, color: '#ffffff' });
          g.restore();
        } else {
          pageSongs().forEach((song, i) => {
            const rect = rowRect(i);
            const id = `song-${song.id}`;
            const loadingThis = st.loading?.id === song.id;
            g.font = `700 ${Math.round(rect.h * 0.34)}px ${FONT}`;
            const label = ellipsize(g, song.title, rect.w - rect.h - 44);
            const best = bestScore(song.id, p.playerCount, SCORER_VERSION);
            // Catalog difficulty is free-form display text.
            const difficulty = typeof song.difficulty === 'string' || typeof song.difficulty === 'number' ? String(song.difficulty) : 'Routine';
            const sub = loadingThis ? `Loading${dots}` : [song.artist, difficulty, song.stage ? resolveStage(song.stage) : null,
              best ? `Best ${best.score.toLocaleString('en-US')} ${best.grade}` : null].filter(Boolean).join(' · ');
            g.font = `600 ${Math.round(rect.h * 0.22)}px ${FONT}`;
            drawPill(g, rect, {
              label, sub: ellipsize(g, sub, rect.w - rect.h - 44), icon: 'note',
              hover: h[id] ?? 0, press: press(id), disabled: !!st.loading && !loadingThis,
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
          if (st.loadError) {
            g.font = `700 24px ${FONT}`;
            drawShadowText(g, ellipsize(g, st.loadError, ROWS.w + 60), ROWS.x, ROWS.y + ROWS.perPage * (ROWS.h + ROWS.gap) + 14, { size: 24, color: '#ffb38a' });
          }
        }
      } else if (st.bundle) {
        const { song } = st.bundle;
        drawHeader(g, BACK, 'PREVIEW', h.back ?? 0);
        g.font = `800 64px ${FONT}`;
        drawShadowText(g, ellipsize(g, song.title, s.w - BACK.x - 90), BACK.x - 38, BACK.y + 84, { size: 64, weight: 800 });
        g.font = `700 30px ${FONT}`;
        drawShadowText(g, ellipsize(g, `${song.artist} · ${resolveStage(song.stage)}`, s.w - BACK.x - 90), BACK.x - 36, BACK.y + 140, { size: 30, color: '#d8f6ff' });

        const stageFailed = p.stageState.failed && p.stageState.stage === resolveStage(song.stage);
        const error = st.previewError || (stageFailed ? "This song's stage couldn't load." : p.stageState.dancersFailed ? 'Character preview could not load.' : '');
        if (error) paragraph(g, error, PREVIEW_NOTE.x, PREVIEW_NOTE.y - 42, DANCE.x - PREVIEW_NOTE.x - 40, { size: 26, color: '#ffb38a' });
        drawPill(g, DANCE, { label: 'Dance!', sub: COUNT_NAMES[p.playerCount - 1], icon: 'play', hover: h.dance ?? 0, press: press('dance') });
      }
      g.restore();
    },
  });

  // Opening Song Select loads the catalog; leaving it stops everything.
  useEffect(() => {
    if (visible) {
      st.screen = st.next = 'list';
      st.swap = 1;
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
    const onVisibility = () => { if (document.hidden) st.player?.pause(); else if (st.next === 'preview') st.player?.play(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [st]);

  useEffect(() => () => {
    st.player?.dispose();
    duckMenuMusic(false);
  }, [st]);

  return null;
}
