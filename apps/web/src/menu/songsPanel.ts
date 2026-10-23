import { FONT, ICONS, drawCaps, drawGlassPanel, drawMarquee, ellipsize, paragraph, pill, wrapText } from '../ui/draw.ts';
import type { Circle } from '../ui/draw.ts';
import type { CanvasUI, Widget } from '../ui/useCanvasUI.ts';
import { customSongsSupported, importSongZip, listSavedSongs, removeCustomSong, savedCustomSong } from '../songs/customSongs.ts';
import type { SavedSong } from '../songs/customSongs.ts';
import { SONGS_PER_PAGE } from './layout.ts';
import type { menuLayout } from './layout.ts';

/**
 * Settings → Songs: the songs imported into this browser (songs/customSongs.ts), a dense list
 * SONGS_PER_PAGE to a page, each with a remove button (a title too long for its row scrolls:
 * drawMarquee), and Import song at the bottom, which takes a Dance Studio export ZIP. Song Select lists the imported songs that check out; the
 * damaged ones are only here, to remove. Only where the browser can save songs
 * (customSongsSupported): elsewhere Settings has no Songs panel.
 *
 * MainMenu draws it beside Sound and Graphics and passes its widgets and presses on: open()
 * and close() as Settings shows and hides. report() is data-saved-songs and -damaged-songs (the
 * counts, once listed), -song-import (idle / importing / done / error) and -song-notice for tests.
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

export const CAN_IMPORT = customSongsSupported();
// Saved songs that take longer than this to list show as unavailable.
const LIST_TIMEOUT_MS = 5000;
const message = (error: unknown) => (error instanceof Error ? error.message : '');
const trashId = (saved: SavedSong) => `remove-${saved.entry.id}`;

export function createSongsPanel({ layout, ui, showing }: {
  layout: () => Layout;
  ui: () => CanvasUI<SongsWidget>;
  /** Settings is the screen showing (an import only asks before replacing a song then). */
  showing: () => boolean;
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
    notice: null as { text: string; error: boolean } | null,
    picker: null as HTMLInputElement | null,
    /** When this page of titles showed, for their marquees; when one next moves (0: it is). */
    shownAt: 0,
    nextMotion: Infinity,
    motionTimer: 0,
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

  // Lists the saved songs. With show (an ID), the list turns to that song's page; with focus (a
  // place on a page), a keyboard cursor goes to the song there now, the last one if the page has
  // fewer, or Import song once none are left.
  const refresh = ({ show, focus }: { show?: string; focus?: { page: number; at: number } } = {}) => {
    if (!CAN_IMPORT) return;
    const load = ++st.loads;
    st.listing = true;
    if (st.status !== 'ready') st.status = 'loading';
    Promise.race([
      listSavedSongs(),
      new Promise<never>((_, reject) => setTimeout(() => reject(Error("Saved songs aren't available in this browser (timed out).")), LIST_TIMEOUT_MS)),
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
          ui().focus(at >= 0 ? trash(shown[at], at) : importWidget());
        }
      })
      .catch((error: unknown) => {
        if (load !== st.loads) return;
        st.status = 'error';
        st.songs = [];
        st.page = 0;
        st.error = message(error) || "Saved songs aren't available in this browser.";
      })
      .finally(() => {
        if (load === st.loads) st.listing = false;
        ui().invalidate();
      });
  };

  // A Dance Studio export ZIP, checked and saved. Saving over a copy of the same or a later
  // revision asks first, or keeps it once Settings has closed.
  const importFile = (file: File) => {
    st.importing = true;
    st.notice = { text: `Importing ${file.name}…`, error: false };
    ui().invalidate();
    importSongZip(file, {
      confirmReplace: (saved, incoming) => showing() && window.confirm(saved.bundleRevision === incoming.bundleRevision
        ? `“${saved.title}” revision ${saved.bundleRevision} is already imported. Replace it?`
        : `A later revision of “${saved.title}” (${saved.bundleRevision}) is already imported. Replace it with revision ${incoming.bundleRevision}?`),
    })
      .then(({ status, entry }) => {
        const title = `“${entry.title}”`;
        // Song Select only lists it for the player counts it has.
        const most = Math.max(...entry.supportedPlayerCounts);
        const note = most < 4 ? ` It's for up to ${most} player${most === 1 ? '' : 's'}.` : '';
        st.notice = {
          text: (status === 'kept' ? `Kept the ${title} already imported.` : status === 'replaced' ? `Updated ${title} to revision ${entry.bundleRevision}.` : `Imported ${title}.`) + note,
          error: false,
        };
        refresh({ show: entry.id });
      })
      .catch((error: unknown) => { st.notice = { text: message(error) || "That song couldn't be imported.", error: true }; })
      .finally(() => {
        st.importing = false;
        ui().invalidate();
      });
  };
  // The file picker opens from the press itself (browsers only open one from the user's input).
  const pickSong = () => {
    if (st.importing) return;
    if (!st.picker) {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.zip,application/zip';
      input.hidden = true;
      input.addEventListener('change', () => {
        const file = input.files?.[0];
        input.value = '';
        if (file) importFile(file);
      });
      document.body.append(input);
      st.picker = input;
    }
    st.picker.click();
  };

  // Deletes a song from this browser (its best scores stay), unless another tab has put another
  // copy in its place since it was listed. A keyboard cursor moves on to the song after it.
  const remove = (saved: SavedSong) => {
    const { entry } = saved;
    if (!window.confirm(`Remove “${entry.title}” from this browser?`)) return;
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

  // A glass-edged dark circle like the settings switches, with a white icon: remove, page arrows, import.
  const drawButton = (g: CanvasRenderingContext2D, c: Circle, icon: 'trash' | 'up' | 'down' | 'add', hover: number, press: number, enabled = true) => {
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
  };

  return {
    open() {
      st.page = 0;
      refresh();
    },
    close() {
      // A listing on its way is dropped; the next visit lists them again.
      st.loads++;
      st.listing = false;
      if (st.status === 'loading') st.status = 'idle';
      stopMarquees();
      // An import still going says how it went next time.
      if (!st.importing) st.notice = null;
    },
    widgets() {
      if (!CAN_IMPORT) return [];
      const { SONGS_UP, SONGS_DOWN } = layout();
      const list: SongsWidget[] = [];
      if (st.status === 'ready') pageSongs().forEach((saved, i) => list.push(trash(saved, i)));
      if (st.page > 0) list.push({ id: 'songs-up', circle: SONGS_UP });
      if (st.page < pages() - 1) list.push({ id: 'songs-down', circle: SONGS_DOWN });
      if (st.status !== 'error') list.push(importWidget());
      return list;
    },
    activate(wdg) {
      if (wdg.saved) remove(wdg.saved);
      else if (wdg.id === 'songs-up') turn(-1);
      else if (wdg.id === 'songs-down') turn(1);
      else if (wdg.id === 'song-import') pickSong();
      else return false;
      return true;
    },
    draw(g, hover, press, time) {
      if (!CAN_IMPORT) return;
      const { SONGS, SONG_ROW, SONGS_UP, SONGS_DOWN, SONGS_NOTE_Y, SONG_IMPORT } = layout();
      const textX = SONGS.x + 40;
      const textW = SONGS.w - 80;
      drawGlassPanel(g, SONGS, 34);
      drawCaps(g, 'SONGS', textX, SONGS.y + 44, { size: 22 });
      const dots = '.'.repeat(1 + (Math.floor(time * 3) % 3));
      g.textBaseline = 'middle';
      g.textAlign = 'left';

      if (pages() > 1) {
        drawButton(g, SONGS_UP, 'up', hover['songs-up'] ?? 0, press('songs-up'), st.page > 0);
        drawButton(g, SONGS_DOWN, 'down', hover['songs-down'] ?? 0, press('songs-down'), st.page < pages() - 1);
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
        paragraph(g, 'No songs imported yet. Export a song from Dance Studio as a ZIP, then import it here to dance it in this browser.', textX, top.y + top.h / 2, textW, { size: 22 });
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
          drawButton(g, layout().SONG_TRASH(i), 'trash', hv, press(id));
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

      if (st.status !== 'error') {
        // Import song: a link, underlined while it's pointed at.
        const hv = hover['song-import'] ?? 0;
        const cy = SONG_IMPORT.y + SONG_IMPORT.h / 2;
        const icon = { x: SONG_IMPORT.x + 22, y: cy, r: 18 };
        g.save();
        if (st.importing) g.globalAlpha *= 0.6;
        drawButton(g, icon, 'add', st.importing ? 0 : hv, press('song-import'));
        const label = st.importing ? `Importing${dots}` : 'Import song';
        const x = icon.x + icon.r + 14;
        g.font = `700 24px ${FONT}`;
        g.fillStyle = '#b8fff0';
        g.fillText(label, x, cy + 1);
        const w = g.measureText(label).width;
        if (hv > 0.01 && !st.importing) {
          g.fillRect(x, cy + 15, w * hv, 2.5);
        }
        g.font = `600 19px ${FONT}`;
        g.fillStyle = '#d8f6ff';
        g.fillText(' · Dance Studio ZIP', x + w, cy + 2);
        g.restore();
      }
    },
    key: () => [st.status, st.songs.map((saved) => `${saved.entry.id}:${saved.entry.bundleRevision}:${saved.damaged}`).join(','), st.page, st.importing, st.notice?.text, st.error].join('~'),
    busy: () => st.importing || st.status === 'loading' || st.nextMotion === 0,
    report(): Record<string, string> {
      if (!CAN_IMPORT) return {};
      return {
        // Once listed this visit.
        savedSongs: st.status === 'ready' && !st.listing ? String(st.songs.length) : '',
        damagedSongs: st.status === 'ready' && !st.listing ? String(st.songs.filter((saved) => saved.damaged).length) : '',
        songImport: st.importing ? 'importing' : st.notice ? (st.notice.error ? 'error' : 'done') : 'idle',
        songNotice: st.notice?.text ?? '',
      };
    },
    dispose() {
      st.loads++;
      stopMarquees();
      st.picker?.remove();
    },
  };
}
