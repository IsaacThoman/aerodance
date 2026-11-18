import { FONT, ICONS, drawCaps, drawDarkGlassPanel, drawProgress, ellipsize, paragraph, pill, roundRect, text, wrapText } from '../ui/draw.ts';
import type { Rect } from '../ui/draw.ts';
import type { CanvasUI, Widget } from '../ui/useCanvasUI.ts';
import { drawQr } from '../connect/pairing.ts';
import { CODE_DIGITS, codeDigits, spacedCode } from '../../../../packages/pairing/signals.ts';
import { client } from '../host.ts';
import { createSongTransfer, listSongSummaries } from '../songs/songTransfer.ts';
import type { SongSummary, SongTransfer, TransferChannel, TransferItem, TransferView } from '../songs/songTransfer.ts';
import { hostTransfer, joinTransfer, transferDeviceName } from '../songs/transferLink.ts';
import type { TransferLink, TransferLinkView } from '../songs/transferLink.ts';
import { drawCircleButton, drawPanelLink } from './songsPanel.ts';
import { SONGS_PER_PAGE } from './layout.ts';
import type { menuLayout } from './layout.ts';

/**
 * Settings → Songs → Transfer songs: sending songs between this device and another, either way
 * from either one (songs/songTransfer.ts, over songs/transferLink.ts). Two panels, which show the
 * same thing on both devices once they're connected:
 *
 *   Connect (left)  this device's code and a QR code for the other device to join (the QR code
 *                   opens the game there at /?transfer=<code>), or a keypad to enter another
 *                   device's code instead (the default except on Apple TV); then who it's
 *                   connected to, what's going each way (the song, a progress bar, how many of
 *                   how many and what's next), and Disconnect. A host whose guest leaves waits on
 *                   the same code again.
 *   Songs (right)   the songs on either device a page at a time, in the same order on both, each
 *                   with where it is: a send button for one the other device lacks, a get button
 *                   for one this device lacks (it asks the other to send it), a tick for one on
 *                   both, or how far it's got while it goes (a queued one waits); Send all and
 *                   Get all; and what the last song or batch did. Until a device connects, only
 *                   this device's songs.
 *
 * MainMenu shows it as its own screen, from the Songs panel's Transfer songs, and passes its
 * widgets, presses and key presses on: open(code) as it shows (joining that code, or starting
 * with the platform's default), close() as it goes, which ends the transfer. report() is
 * data-transfer-status (the link's: starting / waiting / connecting / connected / ended), -mode (code / enter),
 * -code, -device (the other one), -transport, -songs (this device's, once listed), -rows (each
 * listed song's id and where it stands: send / get / both / there / out / in), -sending and
 * -receiving (how many are on their way or waiting each way), -sent and -received (how many songs
 * went each way) and -notice for tests.
 */

type Layout = ReturnType<typeof menuLayout>;
/** A song on either device: this one's copy, the other's, or both. */
export interface TransferRow { id: string; title: string; artist: string; mine?: SongSummary; theirs?: SongSummary }
export type TransferWidget = Widget & { entry?: TransferRow; act?: 'send' | 'get'; at?: number; key?: string };
export interface TransferPanel {
  /** Starts with the platform's default screen, or joins a supplied code directly. */
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
const DEVICE = transferDeviceName();
const percent = (item: TransferItem) => (item.size ? Math.floor((item.done / item.size) * 100) : 0);
const live = (item: TransferItem | undefined) => !!item && (item.status === 'waiting' || item.status === 'sending' || item.status === 'checking');
const songCount = (n: number) => `${n} song${n === 1 ? '' : 's'}`;
// The same order on both devices, whatever their languages.
const byTitle = (a: TransferRow, b: TransferRow) => {
  const x = a.title.toLowerCase(), y = b.title.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};
// A list left alone this long turns to the song on its way.
const FOLLOW_IDLE_MS = 4000;
// The room a row's status takes at most.
const STATUS_W = 190;

/**
 * Where a song stands between the two devices: on its way (out, or in; no item yet for one asked
 * for and not queued there yet), on both, one to send or to get (note: why; failed: the last try
 * didn't make it), or only there with no way to ask for it.
 */
type RowState = { kind: 'going'; way: Way; item?: TransferItem } | { kind: 'both' } | { kind: 'send' | 'get' | 'there'; note: string; failed: boolean };
type Way = 'out' | 'in';
/** What's going one way: the song on its way (or first in line), where it is among the batch, and what's next. */
interface Activity { way: Way; item?: TransferItem; title: string; n: number; total: number; next: string[] }
const newRun = () => ({ out: { ok: 0, bad: 0 }, in: { ok: 0, bad: 0 }, last: null as { text: string; error: boolean } | null, error: '' });

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
    /** How the songs went since something last started going: what the notice sums up. */
    run: newRun(),
    busy: false,
    /** The song on its way that the list last turned to, and when the list was last pressed. */
    followed: '',
    touched: -Infinity,
    sent: 0,
    received: 0,
    open: false,
  };
  // Worked out once per change, not per frame (the Apple TV has no JIT, and a library can be
  // hundreds of songs): the songs listed, where each stands, and which can be sent or got.
  let listed: { rows: TransferRow[]; states: Map<string, RowState>; sendable: TransferRow[]; gettable: TransferRow[]; report: string } | null = null;
  let version = 0;
  const invalidate = () => { listed = null; version++; ui().invalidate(); };
  const connected = () => st.linkView?.status === 'connected' && !!st.transfer && !st.view?.closed;
  const peerName = () => st.view?.peer?.device || st.linkView?.device || 'the other device';
  const derive = () => {
    if (listed) return listed;
    const on = connected(), v = on ? st.view : null, peer = peerName();
    // This device's songs, and once connected the other's too: one row for a song on both.
    const byId = new Map<string, TransferRow>();
    for (const song of st.songs) byId.set(song.id, { id: song.id, title: song.title, artist: song.artist, mine: song });
    for (const song of v?.peer?.songs ?? []) {
      const row = byId.get(song.id);
      if (!row) byId.set(song.id, { id: song.id, title: song.title, artist: song.artist, theirs: song });
      else {
        row.theirs = song;
        // Both devices call it what its later revision does.
        if (song.revision > row.mine!.revision) { row.title = song.title; row.artist = song.artist; }
      }
    }
    // One on its way from a list too long to have come whole.
    for (const item of v?.incoming ?? []) if (live(item) && !byId.has(item.songId)) byId.set(item.songId, { id: item.songId, title: item.title, artist: '' });
    const rows = [...byId.values()].sort(byTitle);

    // Each song's latest item each way.
    const out = new Map(v?.outgoing.map((o) => [o.songId, o])), inn = new Map(v?.incoming.map((i) => [i.songId, i]));
    const asked = new Set(v?.asked);
    const stateOf = ({ id, mine, theirs }: TransferRow): RowState => {
      if (!v) return { kind: 'send', note: '', failed: false };
      const o = out.get(id), i = inn.get(id);
      if (o && live(o)) return { kind: 'going', way: 'out', item: o };
      if (i && live(i)) return { kind: 'going', way: 'in', item: i };
      if (asked.has(id)) return { kind: 'going', way: 'in' };
      const get = (note: string): RowState => ({ kind: v.peer?.requests ? 'get' : 'there', note, failed: i?.status === 'failed' });
      const send = (note: string): RowState => ({ kind: 'send', note, failed: o?.status === 'failed' });
      if (!mine) return theirs ? get(`Only on ${peer}`) : { kind: 'there', note: '', failed: false };
      if (!theirs) return send('Only here');
      if (theirs.revision > mine.revision) return get(`Newer on ${peer}`);
      if (theirs.revision < mine.revision) return send('Newer here');
      return theirs.sha256 === mine.sha256 ? { kind: 'both' } : send('Another copy');
    };
    const states = new Map(rows.map((row) => [row.id, stateOf(row)]));
    const kind = (row: TransferRow) => states.get(row.id)!.kind;
    listed = { rows, states, sendable: v ? rows.filter((row) => kind(row) === 'send') : [], gettable: rows.filter((row) => kind(row) === 'get'),
      report: rows.slice(0, 50).map((row) => { const state = states.get(row.id)!; return `${row.id}:${state.kind === 'going' ? state.way : state.kind}`; }).join('|') };
    return listed;
  };
  const rows = () => derive().rows;
  const stateOf = (row: TransferRow) => derive().states.get(row.id) ?? { kind: 'there', note: '', failed: false };
  const sendable = () => derive().sendable;
  const gettable = () => derive().gettable;
  const pages = () => Math.max(1, Math.ceil(rows().length / SONGS_PER_PAGE));
  const page = () => Math.min(st.page, pages() - 1);
  const pageRows = () => rows().slice(page() * SONGS_PER_PAGE, (page() + 1) * SONGS_PER_PAGE);

  const list = () => {
    const at = ++st.lists;
    listSongSummaries()
      .then((songs) => {
        if (at !== st.lists) return;
        st.songs = songs;
        st.listed = true;
      })
      .catch(() => { if (at === st.lists) { st.songs = []; st.listed = true; } })
      .finally(invalidate);
  };

  // How a batch of several went: "Sent 3 songs to iPhone. Received 1 song from iPhone."
  const summary = () => {
    const { out, in: inn, last, error } = st.run;
    const bad = out.bad + inn.bad;
    if (out.ok + inn.ok + bad <= 1) return last;
    const said = [out.ok && `Sent ${songCount(out.ok)} to ${peerName()}.`, inn.ok && `Received ${songCount(inn.ok)} from ${peerName()}.`,
      bad && (bad === 1 ? error : `${songCount(bad)} didn't make it: ${error}`)].filter((part) => !!part);
    return { text: said.join(' '), error: bad > 0 };
  };
  // What each song sent or received did, said once as it finishes, then how the batch went once
  // nothing more is going. The list turns to the song on its way, unless it's being used.
  const onTransferChange = (view: TransferView) => {
    st.view = view;
    listed = null;
    version++;
    const busy = view.outgoing.some(live) || view.incoming.some(live) || view.asked.length > 0;
    if (busy && !st.busy) st.run = newRun();
    for (const [way, items] of [['out', view.outgoing], ['in', view.incoming]] as const) {
      for (const item of items) {
        const id = `${way}:${item.id}`;
        if ((item.status !== 'done' && item.status !== 'failed') || st.told.has(id)) continue;
        st.told.add(id);
        st.notice = st.run.last = { text: item.text, error: item.status === 'failed' };
        if (item.status === 'done') { st.run[way].ok++; if (way === 'out') st.sent++; else st.received++; }
        else { st.run[way].bad++; st.run.error = item.text; }
      }
    }
    if (!busy && st.busy) st.notice = summary() ?? st.notice;
    st.busy = busy;
    const started = (item: TransferItem) => live(item) && item.status !== 'waiting';
    const out = view.outgoing.find(started), going = out ?? view.incoming.find(started);
    const id = going ? `${out ? 'out' : 'in'}:${going.id}` : '';
    if (going && id !== st.followed) {
      const at = rows().findIndex((row) => row.id === going.songId);
      const using = /^(send|get|transfer-(up|down|send-all|get-all))/.test(ui().keyFocus ?? '') || performance.now() - st.touched < FOLLOW_IDLE_MS;
      if (at >= 0 && !using) st.page = Math.floor(at / SONGS_PER_PAGE);
    }
    st.followed = id;
    invalidate();
  };
  const linkOptions = () => ({
    device: DEVICE,
    onChange: (view: TransferLinkView) => { st.linkView = { ...view }; invalidate(); },
    onChannel: (channel: TransferChannel) => {
      st.transfer?.close();
      st.notice = null;
      // A new connection counts its songs from one again.
      st.told.clear();
      st.run = newRun();
      st.busy = false;
      st.followed = '';
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
    listed = null;
    version++;
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

  const send = (list: TransferRow[]) => {
    if (connected()) st.transfer!.send(list.flatMap((row) => (row.mine ? [row.mine] : [])));
  };
  const get = (list: TransferRow[]) => {
    if (connected()) st.transfer!.request(list.map((row) => row.id));
  };
  const turn = (dir: -1 | 1) => { st.page = Math.min(pages() - 1, Math.max(0, page() + dir)); };

  // What's going one way, if anything: the same on both devices, but for which way it is.
  const activity = (way: Way): Activity | null => {
    const v = st.view;
    if (!v || !connected()) return null;
    const items = (way === 'out' ? v.outgoing : v.incoming).filter(live);
    const asked = way === 'in' ? v.asked.map((id) => rows().find((row) => row.id === id)?.title ?? id) : [];
    if (!items.length && !asked.length) return null;
    const item = items.find((i) => i.status !== 'waiting');
    const waiting = [...items.filter((i) => i.status === 'waiting').map((i) => i.title), ...asked];
    const finished = st.run[way].ok + st.run[way].bad;
    const total = finished + items.length + asked.length;
    return { way, item, title: item?.title ?? waiting[0], n: Math.min(total, finished + 1), total, next: item ? waiting : waiting.slice(1) };
  };

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

  // What's going one way, the same on both devices: which way and where in the batch, the song,
  // how far it's got, and what's next.
  const drawActivity = (g: CanvasRenderingContext2D, a: Activity, x: number, y: number, w: number, dots: string) => {
    const { item } = a;
    g.font = `700 20px ${FONT}`;
    const count = a.total > 1 ? `${a.n} of ${a.total}` : '';
    const countW = count ? g.measureText(count).width + 16 : 0;
    text(g, ellipsize(g, `${a.way === 'out' ? 'Sending to' : 'Receiving from'} ${peerName()}`, w - countW), x, y, { size: 20, weight: 700, color: '#b8fff0' });
    if (count) text(g, count, x + w, y, { size: 20, weight: 700, color: '#d8f6ff', align: 'right' });
    g.font = `800 28px ${FONT}`;
    text(g, ellipsize(g, a.title, w), x, y + 36, { size: 28, weight: 800 });
    drawProgress(g, { x, y: y + 60, w, h: 12 }, !item ? 0 : item.status === 'checking' ? 1 : item.size ? item.done / item.size : 0);
    // Room for the widest it gets, so what's next stays put.
    g.font = `700 19px ${FONT}`;
    const state = !item ? 'Waiting' : item.status === 'checking' ? `Checking${dots}` : `${percent(item)}%`;
    const stateW = Math.max(g.measureText('100%').width, g.measureText(state).width);
    text(g, state, x, y + 94, { size: 19, weight: 700, color: '#d8f6ff' });
    if (a.next.length) {
      const more = a.next.length - 1;
      g.font = `600 19px ${FONT}`;
      const tail = more ? ` and ${more} more` : '';
      const room = w - stateW - 16 - g.measureText(`Next: ${tail}`).width;
      text(g, `Next: ${ellipsize(g, a.next[0], room)}${tail}`, x + w, y + 94, { size: 19, weight: 600, color: 'rgba(216, 246, 255, 0.85)', align: 'right' });
    }
    g.textAlign = 'left';
  };

  const drawConnect = (g: CanvasRenderingContext2D, hover: Record<string, number>, press: (id: string) => number, dots: string) => {
    const { TRANSFER_CONNECT: C, TRANSFER_QR: Q, TRANSFER_DIGITS, TRANSFER_KEY, TRANSFER_LINK } = layout();
    const x = C.x + 40, w = C.w - 80;
    drawDarkGlassPanel(g, C, 34);
    drawCaps(g, connected() ? 'CONNECTED' : 'CONNECT', x, C.y + 44, { size: 22 });
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    const lv = st.linkView;
    const status = lv?.status ?? 'starting';

    if (connected()) {
      // Who's connected, what's going each way (or what to do), and how to stop.
      const cy = C.y + 124, peer = peerName();
      g.save();
      g.strokeStyle = '#ffffff';
      g.lineWidth = 4;
      g.lineCap = g.lineJoin = 'round';
      ICONS.transfer(g, x + 34, cy, 80);
      g.restore();
      text(g, 'Connected to', x + 90, cy - 18, { size: 22, weight: 700, color: '#d8f6ff' });
      g.font = `800 34px ${FONT}`;
      text(g, ellipsize(g, peer, w - 90), x + 90, cy + 18, { size: 34, weight: 800 });
      const going = [activity('out'), activity('in')].filter((a) => !!a);
      const here = DEVICE === 'Apple TV' ? 'on this Apple TV' : 'here';
      if (going.length) going.forEach((a, i) => drawActivity(g, a, x, C.y + 206 + i * 134, w, dots));
      else if (!st.view?.peer?.requests) paragraph(g, `Send songs from the list here, or send them from ${peer}: they're saved ${here} as they arrive.`, x, cy + 92, w, { size: 22 });
      else paragraph(g, `Send songs to ${peer} from the list, or get the ones it has. Either device can do both, and songs are saved ${here} as they arrive.`, x, cy + 92, w, { size: 22 });
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
      drawPanelLink(g, TRANSFER_LINK, { icon: 'qr', label: 'Show this device’s code', hover: hover['transfer-link'] ?? 0, press: press('transfer-link') });
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
    // Reserve room for the widest possible code so the font stays the same when a
    // code arrives or changes. The compact panel has less room beside the QR code.
    const widest = Math.max(...[...'0123456789'].map(d => g.measureText(spacedCode(d.repeat(CODE_DIGITS))).width),
      g.measureText('––– –––').width);
    const codeSize = Math.min(56, Math.floor(56 * tw / widest));
    if ('letterSpacing' in g) g.letterSpacing = `${4 * codeSize / 56}px`;
    text(g, lv?.code ? spacedCode(lv.code) : `–––${dots.length ? ' ' : ''}–––`, tx, Q.y + 72, { size: codeSize, weight: 800 });
    g.restore();
    if (url) {
      g.font = `800 22px ${FONT}`;
      text(g, ellipsize(g, url.host, tw), tx, Q.y + 126, { size: 22, weight: 800, color: '#bff4ff' });
    }
    const waiting = status === 'connecting' ? `Connecting to ${lv?.device || 'the other device'}${dots}` : status === 'waiting' ? `Waiting for the other device${dots}` : `Getting a code${dots}`;
    paragraph(g, waiting, tx, Q.y + 176, tw, { size: 20, weight: 700, lineH: 26 });
    paragraph(g, 'On the other device, scan the QR code, or open Settings → Songs → Transfer songs there and enter this code.',
      x, Q.y + Q.h + 44, w, { size: 22 });
    drawPanelLink(g, TRANSFER_LINK, { icon: 'keypad', label: 'Enter a code from another device', hover: hover['transfer-link'] ?? 0, press: press('transfer-link') });
  };

  const drawSongs = (g: CanvasRenderingContext2D, hover: Record<string, number>, press: (id: string) => number, dots: string) => {
    const { SONGS, SONG_ROW, SONG_TRASH, SONGS_UP, SONGS_DOWN, SONGS_NOTE_Y, SONG_ACTIONS, TRANSFER_SEND_ALL, TRANSFER_GET_ALL } = layout();
    const textX = SONGS.x + 40, textW = SONGS.w - 80;
    drawDarkGlassPanel(g, SONGS, 34);
    drawCaps(g, 'SONGS', textX, SONGS.y + 44, { size: 22 });
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    if (pages() > 1) {
      drawCircleButton(g, SONGS_UP, 'up', hover['transfer-up'] ?? 0, press('transfer-up'), page() > 0);
      drawCircleButton(g, SONGS_DOWN, 'down', hover['transfer-down'] ?? 0, press('transfer-down'), page() < pages() - 1);
      g.font = `700 20px ${FONT}`;
      g.textAlign = 'right';
      g.fillStyle = '#d8f6ff';
      g.fillText(`${page() + 1}/${pages()}`, SONGS_UP.x - SONGS_UP.r - 14, SONGS_UP.y + 1);
      g.textAlign = 'left';
    }
    const top = SONG_ROW(0);
    const on = connected(), peer = peerName();
    if (!st.listed) {
      g.font = `600 24px ${FONT}`;
      g.fillStyle = '#ffffff';
      g.fillText(`Loading${dots}`, textX, top.y + top.h / 2);
    } else if (!rows().length) {
      paragraph(g, on ? `No songs on this device or on ${peer} yet.` : 'No songs on this device yet. Connect another device to get the ones it has.',
        textX, top.y + top.h / 2, textW, { size: 22 });
    } else {
      pageRows().forEach((song, i) => {
        const row = SONG_ROW(i), cy = row.y + row.h / 2, c = SONG_TRASH(i);
        const state = stateOf(song);
        const act = state.kind === 'send' || state.kind === 'get' ? `${state.kind}-${song.id}` : '';
        const hv = act && on ? hover[act] ?? 0 : 0;
        if (hv > 0.01) {
          pill(g, row.x, row.y, row.w, row.h);
          g.fillStyle = `rgba(255,255,255,${hv * 0.1})`;
          g.fill();
        }
        // Where it is, or how far it's got: the same on both devices (which way it goes is at the row's end).
        const item = state.kind === 'going' ? state.item : undefined;
        const moving = !!item && item.status !== 'waiting';
        const status = state.kind === 'both' ? 'On both' : state.kind !== 'going' ? (state.failed ? 'Try again' : state.note)
          : !moving ? 'Waiting' : item.status === 'checking' ? 'Checking' : `${percent(item)}%`;
        g.font = `600 19px ${FONT}`;
        // A percentage takes the room its widest does, so the title doesn't shift as it counts.
        const statusW = status ? Math.min(STATUS_W, g.measureText(moving && item.status === 'sending' ? '100%' : status).width) : 0;
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
        if (status) {
          g.textAlign = 'right';
          g.fillStyle = state.kind === 'both' ? '#b8fff0' : state.kind !== 'going' && state.failed ? '#ffb38a' : '#d8f6ff';
          g.fillText(ellipsize(g, status, STATUS_W), c.x - c.r - 10, cy + 2);
          g.textAlign = 'left';
        }
        if (moving) drawProgress(g, { x: textX, y: row.y + row.h - 6, w: c.x - c.r - 10 - textX, h: 5 }, item.status === 'checking' ? 1 : percent(item) / 100);
        // At the row's end: the button to send or get it, a tick, or while it goes, which way.
        if (state.kind === 'send' || state.kind === 'get') drawCircleButton(g, c, state.kind, hv, press(act), on);
        else if (state.kind === 'both' || state.kind === 'going') {
          g.save();
          g.strokeStyle = state.kind === 'both' ? '#b8fff0' : '#ffffff';
          if (state.kind === 'going' && !moving) g.globalAlpha *= 0.6;
          g.lineWidth = 3;
          g.lineCap = g.lineJoin = 'round';
          ICONS[state.kind === 'both' ? 'check' : state.way === 'out' ? 'send' : 'get'](g, c.x, c.y, c.r * 1.6);
          g.restore();
        }
      });
    }

    // What the last song or batch did.
    const notice = st.notice ?? (!on && st.listed && st.songs.length ? { text: 'Connect another device to send it these, or to get the ones it has.', error: false } : null);
    if (notice) {
      g.font = `700 20px ${FONT}`;
      const lines = wrapText(g, notice.text, textW);
      const shown = lines.length > 2 ? [lines[0], ellipsize(g, lines.slice(1).join(' '), textW)] : lines;
      g.fillStyle = notice.error ? '#ffb38a' : '#d8f6ff';
      shown.forEach((line, i) => g.fillText(line, textX, SONGS_NOTE_Y + i * 26));
    }
    // Send all and Get all: side by side, or the one there is across the row with whose songs.
    const all = allLinks();
    for (const { id, act, count } of all) {
      const alone = all.length === 1;
      drawPanelLink(g, alone ? SONG_ACTIONS : act === 'send' ? TRANSFER_SEND_ALL : TRANSFER_GET_ALL, { icon: act, label: act === 'send' ? 'Send all' : 'Get all',
        note: alone ? ` · ${count} songs ${act === 'send' ? 'to' : 'from'} ${peer}` : ` · ${count}`, hover: hover[id] ?? 0, press: press(id) });
    }
  };
  // Send all and Get all, each while there's more than one song to.
  const allLinks = () => (!connected() ? [] : ([['send', sendable().length], ['get', gettable().length]] as const)
    .filter(([, count]) => count > 1).map(([act, count]) => ({ id: `transfer-${act}-all`, act, count })));

  // After a press by keyboard or remote takes its button away (the song is on its way), the cursor
  // goes on to the next song with a button, else the one before, else Send all or Get all. Never
  // to Disconnect: with none of those left it lets go.
  const refocus = (wdg: TransferWidget) => {
    const s = ui();
    const list = panel.widgets();
    if (!s.keyboard || list.some((other) => other.id === wdg.id)) return;
    const at = wdg.at ?? -1;
    const songs = list.filter((other) => other.at !== undefined);
    const next = (wdg.entry ? songs.find((other) => other.at! > at) ?? songs.reverse().find((other) => other.at! < at) : undefined)
      ?? list.find((other) => other.id.endsWith('-all'));
    if (next) s.focus(next);
  };

  const panel: TransferPanel = {
    open(code) {
      st.open = true;
      st.page = 0;
      st.notice = null;
      st.listed = false;
      list();
      if (code) join(code);
      else if (client() === 'tvos') showCode();
      else enterCode();
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
      const { SONG_TRASH, SONGS_UP, SONGS_DOWN, SONG_ACTIONS, TRANSFER_SEND_ALL, TRANSFER_GET_ALL, TRANSFER_KEY, TRANSFER_LINK } = layout();
      const list: TransferWidget[] = [];
      const ended = st.linkView?.status === 'ended';
      list.push({ id: 'transfer-link', rect: TRANSFER_LINK });
      if (!connected() && !ended && st.mode === 'enter' && !st.link) KEYS.forEach((key, i) => list.push({ id: `key-${key}`, key, rect: TRANSFER_KEY(i), corner: 18 }));
      if (connected()) {
        pageRows().forEach((entry, at) => {
          const { kind } = stateOf(entry);
          if (kind === 'send' || kind === 'get') list.push({ id: `${kind}-${entry.id}`, entry, act: kind, at, circle: SONG_TRASH(at) });
        });
        const all = allLinks();
        for (const { id, act } of all) list.push({ id, act, rect: all.length === 1 ? SONG_ACTIONS : act === 'send' ? TRANSFER_SEND_ALL : TRANSFER_GET_ALL });
      }
      if (page() > 0) list.push({ id: 'transfer-up', circle: SONGS_UP });
      if (page() < pages() - 1) list.push({ id: 'transfer-down', circle: SONGS_DOWN });
      return list;
    },
    activate(wdg) {
      const inList = !!wdg.act || wdg.id === 'transfer-up' || wdg.id === 'transfer-down';
      if (inList) st.touched = performance.now();
      if (wdg.entry) (wdg.act === 'get' ? get : send)([wdg.entry]);
      else if (wdg.key) type(wdg.key);
      else if (wdg.id === 'transfer-send-all') send(sendable());
      else if (wdg.id === 'transfer-get-all') get(gettable());
      else if (wdg.id === 'transfer-up') turn(-1);
      else if (wdg.id === 'transfer-down') turn(1);
      else if (wdg.id === 'transfer-link') {
        const ended = st.linkView?.status === 'ended';
        if (connected()) { if (st.mode === 'enter') enterCode(); else showCode(); }
        else if (ended) { if (st.mode === 'enter') enterCode(); else showCode(); }
        else if (st.mode === 'enter') showCode();
        else enterCode();
      } else return false;
      invalidate();
      if (wdg.act) refocus(wdg);
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
    key: () => [version, st.mode, st.typed, st.listed, st.page, st.notice?.text].join('~'),
    busy: () => st.open && (!st.listed || (!connected() && st.linkView?.status !== 'ended' && (st.mode === 'code' || !!st.link)) ||
      !!st.view?.incoming.some((i) => i.status === 'checking') || !!st.view?.outgoing.some((o) => o.status === 'checking')),
    report(): Record<string, string> {
      const v = connected() ? st.view : null;
      const report = {
        transferStatus: st.mode === 'enter' && !st.link ? 'entering' : st.linkView?.status ?? '',
        transferMode: st.mode,
        transferCode: st.linkView?.code ?? '',
        transferDevice: connected() ? peerName() : '',
        transferTransport: st.linkView?.transport ?? '',
        transferSongs: st.listed ? String(st.songs.length) : '',
        transferRows: derive().report,
        transferSending: v ? String(v.outgoing.filter(live).length) : '',
        transferReceiving: v ? String(v.incoming.filter(live).length + v.asked.length) : '',
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
  return panel;
}
