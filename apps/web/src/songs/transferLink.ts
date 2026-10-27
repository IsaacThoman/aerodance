import { Peer } from '../../../../packages/pairing/browser/peer.ts';
import type { CreatePeerConnection } from '../../../../packages/pairing/browser/peer.ts';
import { RelayLink, relayUrl } from '../../../../packages/pairing/browser/relay.ts';
import type { CreateRelaySocket } from '../../../../packages/pairing/browser/relay.ts';
import { SignalChannel, createRoom, joinRoom } from '../../../../packages/pairing/browser/signalChannel.ts';
import type { EventStream } from '../../../../packages/pairing/browser/signalChannel.ts';
import type { CreatedRoom, JoinedRoom, PairingEvent } from '../../../../packages/pairing/signals.ts';
import { client } from '../host.ts';
import { pairingBase, pairingOrigin } from '../pose/PhonePoseSource.ts';
import type { TransferChannel } from './songTransfer.ts';

/*
 * The connection two copies of the game send songs over (songs/songTransfer.ts), made through a
 * transfer room on the pairing server (packages/pairing/server.ts): one shows a code and a QR
 * code (the host: hostTransfer), the other enters it or opens the QR code's link, the game at
 * /?transfer=<code> (the guest: joinTransfer).
 *
 * The guest says hello; the host then offers a WebRTC data channel, or where either can't make
 * one in WEBRTC_OPEN_MS (the Apple TV app has no WebRTC at all), connects them through the
 * pairing server's relay instead. Either way the result is a TransferChannel. When it closes,
 * the host waits for the guest (or another device) again on the same code; the guest's link
 * has ended.
 *
 * const link = hostTransfer({ device, onChange, onChannel });   // link.view().code, .url
 * const link = joinTransfer(code, { device, onChange, onChannel });
 * link.close();
 */

export interface TransferLinkView {
  /** starting: getting a code (host) or joining one (guest); waiting: for the other device to
   *  join (host); connecting; connected; ended (error says why, when it wasn't asked for). */
  status: 'starting' | 'waiting' | 'connecting' | 'connected' | 'ended';
  /** The host's code and the link its QR code opens. */
  code: string;
  url: string;
  /** The other device, once it has said hello. */
  device: string;
  /** relay or webrtc, while connected. */
  transport: 'relay' | 'webrtc' | '';
  error: string;
}
export interface TransferLinkOptions {
  /** What this device calls itself (transferDeviceName). */
  device?: string;
  onChange?: (view: TransferLinkView) => void;
  /** A connection that has opened: songs go over it until it closes. */
  onChannel: (channel: TransferChannel, device: string) => void;
  base?: string;
  origin?: () => string;
  fetch?: typeof fetch;
  createStream?: (url: string) => EventStream;
  createConnection?: CreatePeerConnection;
  createSocket?: CreateRelaySocket;
  /** WebRTC, the relay, or auto: WebRTC where both ends have it, the relay otherwise (?transport= on the page, as for phone pairing). */
  transport?: 'auto' | 'webrtc' | 'relay';
}
export interface TransferLink {
  view(): TransferLinkView;
  close(): void;
}

const LABEL = 'songs';
// A WebRTC attempt that hasn't opened in this long falls back to the relay.
const WEBRTC_OPEN_MS = 8000;
const askedTransport = () => {
  const asked = new URLSearchParams(globalThis.location?.search ?? '').get('transport');
  return asked === 'relay' || asked === 'webrtc' ? asked : 'auto';
};
const reason = (error: unknown) => (error instanceof Error && error.message) || 'Transferring songs failed. Try again.';

/** What this device calls itself to the other: "Apple TV", "iPhone", "Mac"… */
export function transferDeviceName(ua = globalThis.navigator?.userAgent ?? '', platform = client()) {
  if (platform === 'tvos') return 'Apple TV';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && (globalThis.navigator?.maxTouchPoints ?? 0) > 1)) return 'iPad';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  if (/CrOS/.test(ua)) return 'Chromebook';
  if (/Macintosh|Mac OS X/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Linux/.test(ua)) return 'Linux computer';
  return 'Another device';
}

/** The link a transfer code's QR code opens: the game, which joins it (App.tsx). */
export const transferUrl = (code: string, origin = pairingOrigin()) => `${origin.replace(/\/+$/, '')}/?transfer=${code}`;
/** The code a page's address carries (?transfer=123456), or ''. */
export function transferCode(search = globalThis.location?.search ?? '') {
  const code = new URLSearchParams(search).get('transfer') ?? '';
  return /^\d{6}$/.test(code) ? code : '';
}

/** A WebRTC data channel as a TransferChannel; ended() after its onClose once it closes. */
function dataChannel(dc: RTCDataChannel, ended: () => void): TransferChannel {
  dc.binaryType = 'arraybuffer';
  const channel: TransferChannel = {
    get bufferedAmount() { return dc.bufferedAmount; },
    sendText: (text) => dc.send(text),
    sendBinary: (bytes) => dc.send(bytes),
    onText: null, onBinary: null, onClose: null,
    close: () => dc.close(),
  };
  dc.onmessage = ({ data }) => {
    if (typeof data === 'string') channel.onText?.(data);
    else if (data instanceof ArrayBuffer) channel.onBinary?.(data);
  };
  // The browser closes it as the connection goes, too.
  dc.onclose = () => { channel.onClose?.(); ended(); };
  return channel;
}

/** A relayed link as a TransferChannel: text on its control channel, pieces as binary frames. */
function relayChannel(link: RelayLink, ended: () => void): TransferChannel {
  const channel: TransferChannel = {
    get bufferedAmount() { return link.socket.bufferedAmount; },
    sendText: (text) => link.control.send(text),
    sendBinary: (bytes) => {
      if (link.control.readyState !== 'open') throw Error('The connection has closed.');
      link.socket.send(bytes);
    },
    onText: null, onBinary: null, onClose: null,
    close: () => link.close(),
  };
  link.control.onmessage = ({ data }) => { if (typeof data === 'string') channel.onText?.(data); };
  link.onframe = (bytes) => channel.onBinary?.(bytes);
  link.control.onclose = () => { channel.onClose?.(); ended(); };
  return channel;
}

/** One end of a transfer room: the host's or the guest's. */
class Link implements TransferLink {
  st: TransferLinkView = { status: 'starting', code: '', url: '', device: '', transport: '', error: '' };
  opts: TransferLinkOptions;
  host: boolean;
  base: string;
  device: string;
  room: (CreatedRoom | (JoinedRoom & { code: string })) | null = null;
  /** The guest's join (its leaving ends only this join's place). */
  session = Math.random().toString(36).slice(2);
  signals: SignalChannel | null = null;
  epoch = 0;
  peer: Peer | null = null;
  relay: RelayLink | null = null;
  channel: TransferChannel | null = null;
  fallback: ReturnType<typeof setTimeout> | undefined;
  closed = false;
  webrtc: boolean;

  constructor(host: boolean, opts: TransferLinkOptions) {
    this.host = host;
    this.opts = opts;
    this.base = opts.base ?? pairingBase();
    this.device = opts.device ?? transferDeviceName();
    const transport = opts.transport ?? askedTransport();
    this.webrtc = transport === 'webrtc' || (transport === 'auto' && (!!opts.createConnection || typeof RTCPeerConnection !== 'undefined'));
  }

  view() { return this.st; }
  publish(patch: Partial<TransferLinkView>) {
    Object.assign(this.st, patch);
    this.opts.onChange?.(this.st);
  }
  fail(error: unknown) {
    if (this.closed) return;
    this.publish({ status: 'ended', error: reason(error), transport: '' });
    this.shutdown();
  }

  async start(code = '') {
    try {
      if (this.host) {
        const room = await createRoom(this.base, this.opts.fetch, 'transfer');
        if (this.closed) return;
        this.room = room;
        this.publish({ status: 'waiting', code: room.code, url: transferUrl(room.code, (this.opts.origin ?? pairingOrigin)()) });
      } else {
        const joined = await joinRoom(code, null, this.session, this.base, this.opts.fetch, 'transfer');
        if (this.closed) return;
        this.room = { ...joined, code };
        this.publish({ status: 'connecting', code });
      }
    } catch (error) {
      this.fail(error);
      return;
    }
    const { room } = this;
    const signals = this.signals = new SignalChannel({
      code: room.code, token: room.token, session: this.host ? '' : this.session, base: this.base, fetch: this.opts.fetch, createStream: this.opts.createStream,
      onEvent: (event) => this.onEvent(event),
    });
    signals.open();
    if (!this.host) signals.send({ type: 'hello', device: this.device }).catch((error: unknown) => this.fail(error));
  }

  onEvent(event: PairingEvent) {
    if (this.closed) return;
    switch (event.type) {
      case 'closed':
        this.fail(Error(this.host ? event.reason : 'The other device stopped transferring songs.'));
        break;
      case 'hello':
        // The guest (again, or another one in its place): a new connection.
        if (this.host) this.connect(event.device);
        break;
      case 'offer':
        if (!this.host) void this.answer(event.epoch, event.sdp);
        break;
      case 'answer':
        if (this.host && this.peer?.epoch === event.epoch) void this.peer.accept(event.sdp).catch(() => {});
        break;
      case 'ice':
        if (this.peer?.epoch === event.epoch) void this.peer.addIce(event.candidate);
        break;
      case 'relay':
        if (!this.host) this.joinRelay(event.epoch);
        break;
      case 'peer':
        // The guest left for good: wait for another.
        if (this.host && event.left) { this.drop(); this.publish({ status: 'waiting', device: '' }); }
        break;
    }
  }

  // The host: connect to the guest that said hello, by WebRTC if it can (falling back to the
  // relay if that doesn't open), else the relay.
  connect(device: string, relay = !this.webrtc) {
    const { room, signals } = this;
    if (!room || !signals) return;
    this.drop();
    const epoch = ++this.epoch;
    this.publish({ status: 'connecting', device, transport: '' });
    if (relay) {
      const link = this.relay = new RelayLink({ url: relayUrl(this.base, room.code, room.token, epoch), createSocket: this.opts.createSocket });
      link.onsocketopen = () => { if (link === this.relay) signals.send({ type: 'relay', epoch }).catch(() => {}); };
      this.openRelay(link);
      return;
    }
    let peer: Peer;
    try {
      peer = this.peer = new Peer({ epoch, iceServers: room.iceServers, createConnection: this.opts.createConnection,
        send: (signal) => { signals.send(signal).catch(() => {}); } });
    } catch {
      this.connect(device, true);
      return;
    }
    const dc = peer.pc.createDataChannel(LABEL, { ordered: true });
    dc.onopen = () => { if (peer === this.peer) { clearTimeout(this.fallback); this.openData(dc); } };
    peer.pc.onconnectionstatechange = () => {
      if (peer !== this.peer) return;
      if (peer.pc.connectionState === 'failed' && !this.channel) this.connect(device, true);
      else if (['failed', 'closed'].includes(peer.pc.connectionState)) this.channel?.close();
    };
    this.fallback = setTimeout(() => { if (peer === this.peer && !this.channel) this.connect(device, true); }, WEBRTC_OPEN_MS);
    peer.offer().catch(() => { if (peer === this.peer) this.connect(device, true); });
  }

  // The guest: answer the host's WebRTC offer.
  async answer(epoch: number, sdp: string) {
    const { room, signals } = this;
    if (!room || !signals || epoch < this.epoch) return;
    this.drop();
    this.epoch = epoch;
    let peer: Peer;
    try {
      peer = this.peer = new Peer({ epoch, iceServers: room.iceServers, createConnection: this.opts.createConnection,
        send: (signal) => { signals.send(signal).catch(() => {}); } });
    } catch (error) {
      this.fail(error);
      return;
    }
    peer.pc.ondatachannel = ({ channel: dc }) => {
      if (peer !== this.peer || dc.label !== LABEL) return;
      dc.onopen = () => { if (peer === this.peer) this.openData(dc); };
      if (dc.readyState === 'open') this.openData(dc);
    };
    peer.pc.onconnectionstatechange = () => {
      if (peer === this.peer && ['failed', 'closed'].includes(peer.pc.connectionState)) this.channel?.close();
    };
    try { await peer.answer(sdp); }
    catch { /* the host falls back to the relay */ }
  }

  // The guest: connect through the relay for this attempt.
  joinRelay(epoch: number) {
    const { room } = this;
    if (!room || epoch < this.epoch) return;
    this.drop();
    this.epoch = epoch;
    const link = this.relay = new RelayLink({ url: relayUrl(this.base, room.code, room.token, epoch), createSocket: this.opts.createSocket });
    this.openRelay(link);
  }

  // A relayed link, or a WebRTC data channel, that opens (or has): the connection.
  openRelay(link: RelayLink) {
    link.control.onopen = () => {
      if (link !== this.relay || this.channel || this.closed) return;
      const channel = relayChannel(link, () => this.lost(channel));
      this.opened(channel, 'relay');
    };
    // Closed before it opened (the other side never came).
    link.control.onclose = () => { if (link === this.relay && !this.channel) this.lost(null); };
  }
  openData(dc: RTCDataChannel) {
    if (this.channel || this.closed) return;
    const channel = dataChannel(dc, () => this.lost(channel));
    this.opened(channel, 'webrtc');
  }
  opened(channel: TransferChannel, transport: 'relay' | 'webrtc') {
    this.channel = channel;
    this.publish({ status: 'connected', transport, error: '' });
    this.opts.onChannel(channel, this.st.device || (this.host ? 'Another device' : 'The other device'));
  }

  // A connection (or an attempt) closed: the host waits for the guest again, the guest's link
  // has ended. One replaced already (drop) is let be.
  lost(channel: TransferChannel | null) {
    if (this.closed || channel !== this.channel) return;
    this.channel = null;
    this.dropAttempt();
    if (this.host) this.publish({ status: 'waiting', device: '', transport: '' });
    else this.fail(Error('The connection to the other device closed.'));
  }

  dropAttempt() {
    clearTimeout(this.fallback);
    const { peer, relay } = this;
    this.peer = null;
    this.relay = null;
    peer?.close();
    relay?.close();
  }
  // Ends the attempt and any open connection (the transfer over it hears it close).
  drop() {
    const was = this.channel;
    this.channel = null;
    this.dropAttempt();
    if (was) {
      was.onClose?.();
      was.close();
    }
  }

  shutdown() {
    this.closed = true;
    this.drop();
    this.signals?.leave();
    this.signals = null;
  }

  close() {
    if (this.closed) return;
    this.shutdown();
    this.publish({ status: 'ended', error: '', transport: '' });
  }
}

/** Shows a code for another device to join (the host). */
export function hostTransfer(opts: TransferLinkOptions): TransferLink {
  const link = new Link(true, opts);
  void link.start();
  return link;
}

/** Joins the transfer with this code (the guest). */
export function joinTransfer(code: string, opts: TransferLinkOptions): TransferLink {
  const link = new Link(false, opts);
  void link.start(code);
  return link;
}
