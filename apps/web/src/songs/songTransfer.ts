import { isArray, isObject } from '../../../../packages/pose/choreography.ts';
import { makeZip } from '../../../../packages/pose/zip.ts';
import { importSongZip, listSavedSongs, songStore } from './customSongs.ts';
import type { CustomSongStore, ImportResult } from './customSongs.ts';
import { MAX_BUNDLE_BYTES } from './loadBundle.ts';

/*
 * Sending imported songs between two copies of the game (Settings → Songs → Transfer songs,
 * menu/transferPanel.ts), over a connection songs/transferLink.ts makes: a WebRTC data channel,
 * or the pairing server's relay for the Apple TV app, which has no WebRTC.
 *
 * Either side can send, and either can ask the other to send (request). Each says hello with what
 * it calls itself and the songs it has, and says again whenever they change, so both can list the
 * songs on either device and where each one is. A song goes as the ZIP Dance Studio exports, in
 * pieces of PIECE_BYTES, at most WINDOW_BYTES of them unacknowledged (the relay closes a link whose
 * other side falls a megabyte behind); the receiver takes it as Import song takes a ZIP
 * (importSongZip: checked as fully as playing it would be, then saved) without asking: a copy of
 * the same revision is replaced unless it's the same copy (the same song.json), and a later
 * revision is kept. One song goes at a time each way; sending several queues them.
 *
 * Both sides see the same thing happen. The sender says which songs wait their turn (queue), so
 * the receiver lists them as waiting too, and counts a song's progress by what the receiver has
 * acknowledged, which is what the receiver counts.
 *
 *   text    JSON, one of TransferMessage
 *   binary  a piece: transfer id (uint32), offset (uint32), then its bytes
 *
 * A side that doesn't know a message ignores it, so a copy of the game from before queue and
 * request still sends and receives: it says nothing of what it can do in its hello (can), and is
 * never asked.
 *
 * const transfer = createSongTransfer({ channel, device: 'Apple TV', onChange });
 * transfer.send([{ id, title }]); transfer.request([id]); transfer.view(); transfer.close();
 */

/** A song as the other side lists it: enough to show whether this side has it. */
export interface SongSummary { id: string; title: string; artist: string; revision: number; sha256: string; }
/** A song waiting its turn to be sent, as the sender tells the receiver. */
export interface QueuedSong { id: number; songId: string; title: string; }
export type TransferMessage =
  /** can: what this side answers beyond sending and receiving ('request'). */
  | { type: 'hello'; device: string; songs: SongSummary[]; can: string[] }
  | { type: 'songs'; songs: SongSummary[] }
  /** The sender's songs still to come, in order, after any on its way. */
  | { type: 'queue'; items: QueuedSong[] }
  /** Asks the other side to send these songs of its own. */
  | { type: 'request'; songIds: string[] }
  | { type: 'offer'; id: number; songId: string; title: string; size: number }
  | { type: 'ack'; id: number; received: number }
  | { type: 'result'; id: number; ok: boolean; status?: ImportResult['status']; text: string }
  | { type: 'cancel'; id: number; text: string };

/** The connection: text and binary messages in order, as a data channel or the relay carries them. */
export interface TransferChannel {
  /** Bytes sent and not yet gone out. */
  readonly bufferedAmount: number;
  sendText(text: string): void;
  sendBinary(bytes: Uint8Array<ArrayBuffer>): void;
  onText: ((text: string) => void) | null;
  onBinary: ((bytes: ArrayBuffer) => void) | null;
  onClose: (() => void) | null;
  close(): void;
}

/** The relay takes frames of up to 64 KB, the header included. */
export const PIECE_BYTES = 48 * 1024;
export const WINDOW_BYTES = 8 * PIECE_BYTES;
const HEADER_BYTES = 8;
const MAX_SONGS_LISTED = 500;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const text = (value: unknown, max = 200) => (typeof value === 'string' ? value.slice(0, max) : '');
const id = (value: unknown) => (Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 0xffffffff ? value as number : null);

const strings = (value: unknown, most: number) => (isArray(value) ? value : []).slice(0, most).flatMap((s) => (typeof s === 'string' && s ? [text(s)] : []));

function summaries(value: unknown): SongSummary[] {
  if (!isArray(value)) return [];
  return value.slice(0, MAX_SONGS_LISTED).flatMap((s) => (isObject(s) && typeof s.id === 'string' && Number.isSafeInteger(s.revision)
    ? [{ id: text(s.id), title: text(s.title) || text(s.id), artist: text(s.artist), revision: s.revision as number, sha256: text(s.sha256, 64) }] : []));
}

/** A message from the other side, or null for anything else. */
export function parseTransferMessage(value: unknown): TransferMessage | null {
  if (!isObject(value)) return null;
  switch (value.type) {
    case 'hello': return typeof value.device === 'string' ? { type: 'hello', device: text(value.device, 80), songs: summaries(value.songs), can: strings(value.can, 20) } : null;
    case 'songs': return { type: 'songs', songs: summaries(value.songs) };
    case 'queue':
      return { type: 'queue', items: (isArray(value.items) ? value.items : []).slice(0, MAX_SONGS_LISTED).flatMap((q) => {
        const n = isObject(q) ? id(q.id) : null;
        return n !== null && isObject(q) && typeof q.songId === 'string' ? [{ id: n, songId: text(q.songId), title: text(q.title) || text(q.songId) }] : [];
      }) };
    case 'request': return { type: 'request', songIds: strings(value.songIds, MAX_SONGS_LISTED) };
    case 'offer': {
      const n = id(value.id);
      return n !== null && typeof value.songId === 'string' && Number.isSafeInteger(value.size) && (value.size as number) > 0
        ? { type: 'offer', id: n, songId: text(value.songId), title: text(value.title) || text(value.songId), size: value.size as number } : null;
    }
    case 'ack': {
      const n = id(value.id);
      return n !== null && Number.isSafeInteger(value.received) ? { type: 'ack', id: n, received: value.received as number } : null;
    }
    case 'result': {
      const n = id(value.id);
      const status = value.status === 'imported' || value.status === 'replaced' || value.status === 'kept' ? value.status : undefined;
      return n !== null && typeof value.ok === 'boolean' ? { type: 'result', id: n, ok: value.ok, ...(status ? { status } : {}), text: text(value.text, 400) } : null;
    }
    case 'cancel': {
      const n = id(value.id);
      return n !== null ? { type: 'cancel', id: n, text: text(value.text, 400) } : null;
    }
    default: return null;
  }
}

/** A saved song as the ZIP Dance Studio exports (everything in <songId>/), or undefined if it's gone. */
export async function savedSongZip(songId: string, store: CustomSongStore = songStore()) {
  const record = await store.get(songId);
  if (!record) return undefined;
  const files = new Map<string, Uint8Array>();
  for (const path of record.sizes.keys()) {
    const bytes = await store.file(songId, path);
    if (!bytes) throw Error(`Its ${path} is missing.`);
    files.set(`${songId}/${path}`, bytes);
  }
  return { title: record.entry.title, zip: makeZip(files) };
}

/** A song going one way: queued, on its way, being checked by the receiver, or done. */
export interface TransferItem {
  id: number;
  songId: string;
  title: string;
  status: 'waiting' | 'sending' | 'checking' | 'done' | 'failed';
  /** Bytes the receiver has so far, of size (0 until it's known): what it has acknowledged, for the
   *  sender, so both sides count the same. */
  done: number;
  size: number;
  /** How it went, once it has (done or failed). */
  text: string;
}
export interface TransferView {
  /** The other side once it's said hello: what it calls itself, its songs, and whether it sends
   *  the ones it's asked for (request). */
  peer: { device: string; songs: SongSummary[]; requests: boolean } | null;
  /** Songs this side is sending (in order) and receiving (those still waiting their turn there
   *  last, in order). */
  outgoing: TransferItem[];
  incoming: TransferItem[];
  /** Songs asked of the other side that it hasn't queued yet. */
  asked: string[];
  /** The connection has closed. */
  closed: boolean;
}
export interface SongTransferOptions {
  channel: TransferChannel;
  /** What this side calls itself ("Apple TV", "iPhone"…). */
  device: string;
  store?: CustomSongStore;
  /** After every change to the view. */
  onChange?: (view: TransferView) => void;
  /** A song this side received and saved (the Songs panel lists it again). */
  onSaved?: (result: ImportResult) => void;
  /** This side's songs that check out, for the hello. */
  listSongs?: () => Promise<SongSummary[]>;
  warn?: (message: string) => void;
}
export interface SongTransfer {
  view(): TransferView;
  /** Queues this side's songs to send; one already queued or on its way isn't queued again. */
  send(songs: Pick<SongSummary, 'id' | 'title'>[]): void;
  /** Asks the other side to send these songs of its own (where it answers: view().peer.requests). */
  request(songIds: string[]): void;
  /** Tells the other side this side's songs again (after a removal here). */
  refresh(): void;
  close(): void;
}

/** What a song the receiver checked did there, said from the sender's side. */
function resultText(device: string, title: string, status: ImportResult['status'] | undefined) {
  if (status === 'replaced') return `Updated “${title}” on ${device}.`;
  if (status === 'kept') return `${device} already has “${title}”.`;
  return `Sent “${title}” to ${device}.`;
}

const live = (item: TransferItem) => item.status === 'waiting' || item.status === 'sending' || item.status === 'checking';
/** A list of items without its finished ones beyond the last ten. */
function recent(items: TransferItem[]) {
  const finished = items.filter((item) => !live(item));
  const old = new Set(finished.slice(0, Math.max(0, finished.length - 10)));
  return old.size ? items.filter((item) => !old.has(item)) : items;
}

export const listSongSummaries = async (store: CustomSongStore = songStore()): Promise<SongSummary[]> =>
  (await listSavedSongs(store, () => {})).filter((s) => !s.damaged)
    .map(({ entry }) => ({ id: entry.id, title: entry.title, artist: entry.artist, revision: entry.bundleRevision, sha256: entry.sha256 ?? '' }));

export function createSongTransfer({ channel, device, store = songStore(), onChange, onSaved, listSongs = () => listSongSummaries(store), warn = console.warn }: SongTransferOptions): SongTransfer {
  const st: TransferView = { peer: null, outgoing: [], incoming: [], asked: [], closed: false };
  let nextId = 1;
  // The song this side is sending now: its bytes, and how many have gone (item.done: how many the
  // receiver has acknowledged). Before that, the one being read to send (not yet offered).
  let sending: { item: TransferItem; zip: Uint8Array<ArrayBuffer>; sent: number } | null = null;
  let preparing: TransferItem | null = null;
  // The song coming in: its bytes so far.
  let receiving: { item: TransferItem; bytes: Uint8Array<ArrayBuffer> } | null = null;
  const changed = () => onChange?.(st);
  const message = (msg: TransferMessage) => {
    if (st.closed) return;
    try { channel.sendText(JSON.stringify(msg)); }
    catch (error) { warn(`The transfer couldn't send: ${errorText(error)}`); }
  };
  const peerName = () => st.peer?.device || 'the other device';

  const mine = async () => {
    try { return await listSongs(); }
    catch (error) { warn(`Songs to transfer couldn't be listed: ${errorText(error)}`); return []; }
  };
  const hello = async (type: 'hello' | 'songs') => {
    const songs = await mine();
    message(type === 'hello' ? { type, device, songs, can: ['request'] } : { type, songs });
  };
  // Tells the receiver which songs are still to come: those waiting, and the one being read.
  const announce = () => message({ type: 'queue', items: st.outgoing.filter((o) => o.status === 'waiting' || o === preparing)
    .map((o) => ({ id: o.id, songId: o.songId, title: o.title })) });
  // Songs asked of the other side are no longer just asked once it queues them, or has lost them.
  const settleAsked = () => {
    st.asked = st.asked.filter((songId) => !st.incoming.some((i) => i.songId === songId && live(i)) && (!st.peer || st.peer.songs.some((s) => s.id === songId)));
  };

  // Sends the queue's next song, if nothing is on its way.
  const next = async () => {
    if (sending || st.closed) return;
    if (preparing) return;
    const item = st.outgoing.find((o) => o.status === 'waiting');
    if (!item) return;
    item.status = 'sending';
    preparing = item;
    changed();
    let zip: Uint8Array<ArrayBuffer>;
    try {
      const saved = await savedSongZip(item.songId, store);
      if (!saved) throw Error('It has been removed.');
      zip = saved.zip;
      if (zip.byteLength > MAX_BUNDLE_BYTES) throw Error("It's too big to send.");
    } catch (error) {
      preparing = null;
      if (st.closed) return;
      item.status = 'failed';
      item.text = `“${item.title}” couldn't be sent: ${errorText(error)}`;
      // The receiver was told it was coming.
      message({ type: 'cancel', id: item.id, text: item.text });
      changed();
      void next();
      return;
    }
    preparing = null;
    if (st.closed) return;
    item.size = zip.byteLength;
    sending = { item, zip, sent: 0 };
    message({ type: 'offer', id: item.id, songId: item.songId, title: item.title, size: zip.byteLength });
    pump();
  };
  // Sends pieces while fewer than WINDOW_BYTES are unacknowledged.
  const pump = () => {
    if (!sending || st.closed) return;
    const { item, zip } = sending;
    while (sending.sent < zip.byteLength && sending.sent - item.done < WINDOW_BYTES && channel.bufferedAmount < WINDOW_BYTES) {
      const end = Math.min(zip.byteLength, sending.sent + PIECE_BYTES);
      const piece = new Uint8Array(HEADER_BYTES + end - sending.sent);
      const header = new DataView(piece.buffer);
      header.setUint32(0, item.id, true);
      header.setUint32(4, sending.sent, true);
      piece.set(zip.subarray(sending.sent, end), HEADER_BYTES);
      try { channel.sendBinary(piece); }
      catch (error) { finishSending(false, `“${item.title}” couldn't be sent: ${errorText(error)}`); return; }
      sending.sent = end;
    }
    changed();
  };
  const finishSending = (ok: boolean, why: string) => {
    if (!sending) return;
    const { item } = sending;
    sending = null;
    item.status = ok ? 'done' : 'failed';
    item.text = why;
    changed();
    void next();
  };

  const failIncoming = (why: string, tell = true) => {
    if (!receiving) return;
    const { item } = receiving;
    receiving = null;
    item.status = 'failed';
    item.text = why;
    if (tell) message({ type: 'result', id: item.id, ok: false, text: why });
    changed();
  };
  const receive = async (item: TransferItem, bytes: Uint8Array<ArrayBuffer>) => {
    item.status = 'checking';
    changed();
    try {
      // Without asking: the same revision is replaced (another copy of it was sent on purpose)
      // unless it's the same copy, and a later one is kept.
      let later = false;
      const result = await importSongZip(new Blob([bytes], { type: 'application/zip' }), {
        store, confirmReplace: (saved, incoming) => {
          later = saved.bundleRevision > incoming.bundleRevision;
          return saved.bundleRevision === incoming.bundleRevision && saved.sha256 !== incoming.sha256;
        },
      });
      if (receiving?.item !== item) return;
      receiving = null;
      item.status = 'done';
      item.title = result.entry.title;
      item.text = result.status === 'kept' ? `Already had “${result.entry.title}”${later ? ' (a later revision)' : ''}.`
        : result.status === 'replaced' ? `Updated “${result.entry.title}” from ${peerName()}.` : `Received “${result.entry.title}” from ${peerName()}.`;
      message({ type: 'result', id: item.id, ok: true, status: result.status, text: item.text });
      changed();
      onSaved?.(result);
      if (result.status !== 'kept') void hello('songs');
    } catch (error) {
      if (receiving?.item === item) failIncoming(`“${item.title}” couldn't be saved: ${errorText(error)}`);
    }
  };

  // Sends the songs the other side asked for, and tells it again what's here if any have gone.
  const answer = async (songIds: string[]) => {
    const songs = await mine();
    if (st.closed) return;
    const found = songs.filter((song) => songIds.includes(song.id));
    if (found.length < songIds.length) message({ type: 'songs', songs });
    queue(found);
  };
  const queue = (songs: Pick<SongSummary, 'id' | 'title'>[]) => {
    for (const song of songs) {
      if (st.outgoing.some((o) => o.songId === song.id && live(o))) continue;
      st.outgoing.push({ id: nextId++, songId: song.id, title: song.title, status: 'waiting', done: 0, size: 0, text: '' });
    }
    st.outgoing = recent(st.outgoing);
    announce();
    changed();
    void next();
  };

  channel.onText = (data) => {
    let value: unknown;
    try { value = JSON.parse(data); } catch { return; }
    const msg = parseTransferMessage(value);
    if (!msg || st.closed) return;
    switch (msg.type) {
      case 'hello':
        st.peer = { device: msg.device || 'Another device', songs: msg.songs, requests: msg.can.includes('request') };
        break;
      case 'songs':
        if (st.peer) st.peer.songs = msg.songs;
        settleAsked();
        break;
      case 'queue': {
        // The songs still to come are these now: those listed before and gone from it never came.
        const started = st.incoming.filter((i) => i.status !== 'waiting');
        const waiting = msg.items.filter((q) => !started.some((i) => i.id === q.id))
          .map((q): TransferItem => st.incoming.find((i) => i.id === q.id) ?? { ...q, status: 'waiting', done: 0, size: 0, text: '' });
        st.incoming = [...started, ...waiting];
        settleAsked();
        break;
      }
      case 'request':
        void answer(msg.songIds);
        break;
      case 'offer': {
        // One at a time: a new offer replaces one cut short.
        if (receiving) failIncoming(`“${receiving.item.title}” stopped arriving.`, false);
        const item: TransferItem = { id: msg.id, songId: msg.songId, title: msg.title, status: 'sending', done: 0, size: msg.size, text: '' };
        // It takes its place among the ones started, ahead of those still waiting.
        const others = st.incoming.filter((i) => i.id !== msg.id || i.status !== 'waiting');
        const firstWaiting = others.findIndex((i) => i.status === 'waiting');
        others.splice(firstWaiting < 0 ? others.length : firstWaiting, 0, item);
        st.incoming = recent(others);
        settleAsked();
        if (msg.size > MAX_BUNDLE_BYTES) {
          item.status = 'failed';
          item.text = `“${msg.title}” is too big to be a song.`;
          message({ type: 'result', id: msg.id, ok: false, text: item.text });
        } else receiving = { item, bytes: new Uint8Array(msg.size) };
        break;
      }
      case 'ack':
        if (sending?.item.id === msg.id) {
          const { item, zip } = sending;
          item.done = Math.max(item.done, Math.min(msg.received, sending.sent));
          if (item.done >= zip.byteLength && item.status === 'sending') item.status = 'checking';
          pump();
        }
        break;
      case 'result':
        if (sending?.item.id === msg.id) {
          const { item } = sending;
          finishSending(msg.ok, msg.ok ? resultText(peerName(), item.title, msg.status) : msg.text || `${peerName()} couldn't take “${item.title}”.`);
        }
        break;
      case 'cancel': {
        if (receiving?.item.id === msg.id) { failIncoming(msg.text || `“${receiving.item.title}” was cancelled.`, false); break; }
        // One that never started.
        const waiting = st.incoming.find((i) => i.id === msg.id && i.status === 'waiting');
        if (waiting) {
          waiting.status = 'failed';
          waiting.text = msg.text || `“${waiting.title}” was cancelled.`;
          st.incoming = recent([...st.incoming.filter((i) => i !== waiting && i.status !== 'waiting'), waiting, ...st.incoming.filter((i) => i.status === 'waiting')]);
        }
        break;
      }
    }
    changed();
  };

  channel.onBinary = (data) => {
    if (st.closed || data.byteLength < HEADER_BYTES) return;
    const header = new DataView(data, 0, HEADER_BYTES);
    const pieceId = header.getUint32(0, true), offset = header.getUint32(4, true);
    if (!receiving || receiving.item.id !== pieceId || receiving.item.status !== 'sending') return;
    const { item, bytes } = receiving;
    const length = data.byteLength - HEADER_BYTES;
    // In order, and within the size offered.
    if (offset !== item.done || offset + length > item.size) { failIncoming(`“${item.title}” arrived damaged.`); return; }
    bytes.set(new Uint8Array(data, HEADER_BYTES), offset);
    item.done += length;
    message({ type: 'ack', id: item.id, received: item.done });
    if (item.done === item.size) void receive(item, bytes);
    changed();
  };

  channel.onClose = () => {
    if (st.closed) return;
    st.closed = true;
    const lost = `The connection to ${peerName()} closed.`;
    for (const item of st.outgoing) if (live(item)) { item.status = 'failed'; item.text = lost; }
    sending = null;
    // A song already being checked here is still saved if it checks out.
    if (receiving && receiving.item.status === 'sending') failIncoming(lost, false);
    // Those that never started aren't coming.
    st.incoming = st.incoming.filter((i) => i.status !== 'waiting');
    st.asked = [];
    changed();
  };

  void hello('hello');

  return {
    view: () => st,
    send(songs) {
      if (!st.closed) queue(songs);
    },
    request(songIds) {
      if (st.closed || !st.peer?.requests) return;
      // Not one already asked for or on its way here.
      const ask = [...new Set(songIds)].filter((songId) => !st.asked.includes(songId) && !st.incoming.some((i) => i.songId === songId && live(i)));
      if (!ask.length) return;
      st.asked = [...st.asked, ...ask];
      message({ type: 'request', songIds: ask });
      changed();
    },
    refresh: () => { void hello('songs'); },
    close() {
      if (st.closed) return;
      if (sending) message({ type: 'cancel', id: sending.item.id, text: `${device} stopped sending “${sending.item.title}”.` });
      channel.onClose?.();
      channel.close();
    },
  };
}
