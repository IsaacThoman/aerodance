import { FONT, ICONS, drawCaps, drawDarkGlassPanel, drawProgress, ellipsize, paragraph, pill, roundRect, text, wrapText } from '../ui/draw.ts';
import type { Rect } from '../ui/draw.ts';
import type { CanvasUI, Widget } from '../ui/useCanvasUI.ts';
import { drawQr } from '../connect/pairing.ts';
import { CODE_DIGITS, codeDigits, spacedCode } from '../../../../packages/pairing/signals.ts';
import { canPickSongs } from '../songs/customSongs.ts';
import { createSongTransfer, listSongSummaries } from '../songs/songTransfer.ts';
import type { SongSummary, SongTransfer, TransferChannel, TransferItem, TransferView } from '../songs/songTransfer.ts';
import { hostTransfer, joinTransfer, transferDeviceName } from '../songs/transferLink.ts';
import type { TransferLink, TransferLinkView } from '../songs/transferLink.ts';
import { drawCircleButton, drawPanelLink } from './songsPanel.ts';
import { SONGS_PER_PAGE } from './layout.ts';
import type { menuLayout } from './layout.ts';

/**
 * Settings → Songs → Transfer songs: sending this device's songs to another device, and taking
 * the songs it sends (songs/songTransfer.ts, over songs/transferLink.ts). Two panels:
 *
 *   Connect (left)  this device's code and a QR code for the other device to join (the QR code
 *                   opens the game there at /?transfer=<code>), or, except on Apple TV, a keypad
 *                   to enter another device's code instead; then who it's connected to, and
 *                   Disconnect. A host whose guest leaves waits on the same code again.
 *   Send (right)    this device's songs a page at a time, each with a send button, or a tick
 *                   where the other device has the song already (or a later revision), or how
 *                   far it's got; Send all; and what the last song sent or received did.
 *
 * MainMenu shows it as its own screen, from the Songs panel's Transfer songs, and passes its
 * widgets, presses and key presses on: open(code) as it shows (joining that code, or showing
 * this device's), close() as it goes, which ends the transfer. report() is data-transfer-status
 * (the link's: starting / waiting / connecting / connected / ended), -mode (code / enter),
 * -code, -device (the other one), -transport, -songs (this device's, once listed), -sent and
 * -received (how many songs went each way) and -notice for tests.
 */

type Layout = ReturnType<typeof menuLayout>;
export type TransferWidget = Widget & { song?: SongSummary; key?: string };
export interface TransferPanel {
  /** Shows this device's code, or with a code, joins it. */
  open(code?: string): void;
  close(): void;
  widgets(): TransferWidget[];
  /** true if the widget was the panel's. */
  activate(wdg: TransferWidget): boolean;
  /** A key press while the screen shows (digits for the code); true if the panel took it. */
  keyDown(e: KeyboardEvent): boolean;
  draw(g: CanvasRenderingContext2D, hover: Record<string, number>, press: (id: string) => number, time: number): void;
  /** Redraws while this changes, and every frame while busy (the dots). */
  key(): string;
  busy(): boolean;
  report(): Record<string, string>;
  dispose(): void;
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'delete', '0', 'join'];
const CAN_ENTER = canPickSongs();
const DEVICE = transferDeviceName();
const sendId = (song: SongSummary) => `send-${song.id}`;
const percent = (item: TransferItem) => (item.size ? Math.floor((item.done / item.size) * 100) : 0);
const live = (item: TransferItem | undefined) => !!item && (item.status === 'waiting' || item.status === 'sending' || item.status === 'checking');

/** Where one of this device's songs stands with the other device. */
type SongState = { kind: 'send' } | { kind: 'has'; later: boolean } | { kind: 'going'; item: TransferItem } | { kind: 'failed'; item: TransferItem };

export function createTransferPanel({ layout, ui, onReceived }: {
  layout: () => Layout;
  ui: () => CanvasUI<TransferWidget>;
  /** A song arrived and was saved (Song Select and the Songs panel list it next time). */
  onReceived?: () => void;
}): TransferPanel {
  const st = {
    /** Showing this device's code, or the keypad to enter another's. */
    mode: 'code' as 'code' | 'enter',
    typed: '',
    link: null as TransferLink | null,
    linkView: null as TransferLinkView | null,
    transfer: null as SongTransfer | null,
    view: null as TransferView | null,
    /** This device's songs that check out, and whether they've been listed. */
    songs: [] as SongSummary[],
    listed: false,
    lists: 0,
    page: 0,
    notice: null as { text: string; error: boolean } | null,
    /** Items already noticed as finished, so each says how it went once. */
    told: new Set<string>(),
    sent: 0,
    received: 0,
    open: false,
  };
  const invalidate = () => ui().invalidate();
  const pages = () => Math.max(1, Math.ceil(st.songs.length / SONGS_PER_PAGE));
  const pageSongs = () => st.songs.slice(st.page * SONGS_PER_PAGE, (st.page + 1) * SONGS_PER_PAGE);
  const connected = () => st.linkView?.status === 'connected' && !!st.transfer && !st.view?.closed;
  const peerName = () => st.view?.peer?.device || st.linkView?.device || 'the other device';

  const list = () => {
    const at = ++st.lists;
    listSongSummaries()
      .then((songs) => {
        if (at !== st.lists) return;
        st.songs = songs;
        st.listed = true;
        st.page = Math.min(st.page, pages() - 1);
      })
      .catch(() => { if (at === st.lists) { st.songs = []; st.listed = true; } })
      .finally(invalidate);
  };

  // What each song sent or received did, said once as it finishes.
  const onTransferChange = (view: TransferView) => {
    st.view = view;
    for (const [way, items] of [['out', view.outgoing], ['in', view.incoming]] as const) {
      for (const item of items) {
        const id = `${way}:${item.id}`;
        if ((item.status !== 'done' && item.status !== 'failed') || st.told.has(id)) continue;
        st.told.add(id);
        st.notice = { text: item.text, error: item.status === 'failed' };
        if (item.status === 'done') { if (way === 'out') st.sent++; else st.received++; }
      }
    }
    invalidate();
  };
  const linkOptions = () => ({
    device: DEVICE,
    onChange: (view: TransferLinkView) => { st.linkView = { ...view }; invalidate(); },
    onChannel: (channel: TransferChannel) => {
      st.transfer?.close();
      st.notice = null;
      st.transfer = createSongTransfer({ channel, device: DEVICE, onChange: onTransferChange,
        onSaved: () => { list(); onReceived?.(); } });
      st.view = st.transfer.view();
      invalidate();
    },
  });
  const endLink = () => {
    st.transfer?.close();
    st.transfer = null;
    st.view = null;
    st.link?.close();
    st.link = null;
    st.linkView = null;
  };
  const showCode = () => {
    endLink();
    st.mode = 'code';
    st.link = hostTransfer(linkOptions());
    st.linkView = { ...st.link.view() };
    invalidate();
  };
  const join = (code: string) => {
    endLink();
    st.mode = 'enter';
    st.typed = code;
    st.link = joinTransfer(code, linkOptions());
    st.linkView = { ...st.link.view() };
    invalidate();
  };
  const enterCode = () => {
    endLink();
    st.mode = 'enter';
    st.typed = '';
    invalidate();
  };
  const type = (key: string) => {
    if (st.mode !== 'enter' || st.link) return;
    if (key === 'delete') st.typed = st.typed.slice(0, -1);
    else if (key === 'join') { if (st.typed.length === CODE_DIGITS) join(st.typed); }
    else if (st.typed.length < CODE_DIGITS) {
      st.typed += key;
      // The sixth digit joins by itself, as on the phone page.
      if (st.typed.length === CODE_DIGITS) join(st.typed);
    }
    invalidate();
  };

  const stateOf = (song: SongSummary): SongState => {
    const item = st.view?.outgoing.filter((o) => o.songId === song.id).at(-1);
    if (live(item)) return { kind: 'going', item: item! };
    const theirs = st.view?.peer?.songs.find((s) => s.id === song.id);
    if (theirs && (theirs.revision > song.revision || (theirs.revision === song.revision && theirs.sha256 === song.sha256))) {
      return { kind: 'has', later: theirs.revision > song.revision };
    }
    if (item?.status === 'failed') return { kind: 'failed', item };
    return { kind: 'send' };
  };
  const sendable = () => st.songs.filter((song) => { const s = stateOf(song).kind; return s === 'send' || s === 'failed'; });
  const send = (songs: SongSummary[]) => {
    if (!connected() || !songs.length) return;
    st.transfer!.send(songs);
  };
  const turn = (dir: -1 | 1) => { st.page = Math.min(pages() - 1, Math.max(0, st.page + dir)); };

  // ----- Drawing

  const drawKey = (g: CanvasRenderingContext2D, rect: Rect, key: string, hover: number, press: number, enabled: boolean) => {
    g.save();
    if (!enabled) { g.globalAlpha *= 0.4; hover = 0; press = 0; }
    const y = rect.y + press * 2;
    roundRect(g, rect.x, y, rect.w, rect.h, 18);
    g.fillStyle = `rgba(0, 30, 70, ${0.45 + hover * 0.2})`;
    g.fill();
    g.lineWidth = 2.5;
    g.strokeStyle = `rgba(255,255,255,${0.45 + hover * 0.45})`;
    g.stroke();
    const cx = rect.x + rect.w / 2, cy = y + rect.h / 2;
    g.strokeStyle = g.fillStyle = '#ffffff';
    g.lineWidth = 4;
    g.lineCap = g.lineJoin = 'round';
    if (key === 'delete') ICONS.back(g, cx, cy, rect.h * 0.8);
    else if (key === 'join') text(g, 'Join', cx, cy + 1, { size: 26, weight: 800, align: 'center' });
    else text(g, key, cx, cy + 2, { size: 34, weight: 800, align: 'center' });
    g.restore();
  };
  // Six boxes, filled as the code is typed.
  const drawDigits = (g: CanvasRenderingContext2D, rect: Rect, code: string, active: boolean) => {
    const gap = 10, mid = 22;
    const w = Math.min(70, (rect.w - gap * (CODE_DIGITS - 2) - mid) / CODE_DIGITS);
    let x = rect.x + (rect.w - (w * CODE_DIGITS + gap * (CODE_DIGITS - 2) + mid)) / 2;
    for (let i = 0; i < CODE_DIGITS; i++) {
      roundRect(g, x, rect.y, w, rect.h, 14);
      g.fillStyle = active && i === code.length ? 'rgba(191, 244, 255, 0.35)' : 'rgba(0, 30, 70, 0.4)';
      g.fill();
      g.lineWidth = 2.5;
      g.strokeStyle = 'rgba(255, 255, 255, 0.7)';
      g.stroke();
      if (code[i]) text(g, code[i], x + w / 2, rect.y + rect.h / 2 + 2, { size: 44, weight: 800, align: 'center' });
      x += w + (i === 2 ? mid : gap);
    }
  };

  const drawConnect = (g: CanvasRenderingContext2D, hover: Record<string, number>, press: (id: string) => number, dots: string) => {
    const { TRANSFER_CONNECT: C, TRANSFER_QR: Q, TRANSFER_DIGITS, TRANSFER_KEY, TRANSFER_LINK } = layout();
    const x = C.x + 40, w = C.w - 80;
    drawDarkGlassPanel(g, C, 34);
    drawCaps(g, 'CONNECT', x, C.y + 44, { size: 22 });
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    const lv = st.linkView;
    const status = lv?.status ?? 'starting';

    if (connected()) {
      // Who's connected, by what, and how to stop.
      const cy = C.y + 150;
      g.save();
      g.strokeStyle = '#ffffff';
      g.lineWidth = 4;
      g.lineCap = g.lineJoin = 'round';
      ICONS.transfer(g, x + 34, cy, 80);
      g.restore();
      text(g, 'Connected to', x + 90, cy - 18, { size: 22, weight: 700, color: '#d8f6ff' });
      g.font = `800 34px ${FONT}`;
      text(g, ellipsize(g, peerName(), w - 90), x + 90, cy + 18, { size: 34, weight: 800 });
      paragraph(g, `Send songs from the list here, or send them from ${peerName()}: they're saved ${DEVICE === 'Apple TV' ? 'on this Apple TV' : 'here'} as they arrive.`,
        x, cy + 92, w, { size: 22 });
      drawPanelLink(g, TRANSFER_LINK, { icon: 'close', label: 'Disconnect', hover: hover['transfer-link'] ?? 0, press: press('transfer-link') });
      return;
    }

    if (status === 'ended') {
      paragraph(g, lv?.error || 'The transfer ended.', x, C.y + 110, w, { size: 24, color: '#ffb38a' });
      drawPanelLink(g, TRANSFER_LINK, { icon: 'replay', label: st.mode === 'enter' ? 'Enter the code again' : 'Get a new code',
        hover: hover['transfer-link'] ?? 0, press: press('transfer-link') });
      return;
    }

    if (st.mode === 'enter') {
      const joining = !!st.link;
      drawDigits(g, TRANSFER_DIGITS, st.typed, !joining);
      if (joining) {
        paragraph(g, status === 'connecting' && lv?.device ? `Connecting to ${lv.device}${dots}` : `Joining${dots}`, x, TRANSFER_KEY(0).y + 30, w, { size: 26, weight: 700 });
        paragraph(g, 'Keep Transfer songs open on the other device.', x, TRANSFER_KEY(0).y + 76, w, { size: 22 });
      } else {
        KEYS.forEach((key, i) => drawKey(g, TRANSFER_KEY(i), key, hover[`key-${key}`] ?? 0, press(`key-${key}`),
          key === 'join' ? st.typed.length === CODE_DIGITS : key === 'delete' ? st.typed.length > 0 : st.typed.length < CODE_DIGITS));
      }
      drawPanelLink(g, TRANSFER_LINK, { icon: 'phone', label: 'Show this device’s code', hover: hover['transfer-link'] ?? 0, press: press('transfer-link') });
      return;
    }

    // This device's code: the QR code, and beside it the code to type.
    const url = lv?.url ? new URL(lv.url) : null;
    if (lv?.url) drawQr(g, lv.url, Q);
    else {
      roundRect(g, Q.x, Q.y, Q.w, Q.h, 16);
      g.fillStyle = 'rgba(0, 30, 70, 0.4)';
      g.fill();
    }
    const tx = Q.x + Q.w + 32, tw = C.x + C.w - 40 - tx;
    text(g, 'Code', tx, Q.y + 22, { size: 22, weight: 700, color: '#d8f6ff' });
    g.save();
    g.font = `800 56px ${FONT}`;
    if ('letterSpacing' in g) g.letterSpacing = '4px';
    text(g, lv?.code ? spacedCode(lv.code) : `–––${dots.length ? ' ' : ''}–––`, tx, Q.y + 72, { size: 56, weight: 800 });
    g.restore();
    if (url) {
      g.font = `800 22px ${FONT}`;
      text(g, ellipsize(g, url.host, tw), tx, Q.y + 126, { size: 22, weight: 800, color: '#bff4ff' });
    }
    const waiting = status === 'connecting' ? `Connecting to ${lv?.device || 'the other device'}${dots}` : status === 'waiting' ? `Waiting for the other device${dots}` : `Getting a code${dots}`;
    paragraph(g, waiting, tx, Q.y + 176, tw, { size: 20, weight: 700, lineH: 26 });
    paragraph(g, 'On the other device, scan the QR code, or open Settings → Songs → Transfer songs there and enter this code.',
      x, Q.y + Q.h + 44, w, { size: 22 });
    if (CAN_ENTER) {
      drawPanelLink(g, TRANSFER_LINK, { icon: 'phone', label: 'Enter a code from another device', hover: hover['transfer-link'] ?? 0, press: press('transfer-link') });
    }
  };

  const drawSongs = (g: CanvasRenderingContext2D, hover: Record<string, number>, press: (id: string) => number, dots: string) => {
    const { SONGS, SONG_ROW, SONG_TRASH, SONGS_UP, SONGS_DOWN, SONGS_NOTE_Y, SONG_ACTIONS } = layout();
    const textX = SONGS.x + 40, textW = SONGS.w - 80;
    drawDarkGlassPanel(g, SONGS, 34);
    drawCaps(g, 'SEND SONGS', textX, SONGS.y + 44, { size: 22 });
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    if (pages() > 1) {
      drawCircleButton(g, SONGS_UP, 'up', hover['transfer-up'] ?? 0, press('transfer-up'), st.page > 0);
      drawCircleButton(g, SONGS_DOWN, 'down', hover['transfer-down'] ?? 0, press('transfer-down'), st.page < pages() - 1);
      g.font = `700 20px ${FONT}`;
      g.textAlign = 'right';
      g.fillStyle = '#d8f6ff';
      g.fillText(`${st.page + 1}/${pages()}`, SONGS_UP.x - SONGS_UP.r - 14, SONGS_UP.y + 1);
      g.textAlign = 'left';
    }
    const top = SONG_ROW(0);
    const on = connected();
    if (!st.listed) {
      g.font = `600 24px ${FONT}`;
      g.fillStyle = '#ffffff';
      g.fillText(`Loading${dots}`, textX, top.y + top.h / 2);
    } else if (!st.songs.length) {
      paragraph(g, on ? `No songs here to send. ${peerName()} can send you its songs.` : 'No songs on this device to send yet. Songs sent to it are saved here.',
        textX, top.y + top.h / 2, textW, { size: 22 });
    } else {
      pageSongs().forEach((song, i) => {
        const row = SONG_ROW(i), cy = row.y + row.h / 2, id = sendId(song);
        const state = stateOf(song);
        const hv = state.kind === 'send' || state.kind === 'failed' ? hover[id] ?? 0 : 0;
        if (hv > 0.01) {
          pill(g, row.x, row.y, row.w, row.h);
          g.fillStyle = `rgba(255,255,255,${hv * 0.1})`;
          g.fill();
        }
        // What's at the row's end: the send button, a tick, or how far it's got.
        const status = state.kind === 'going' ? (state.item.status === 'waiting' ? 'Waiting' : state.item.status === 'checking' ? 'Checking' : `${percent(state.item)}%`)
          : state.kind === 'has' ? (state.later ? 'Newer there' : `On ${peerName()}`) : '';
        g.font = `600 19px ${FONT}`;
        const statusW = status ? Math.min(170, g.measureText(status).width) : 0;
        const room = row.w - 64 - (statusW ? statusW + 12 : 0);
        g.font = `600 24px ${FONT}`;
        const title = ellipsize(g, song.title, room);
        const titleW = g.measureText(title).width;
        g.fillStyle = '#ffffff';
        g.fillText(title, textX, cy + 1);
        // The artist, dimmer, if there's room.
        const after = room - titleW - 4;
        g.font = `600 19px ${FONT}`;
        if (after > 60 && song.artist) {
          g.fillStyle = '#d8f6ff';
          g.fillText(ellipsize(g, ` · ${song.artist}`, after), textX + titleW, cy + 2);
        }
        const c = SONG_TRASH(i);
        if (status) {
          g.textAlign = 'right';
          g.fillStyle = state.kind === 'has' ? '#b8fff0' : '#d8f6ff';
          g.fillText(ellipsize(g, status, 170), c.x - c.r - 10, cy + 2);
          g.textAlign = 'left';
        }
        if (state.kind === 'going' && state.item.status === 'sending') {
          drawProgress(g, { x: textX, y: row.y + row.h - 6, w: c.x - c.r - 10 - textX, h: 5 }, percent(state.item) / 100);
        }
        if (state.kind === 'has') {
          g.save();
          g.strokeStyle = '#b8fff0';
          g.lineWidth = 3;
          g.lineCap = g.lineJoin = 'round';
          ICONS.check(g, c.x, c.y, c.r * 1.6);
          g.restore();
        } else if (state.kind !== 'going') {
          drawCircleButton(g, c, 'send', hv, press(id), on);
        }
      });
    }

    // What the last song sent or received did, or the one arriving now.
    const arriving = st.view?.incoming.at(-1);
    const notice = arriving && (arriving.status === 'sending' || arriving.status === 'checking')
      ? { text: arriving.status === 'checking' ? `Checking “${arriving.title}”${dots}` : `Receiving “${arriving.title}” (${percent(arriving)}%)`, error: false }
      : st.notice ?? (!on && st.listed && st.songs.length ? { text: 'Connect another device to send these to it.', error: false } : null);
    if (notice) {
      g.font = `700 20px ${FONT}`;
      const lines = wrapText(g, notice.text, textW);
      const shown = lines.length > 2 ? [lines[0], ellipsize(g, lines.slice(1).join(' '), textW)] : lines;
      g.fillStyle = notice.error ? '#ffb38a' : '#d8f6ff';
      shown.forEach((line, i) => g.fillText(line, textX, SONGS_NOTE_Y + i * 26));
    }
    if (on && sendable().length > 1) {
      drawPanelLink(g, SONG_ACTIONS, { icon: 'send', label: 'Send all', note: ` · ${sendable().length} songs ${peerName()} hasn't got`,
        hover: hover['transfer-all'] ?? 0, press: press('transfer-all') });
    }
  };

  return {
    open(code) {
      st.open = true;
      st.page = 0;
      st.notice = null;
      st.listed = false;
      list();
      if (code) join(code);
      else showCode();
    },
    close() {
      st.open = false;
      st.lists++;
      endLink();
      st.mode = 'code';
      st.typed = '';
      st.notice = null;
    },
    widgets() {
      if (!st.open) return [];
      const { SONG_TRASH, SONGS_UP, SONGS_DOWN, SONG_ACTIONS, TRANSFER_KEY, TRANSFER_LINK } = layout();
      const list: TransferWidget[] = [];
      const ended = st.linkView?.status === 'ended';
      if (connected() || ended || (st.mode === 'enter') || CAN_ENTER) list.push({ id: 'transfer-link', rect: TRANSFER_LINK });
      if (!connected() && !ended && st.mode === 'enter' && !st.link) KEYS.forEach((key, i) => list.push({ id: `key-${key}`, key, rect: TRANSFER_KEY(i), corner: 18 }));
      if (connected()) {
        pageSongs().forEach((song, i) => {
          const kind = stateOf(song).kind;
          if (kind === 'send' || kind === 'failed') list.push({ id: sendId(song), song, circle: SONG_TRASH(i) });
        });
        if (sendable().length > 1) list.push({ id: 'transfer-all', rect: SONG_ACTIONS });
      }
      if (st.page > 0) list.push({ id: 'transfer-up', circle: SONGS_UP });
      if (st.page < pages() - 1) list.push({ id: 'transfer-down', circle: SONGS_DOWN });
      return list;
    },
    activate(wdg) {
      if (wdg.song) send([wdg.song]);
      else if (wdg.key) type(wdg.key);
      else if (wdg.id === 'transfer-all') send(sendable());
      else if (wdg.id === 'transfer-up') turn(-1);
      else if (wdg.id === 'transfer-down') turn(1);
      else if (wdg.id === 'transfer-link') {
        const ended = st.linkView?.status === 'ended';
        if (connected()) { if (st.mode === 'enter') enterCode(); else showCode(); }
        else if (ended) { if (st.mode === 'enter') enterCode(); else showCode(); }
        else if (st.mode === 'enter') showCode();
        else if (CAN_ENTER) enterCode();
      } else return false;
      invalidate();
      return true;
    },
    keyDown(e) {
      if (!st.open || st.mode !== 'enter' || st.link || e.metaKey || e.ctrlKey || e.altKey) return false;
      const digit = codeDigits(e.key);
      if (digit.length === 1) { type(digit); return true; }
      if (e.key === 'Backspace') { type('delete'); return true; }
      return false;
    },
    draw(g, hover, press, time) {
      if (!st.open) return;
      const dots = '.'.repeat(1 + (Math.floor(time * 3) % 3));
      drawConnect(g, hover, press, dots);
      drawSongs(g, hover, press, dots);
    },
    key: () => {
      const v = st.view;
      return [st.mode, st.typed, JSON.stringify(st.linkView), st.songs.map((s) => `${s.id}:${s.revision}`).join(','), st.listed, st.page, st.notice?.text,
        v?.peer?.songs.map((s) => `${s.id}:${s.revision}:${s.sha256}`).join(','), v?.closed,
        ...(v ? [...v.outgoing, ...v.incoming].map((i) => `${i.id}:${i.status}:${i.done}`) : [])].join('~');
    },
    busy: () => st.open && (!st.listed || (!connected() && st.linkView?.status !== 'ended' && (st.mode === 'code' || !!st.link)) ||
      !!st.view?.incoming.some((i) => i.status === 'checking') || !!st.view?.outgoing.some((o) => o.status === 'checking')),
    report(): Record<string, string> {
      const report = {
        transferStatus: st.mode === 'enter' && !st.link ? 'entering' : st.linkView?.status ?? '',
        transferMode: st.mode,
        transferCode: st.linkView?.code ?? '',
        transferDevice: connected() ? peerName() : '',
        transferTransport: st.linkView?.transport ?? '',
        transferSongs: st.listed ? String(st.songs.length) : '',
        transferSent: String(st.sent),
        transferReceived: String(st.received),
        transferNotice: st.notice?.text ?? '',
      };
      // Every key, blank while the screen isn't showing (MainMenu copies them onto the canvas).
      return st.open ? report : Object.fromEntries(Object.keys(report).map((key) => [key, '']));
    },
    dispose() {
      st.lists++;
      endLink();
    },
  };
}
