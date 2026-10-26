import { FONT, ICONS, drawCaps, drawDarkGlassPanel, drawMarquee, ellipsize, paragraph, pill, roundRect, wrapText } from '../ui/draw.ts';
import type { Circle, IconName, Point, Rect } from '../ui/draw.ts';
import type { CanvasUI, Widget } from '../ui/useCanvasUI.ts';
import { canPickSongs, customSongsSupported, importSongZip, listSavedSongs, removeCustomSong, savedCustomSong, savedIn } from '../songs/customSongs.ts';
import { pickAppSongs } from '../songs/appSongs.ts';
import { appFiles, appSongs } from '../host.ts';
import type { ImportResult, SavedSong } from '../songs/customSongs.ts';
import type { CatalogSong } from '../../../../packages/pose/song.ts';
import type { SongFile } from '../songs/appSongs.ts';
import { SONGS_PER_PAGE } from './layout.ts';
import type { menuLayout } from './layout.ts';

/**
 * Settings → Songs: the songs imported into this browser or app (songs/customSongs.ts), a dense list
 * SONGS_PER_PAGE to a page, each with a remove button (a title too long for its row scrolls:
 * drawMarquee), and at the bottom Import song, which takes Dance Studio export ZIPs, as many as
 * are picked or dragged onto the panel, one after another, and Transfer songs, which opens the
 * screen for sending songs to and from another device (menu/transferPanel.ts; onTransfer). Song
 * Select lists the imported songs that check out; the damaged ones are only here, to remove. Only
 * where the browser or app can save songs (customSongsSupported): elsewhere Settings has no Songs
 * panel. In the iPhone/iPad app the app's own picker picks the ZIPs (pickAppSongs), and a ZIP
 * saved to its folder in the Files app lists too. The Apple TV app has no file picker, so only
 * Transfer songs, and no confirm(): removing a song takes a second press.
 *
 * MainMenu draws it beside Sound and Graphics and passes its widgets and presses on: open()
 * and close() as Settings shows and hides. report() is data-saved-songs and -damaged-songs (the
 * counts, once listed), -song-import (idle / importing / done / error), -song-notice,
 * -song-drop (near / over while files are dragged over Settings) and -song-removing (the song a
 * second press removes, on Apple TV) for tests.
 */

type Layout = ReturnType<typeof menuLayout>;
export type SongsWidget = Widget & { saved?: SavedSong };
export interface SongsPanel {
  open(): void;
  close(): void;
  widgets(): SongsWidget[];
  /** true if the widget was the panel's. */
  activate(wdg: SongsWidget): boolean;
  draw(g: CanvasRenderingContext2D, hover: Record<string, number>, press: (id: string) => number, time: number): void;
  /** Redraws while this changes, and every frame while busy (the dots). */
  key(): string;
  busy(): boolean;
  report(): Record<string, string>;
  dispose(): void;
}

/** Settings has a Songs panel: this browser or app can keep songs. */
export const HAS_SONGS = customSongsSupported();
/** It can import a ZIP too (not on Apple TV). */
const CAN_PICK = canPickSongs();
const IN_APP = appSongs() !== null;
const ON_TV = appFiles() !== null;
// A remove press on Apple TV waits this long for the second.
const REMOVE_CONFIRM_MS = 4000;
// Saved songs that take longer than this to list show as unavailable.
const LIST_TIMEOUT_MS = 5000;
const message = (error: unknown) => (error instanceof Error ? error.message : '');
const trashId = (saved: SavedSong) => `remove-${saved.entry.id}`;
const songFile = (file: File): SongFile => ({ name: file.name, read: async () => file });
const songCount = (n: number) => `${n} song${n === 1 ? '' : 's'}`;

/** A glass-edged dark circle like the settings switches, with a white icon: remove, page arrows, import, send. */
export function drawCircleButton(g: CanvasRenderingContext2D, c: Circle, icon: IconName, hover: number, press: number, enabled = true) {
  g.save();
  if (!enabled) { g.globalAlpha *= 0.35; hover = 0; press = 0; }
  const y = c.y + press * 2;
  g.beginPath();
  g.arc(c.x, y, c.r, 0, Math.PI * 2);
  g.fillStyle = `rgba(0, 30, 70, ${0.45 + hover * 0.2})`;
  g.fill();
  g.lineWidth = 2.5;
  g.strokeStyle = `rgba(255,255,255,${0.45 + hover * 0.45})`;
  g.stroke();
  g.lineWidth = 3;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.strokeStyle = '#ffffff';
  ICONS[icon](g, c.x, y, c.r * (icon === 'up' || icon === 'down' ? 1.3 : 1.6));
  g.restore();
}

/**
 * A link at a panel's foot: a small circle button with its icon, then the label, underlined while
 * it's pointed at, then a dimmer note if there's room (busy: dimmed, not pointed at). Its label
 * shrinks to fit the rect.
 */
export function drawPanelLink(g: CanvasRenderingContext2D, rect: Rect, { icon, label, note = '', hover = 0, press = 0, busy = false }:
  { icon: IconName; label: string; note?: string; hover?: number; press?: number; busy?: boolean }) {
  const cy = rect.y + rect.h / 2;
  const c = { x: rect.x + 22, y: cy, r: 18 };
  g.save();
  if (busy) g.globalAlpha *= 0.6;
  drawCircleButton(g, c, icon, busy ? 0 : hover, press);
  const x = c.x + c.r + 14;
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  g.font = `700 24px ${FONT}`;
  const room = rect.x + rect.w - x;
  const size = Math.max(16, Math.min(24, Math.floor(24 * room / Math.max(1, g.measureText(label).width))));
  g.font = `700 ${size}px ${FONT}`;
  g.fillStyle = '#b8fff0';
  g.fillText(label, x, cy + 1);
  const w = g.measureText(label).width;
  if (hover > 0.01 && !busy) g.fillRect(x, cy + size * 0.62, w * hover, 2.5);
  if (note) {
    g.font = `600 19px ${FONT}`;
    g.fillStyle = '#d8f6ff';
    const after = room - w;
    if (after > 40) g.fillText(ellipsize(g, note, after), x + w, cy + 2);
  }
  g.restore();
}

/** How the files imported in one go went (those that failed: why). */
interface Batch { total: number; imported: number; replaced: number; kept: number; failed: { name: string; text: string }[]; }

// How one import went.
function imported({ status, entry }: ImportResult) {
  const title = `“${entry.title}”`;
  // Song Select only lists it for the player counts it has.
  const most = Math.max(...entry.supportedPlayerCounts);
  const note = most < 4 ? ` It's for up to ${most} player${most === 1 ? '' : 's'}.` : '';
  return (status === 'kept' ? `Kept the ${title} already imported.` : status === 'replaced' ? `Updated ${title} to revision ${entry.bundleRevision}.` : `Imported ${title}.`) + note;
}
// How several went: "Imported 3 songs and updated 1 song. 2 files couldn't be imported: a.zip, b.zip."
function summary({ imported: added, replaced, kept, failed }: Batch) {
  const done = [added && `imported ${songCount(added)}`, replaced && `updated ${songCount(replaced)}`, kept && `kept ${songCount(kept)} already imported`].filter((part) => !!part);
  const said = done.length ? `${done.slice(0, -1).join(', ')}${done.length > 1 ? ' and ' : ''}${done.at(-1)}.` : '';
  const ok = said.charAt(0).toUpperCase() + said.slice(1);
  if (!failed.length) return { text: ok, error: false };
  const bad = failed.length === 1 ? `${failed[0].name}: ${failed[0].text}` : `${failed.length} files couldn't be imported: ${failed.map((f) => f.name).join(', ')}.`;
  return { text: ok ? `${ok} ${bad}` : bad, error: true };
}

export function createSongsPanel({ layout, ui, showing, toDesign, onTransfer }: {
  layout: () => Layout;
  /** Transfer songs was pressed. */
  onTransfer: () => void;
  ui: () => CanvasUI<SongsWidget>;
  /** Settings is the screen showing (an import only asks before replacing a song then). */
  showing: () => boolean;
  /** A point on the page (clientX, clientY) in the layout's units, for drops. */
  toDesign: (x: number, y: number) => Point;
}): SongsPanel {
  const st = {
    status: 'idle' as 'idle' | 'loading' | 'ready' | 'error',
    songs: [] as SavedSong[],
    error: '',
    page: 0,
    /** Bumped by each listing, so only the latest lands. */
    loads: 0,
    /** A listing is on its way (the songs listed already stay up meanwhile). */
    listing: false,
    importing: false,
    /** Files still to import, after the one importing. */
    queue: [] as SongFile[],
    /** How the files imported since the importing started went (what the notice sums up). */
    batch: { total: 0, imported: 0, replaced: 0, kept: 0, failed: [] } as Batch,
    /** Files are dragged over Settings: 'over' the panel, which takes them, or 'near' it. */
    dragging: null as 'near' | 'over' | null,
    /** The drop highlight, eased: shown at all, and over the panel. */
    near: 0,
    over: 0,
    /** The app's file picker is open. */
    picking: false,
    notice: null as { text: string; error: boolean } | null,
    picker: null as HTMLInputElement | null,
    /** When this page of titles showed, for their marquees; when one next moves (0: it is). */
    shownAt: 0,
    nextMotion: Infinity,
    motionTimer: 0,
    /** Apple TV: the song a second press removes, and when that stops. */
    removing: null as { id: string; until: number } | null,
    removingTimer: 0,
  };
  // The marquees start over whenever the titles showing change.
  const restartMarquees = () => { st.shownAt = performance.now(); };
  const stopMarquees = () => {
    clearTimeout(st.motionTimer);
    st.nextMotion = Infinity;
  };
  const pages = () => Math.max(1, Math.ceil(st.songs.length / SONGS_PER_PAGE));
  const pageSongs = () => st.songs.slice(st.page * SONGS_PER_PAGE, (st.page + 1) * SONGS_PER_PAGE);
  const trash = (saved: SavedSong, i: number): SongsWidget => ({ id: trashId(saved), saved, circle: layout().SONG_TRASH(i) });
  const importWidget = (): SongsWidget => ({ id: 'song-import', rect: layout().SONG_IMPORT });
  const transferWidget = (): SongsWidget => ({ id: 'song-transfer', rect: CAN_PICK ? layout().SONG_TRANSFER : layout().SONG_ACTIONS });
  // Where a keyboard cursor goes once there are no songs to go to.
  const footWidget = () => (CAN_PICK ? importWidget() : transferWidget());

  // Lists the saved songs. With show (an ID), the list turns to that song's page; with focus (a
  // place on a page), a keyboard cursor goes to the song there now, the last one if the page has
  // fewer, or Import song (Transfer songs on Apple TV) once none are left.
  const refresh = ({ show, focus }: { show?: string; focus?: { page: number; at: number } } = {}) => {
    if (!HAS_SONGS) return;
    const load = ++st.loads;
    st.listing = true;
    if (st.status !== 'ready') st.status = 'loading';
    Promise.race([
      listSavedSongs(),
      new Promise<never>((_, reject) => setTimeout(() => reject(Error(`Saved songs aren't available ${savedIn()} (timed out).`)), LIST_TIMEOUT_MS)),
    ])
      .then((songs) => {
        if (load !== st.loads) return;
        st.status = 'ready';
        st.songs = songs;
        const i = show ? songs.findIndex((saved) => saved.entry.id === show) : -1;
        st.page = i >= 0 ? Math.floor(i / SONGS_PER_PAGE) : Math.min(st.page, pages() - 1);
        restartMarquees();
        if (focus && ui().keyboard && showing()) {
          const shown = pageSongs();
          const at = st.page === focus.page ? Math.min(focus.at, shown.length - 1) : shown.length - 1;
          ui().focus(at >= 0 ? trash(shown[at], at) : footWidget());
        }
      })
      .catch((error: unknown) => {
        if (load !== st.loads) return;
        st.status = 'error';
        st.songs = [];
        st.page = 0;
        st.error = message(error) || `Saved songs aren't available ${savedIn()}.`;
      })
      .finally(() => {
        if (load === st.loads) st.listing = false;
        ui().invalidate();
      });
  };

  // Dance Studio export ZIPs, checked and saved one after another (more picked or dropped
  // meanwhile join the queue). Saving over a copy of the same or a later revision asks first, or
  // keeps it once Settings has closed. The notice says how one went, or sums up several.
  const confirmReplace = (saved: CatalogSong, incoming: CatalogSong) => showing() && window.confirm(saved.bundleRevision === incoming.bundleRevision
    ? `“${saved.title}” revision ${saved.bundleRevision} is already imported. Replace it?`
    : `A later revision of “${saved.title}” (${saved.bundleRevision}) is already imported. Replace it with revision ${incoming.bundleRevision}?`);
  const importFiles = (files: SongFile[]) => {
    if (!files.length) return;
    if (!st.importing) st.batch = { total: 0, imported: 0, replaced: 0, kept: 0, failed: [] };
    st.batch.total += files.length;
    st.queue.push(...files);
    if (!st.importing) void importQueue();
  };
  const importQueue = async () => {
    st.importing = true;
    const batch = st.batch;
    let last = st.notice;
    for (let file = st.queue.shift(); file; file = st.queue.shift()) {
      const at = batch.total - st.queue.length;
      st.notice = { text: batch.total > 1 ? `Importing ${file.name} (${at} of ${batch.total})…` : `Importing ${file.name}…`, error: false };
      ui().invalidate();
      try {
        const result = await importSongZip(await file.read(), { confirmReplace });
        batch[result.status]++;
        last = { text: imported(result), error: false };
        refresh({ show: result.entry.id });
      } catch (error) {
        const text = message(error) || "That song couldn't be imported.";
        if (batch.total > 1) console.warn(`${file.name} couldn't be imported: ${text}`);
        batch.failed.push({ name: file.name, text });
        last = { text, error: true };
      }
    }
    st.notice = batch.total > 1 ? summary(batch) : last;
    st.importing = false;
    ui().invalidate();
  };
  // The file picker opens from the press itself (browsers only open one from the user's input).
  // In the app, the app's picker opens on the phone's screen.
  const pickSong = () => {
    if (st.importing || st.picking) return;
    if (IN_APP) {
      st.picking = true;
      pickAppSongs()
        .then((files) => { st.picking = false; importFiles(files); })
        .catch((error: unknown) => {
          st.picking = false;
          st.notice = { text: message(error) || "That file couldn't be opened.", error: true };
          ui().invalidate();
        });
      return;
    }
    if (!st.picker) {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.zip,application/zip';
      input.multiple = true;
      input.hidden = true;
      input.addEventListener('change', () => {
        const files = [...input.files ?? []];
        input.value = '';
        importFiles(files.map(songFile));
      });
      document.body.append(input);
      st.picker = input;
    }
    st.picker.click();
  };

  // Files dragged onto the panel import as picked ones do. While files are dragged over
  // Settings, the panel shows it takes them, and the rest of the page turns them away (the browser
  // would open a file dropped there in place of the game). dragenter and dragleave come in pairs
  // as the drag crosses the page's elements, so the drag has left the page once they balance.
  let depth = 0;
  const takesDrops = (e: DragEvent) => showing() && st.status !== 'error' && !!e.dataTransfer?.types.includes('Files');
  const overPanel = (e: DragEvent) => {
    const p = toDesign(e.clientX, e.clientY), { SONGS } = layout();
    return p.x >= SONGS.x && p.x <= SONGS.x + SONGS.w && p.y >= SONGS.y && p.y <= SONGS.y + SONGS.h;
  };
  const drag = (to: typeof st.dragging) => {
    if (st.dragging !== to) { st.dragging = to; ui().invalidate(); }
  };
  const onDragEnter = (e: DragEvent) => {
    if (!takesDrops(e)) return;
    e.preventDefault();
    depth++;
    drag(overPanel(e) ? 'over' : 'near');
  };
  const onDragOver = (e: DragEvent) => {
    if (!takesDrops(e)) { drag(null); return; }
    e.preventDefault();
    const over = overPanel(e);
    if (e.dataTransfer) e.dataTransfer.dropEffect = over ? 'copy' : 'none';
    drag(over ? 'over' : 'near');
  };
  const onDragLeave = () => {
    depth = Math.max(0, depth - 1);
    if (!depth) drag(null);
  };
  const onDrop = (e: DragEvent) => {
    depth = 0;
    drag(null);
    if (!takesDrops(e)) return;
    e.preventDefault();
    if (overPanel(e)) importFiles([...e.dataTransfer?.files ?? []].map(songFile));
  };
  // Only while Settings is up.
  const dragEvents = Object.entries({ dragenter: onDragEnter, dragover: onDragOver, dragleave: onDragLeave, drop: onDrop }) as [string, EventListener][];
  const takeDrags = (on: boolean) => {
    for (const [type, fn] of dragEvents) {
      if (on) window.addEventListener(type, fn);
      else window.removeEventListener(type, fn);
    }
    depth = 0;
    st.dragging = null;
  };

  // Asks before removing: confirm() in a browser or the iPhone/iPad app, a second press of the same
  // button within REMOVE_CONFIRM_MS on Apple TV (it has no dialogs).
  const confirmRemove = (saved: SavedSong) => {
    const { entry } = saved;
    if (!ON_TV) {
      return window.confirm(IN_APP ? `Remove “${entry.title}”? Its ZIP is deleted from the aerodance folder in Files.` : `Remove “${entry.title}” from this browser?`);
    }
    const now = performance.now();
    if (st.removing?.id === entry.id && now < st.removing.until) { st.removing = null; return true; }
    st.removing = { id: entry.id, until: now + REMOVE_CONFIRM_MS };
    st.notice = { text: `Press again to remove “${entry.title}” from this Apple TV.`, error: false };
    clearTimeout(st.removingTimer);
    st.removingTimer = window.setTimeout(() => {
      if (st.removing?.id !== entry.id) return;
      st.removing = null;
      st.notice = null;
      ui().invalidate();
    }, REMOVE_CONFIRM_MS);
    return false;
  };
  // Deletes a song from this browser or app (its best scores stay), unless another tab has put
  // another copy in its place since it was listed. A keyboard cursor moves on to the song after it.
  const remove = (saved: SavedSong) => {
    const { entry } = saved;
    if (!confirmRemove(saved)) return;
    clearTimeout(st.removingTimer);
    const focus = ui().keyFocus === trashId(saved) ? { page: st.page, at: pageSongs().indexOf(saved) } : undefined;
    removeCustomSong(entry)
      // Not removed: another tab already did, or put another copy in its place (which stays).
      .then(async (removed) => removed || !await savedCustomSong(entry.id))
      .then((gone) => {
        st.notice = gone ? { text: `Removed “${entry.title}”.`, error: false }
          : { text: `“${entry.title}” has changed since the list loaded, so it wasn't removed.`, error: false };
        refresh({ focus });
      })
      .catch((error: unknown) => { st.notice = { text: message(error) || "That song couldn't be removed.", error: true }; })
      .finally(() => ui().invalidate());
  };

  const turn = (dir: -1 | 1) => {
    st.page = Math.min(pages() - 1, Math.max(0, st.page + dir));
    restartMarquees();
    // The keyboard cursor stays on the arrow, or once it's gone (the first or last page), goes
    // to the song beside it: the last one going up, the first going down.
    const s = ui();
    const arrow = dir < 0 ? st.page > 0 : st.page < pages() - 1;
    const row = dir < 0 ? pageSongs().length - 1 : 0;
    if (s.keyboard && !arrow && row >= 0) s.focus(trash(pageSongs()[row], row));
  };

  return {
    open() {
      st.page = 0;
      refresh();
      if (CAN_PICK) takeDrags(true);
    },
    close() {
      // A listing on its way is dropped; the next visit lists them again.
      st.loads++;
      st.listing = false;
      if (st.status === 'loading') st.status = 'idle';
      stopMarquees();
      takeDrags(false);
      st.removing = null;
      clearTimeout(st.removingTimer);
      // An import still going says how it went next time.
      if (!st.importing) st.notice = null;
    },
    widgets() {
      if (!HAS_SONGS) return [];
      const { SONGS_UP, SONGS_DOWN } = layout();
      const list: SongsWidget[] = [];
      if (st.status === 'ready') pageSongs().forEach((saved, i) => list.push(trash(saved, i)));
      if (st.page > 0) list.push({ id: 'songs-up', circle: SONGS_UP });
      if (st.page < pages() - 1) list.push({ id: 'songs-down', circle: SONGS_DOWN });
      if (st.status !== 'error' && CAN_PICK) list.push(importWidget());
      list.push(transferWidget());
      return list;
    },
    activate(wdg) {
      if (wdg.saved) remove(wdg.saved);
      else if (wdg.id === 'songs-up') turn(-1);
      else if (wdg.id === 'songs-down') turn(1);
      else if (wdg.id === 'song-import') pickSong();
      else if (wdg.id === 'song-transfer') onTransfer();
      else return false;
      return true;
    },
    draw(g, hover, press, time) {
      if (!HAS_SONGS) return;
      const { SONGS, SONG_ROW, SONGS_UP, SONGS_DOWN, SONGS_NOTE_Y, SONG_IMPORT } = layout();
      const textX = SONGS.x + 40;
      const textW = SONGS.w - 80;
      drawDarkGlassPanel(g, SONGS, 34);
      drawCaps(g, 'SONGS', textX, SONGS.y + 44, { size: 22 });
      const dots = '.'.repeat(1 + (Math.floor(time * 3) % 3));
      g.textBaseline = 'middle';
      g.textAlign = 'left';

      if (pages() > 1) {
        drawCircleButton(g, SONGS_UP, 'up', hover['songs-up'] ?? 0, press('songs-up'), st.page > 0);
        drawCircleButton(g, SONGS_DOWN, 'down', hover['songs-down'] ?? 0, press('songs-down'), st.page < pages() - 1);
        g.font = `700 20px ${FONT}`;
        g.textAlign = 'right';
        g.fillStyle = '#d8f6ff';
        g.fillText(`${st.page + 1}/${pages()}`, SONGS_UP.x - SONGS_UP.r - 14, SONGS_UP.y + 1);
        g.textAlign = 'left';
      }

      // Only titles drawn now can move.
      stopMarquees();
      const top = SONG_ROW(0);
      if (st.status === 'loading' || st.status === 'idle') {
        g.font = `600 24px ${FONT}`;
        g.fillStyle = '#ffffff';
        g.fillText(`Loading${dots}`, textX, top.y + top.h / 2);
      } else if (st.status === 'error') {
        paragraph(g, st.error, textX, top.y + top.h / 2, textW, { size: 22, color: '#ffb38a' });
      } else if (!st.songs.length) {
        paragraph(g, ON_TV ? 'No songs on this Apple TV yet. Choose Transfer songs to send some from a phone, tablet or computer that has them.'
          : IN_APP ? 'No songs imported yet. Export a song from Dance Studio as a ZIP, then import it here or save it to the aerodance folder in Files.'
            : 'No songs imported yet. Export a song from Dance Studio as a ZIP, then import it here to dance it in this browser.', textX, top.y + top.h / 2, textW, { size: 22 });
      } else {
        const elapsed = performance.now() - st.shownAt;
        let next = Infinity;
        pageSongs().forEach((saved, i) => {
          const row = SONG_ROW(i);
          const cy = row.y + row.h / 2;
          const id = trashId(saved);
          const hv = hover[id] ?? 0;
          if (hv > 0.01) {
            pill(g, row.x, row.y, row.w, row.h);
            g.fillStyle = `rgba(255,255,255,${hv * 0.1})`;
            g.fill();
          }
          // Title, then the artist dimmer if there's room, fitting before the button. A damaged
          // song always says so.
          const room = row.w - 64;
          g.font = `600 19px ${FONT}`;
          const damaged = saved.damaged ? g.measureText(' · Damaged').width : 0;
          g.font = `600 24px ${FONT}`;
          const titleW = Math.min(room - damaged, g.measureText(saved.entry.title).width);
          next = Math.min(next, drawMarquee(g, saved.entry.title, textX, cy + 1, titleW, '#ffffff', elapsed));
          const x = textX + titleW;
          const after = room - (x - textX) - 4;
          g.font = `600 19px ${FONT}`;
          if (saved.damaged) {
            g.fillStyle = '#ffb38a';
            g.fillText(' · Damaged', x, cy + 2);
          } else if (after > 60 && saved.entry.artist) {
            g.fillStyle = '#d8f6ff';
            g.fillText(ellipsize(g, ` · ${saved.entry.artist}`, after), x, cy + 2);
          }
          // Waiting for the second press (Apple TV): the button glows.
          const confirming = st.removing?.id === saved.entry.id;
          if (confirming) {
            const c = layout().SONG_TRASH(i);
            g.beginPath();
            g.arc(c.x, c.y, c.r + 5, 0, Math.PI * 2);
            g.fillStyle = 'rgba(255, 140, 90, 0.55)';
            g.fill();
          }
          drawCircleButton(g, layout().SONG_TRASH(i), 'trash', confirming ? 1 : hv, press(id));
        });
        // While a title scrolls MainMenu draws every frame (busy); while they hold, once more
        // when the next one moves.
        st.nextMotion = next;
        if (next > 0 && next < Infinity) st.motionTimer = window.setTimeout(() => ui().invalidate(), next);
      }

      // What the last import or removal did, two lines at most.
      if (st.notice) {
        g.font = `700 20px ${FONT}`;
        const lines = wrapText(g, st.notice.text, textW);
        const shown = lines.length > 2 ? [lines[0], ellipsize(g, lines.slice(1).join(' '), textW)] : lines;
        g.fillStyle = st.notice.error ? '#ffb38a' : '#d8f6ff';
        shown.forEach((line, i) => g.fillText(line, textX, SONGS_NOTE_Y + i * 26));
      }

      // Import song (where there's a file picker) and Transfer songs: links, underlined while pointed at.
      if (st.status !== 'error' && CAN_PICK) {
        drawPanelLink(g, SONG_IMPORT, { icon: 'add', label: st.importing ? `Importing${dots}` : 'Import song', busy: st.importing,
          hover: hover['song-import'] ?? 0, press: press('song-import') });
      }
      const transfer = transferWidget().rect!;
      drawPanelLink(g, transfer, { icon: 'transfer', label: 'Transfer songs',
        hover: hover['song-transfer'] ?? 0, press: press('song-transfer') });

      // Files dragged over Settings: a dashed edge says the panel takes them, and over it, the
      // panel dims under Drop to import.
      st.near = ui().ease(st.near, st.dragging ? 1 : 0, 14);
      st.over = ui().ease(st.over, st.dragging === 'over' ? 1 : 0, 14);
      if (st.near > 0.01) {
        g.save();
        roundRect(g, SONGS.x, SONGS.y, SONGS.w, SONGS.h, 34);
        g.fillStyle = `rgba(0, 30, 70, ${0.6 * st.over})`;
        g.fill();
        roundRect(g, SONGS.x + 12, SONGS.y + 12, SONGS.w - 24, SONGS.h - 24, 24);
        g.setLineDash([14, 10]);
        g.lineWidth = 3;
        g.strokeStyle = `rgba(184, 255, 240, ${st.near * (0.55 + 0.45 * st.over)})`;
        g.stroke();
        g.setLineDash([]);
        if (st.over > 0.01) {
          g.globalAlpha *= st.over;
          const cx = SONGS.x + SONGS.w / 2, cy = SONGS.y + SONGS.h / 2;
          drawCircleButton(g, { x: cx, y: cy - 30, r: 28 }, 'add', 1, 0);
          g.font = `700 28px ${FONT}`;
          g.textAlign = 'center';
          g.fillStyle = '#b8fff0';
          g.fillText('Drop to import', cx, cy + 32);
          g.font = `600 19px ${FONT}`;
          g.fillStyle = '#d8f6ff';
          g.fillText('Dance Studio ZIPs', cx, cy + 64);
        }
        g.restore();
      }
    },
    key: () => [st.status, st.songs.map((saved) => `${saved.entry.id}:${saved.entry.bundleRevision}:${saved.damaged}`).join(','), st.page, st.importing, st.notice?.text, st.error, st.dragging, st.removing?.id].join('~'),
    busy: () => st.importing || st.status === 'loading' || st.nextMotion === 0 ||
      st.near !== (st.dragging ? 1 : 0) || st.over !== (st.dragging === 'over' ? 1 : 0),
    report(): Record<string, string> {
      if (!HAS_SONGS) return {};
      return {
        // Once listed this visit.
        savedSongs: st.status === 'ready' && !st.listing ? String(st.songs.length) : '',
        damagedSongs: st.status === 'ready' && !st.listing ? String(st.songs.filter((saved) => saved.damaged).length) : '',
        songImport: st.importing ? 'importing' : st.notice ? (st.notice.error ? 'error' : 'done') : 'idle',
        songNotice: st.notice?.text ?? '',
        songDrop: st.dragging ?? '',
        songRemoving: st.removing?.id ?? '',
      };
    },
    dispose() {
      st.loads++;
      stopMarquees();
      clearTimeout(st.removingTimer);
      takeDrags(false);
      st.picker?.remove();
    },
  };
}
