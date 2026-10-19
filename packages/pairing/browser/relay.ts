import { CONTROL_CHANNEL, LIVE_CHANNEL } from '../link.ts';
import { CONTROL_PREFIX, LIVE_PREFIX, SERVER_PREFIX } from '../relay.ts';

/*
 * A relayed link (packages/pairing/relay.ts): one WebSocket to the pairing server standing in
 * for a WebRTC connection's two data channels and its preview video. live and control behave
 * like the RTCDataChannels they replace (readyState, bufferedAmount, onopen / onmessage /
 * onclose, send, close), so the game's and the phone's ends use either the same way. They open
 * once the server says both sides are there and close with the socket.
 *
 * const link = new RelayLink({ url: relayUrl(base, code, token, epoch) });
 * link.onsocketopen = () => …;  // the game: now tell the phone to connect (a relay signal)
 * link.onframe = (jpeg) => …;    // the game: a preview picture from the phone
 * link.sendFrame(jpeg);          // the phone
 */

/** What the game's and the phone's ends use of a data channel, relayed or not. */
export interface LinkChannel {
  readonly label: string;
  readonly readyState: RTCDataChannelState;
  readonly bufferedAmount: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: Event) => void) | null;
  send(data: string): void;
  close(): void;
}

/** The part of a WebSocket the link uses; replaceable in tests. */
export interface RelaySocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  binaryType: string;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: ((event: Event) => void) | null;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
}
export type CreateRelaySocket = (url: string) => RelaySocket;
const OPEN = 1;

/** The relay socket's URL for this attempt: ws(s):// beside the pairing API at `base`. */
export function relayUrl(base: string, code: string, token: string, epoch: number) {
  const url = new URL(`${base}/rooms/${code}/link`, globalThis.location?.href ?? 'http://localhost/');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.search = `token=${encodeURIComponent(token)}&epoch=${epoch}`;
  return url.href;
}

class RelayChannel implements LinkChannel {
  readonly label: string;
  readyState: RTCDataChannelState = 'connecting';
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;
  link: RelayLink;
  prefix: string;
  constructor(link: RelayLink, label: string, prefix: string) { this.link = link; this.label = label; this.prefix = prefix; }
  get bufferedAmount() { return this.link.socket.bufferedAmount; }
  send(data: string) {
    if (this.readyState !== 'open') throw Error('InvalidStateError: the relayed channel is not open');
    this.link.socket.send(this.prefix + data);
  }
  close() { this.link.close(); }
  opened() {
    if (this.readyState !== 'connecting') return;
    this.readyState = 'open';
    this.onopen?.(new Event('open'));
  }
  closed() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.onclose?.(new Event('close'));
  }
}

export class RelayLink {
  socket: RelaySocket;
  live: RelayChannel;
  control: RelayChannel;
  /** The socket reached the server (the game then tells the phone to connect). */
  onsocketopen: (() => void) | null = null;
  /** A preview picture from the phone: JPEG bytes. */
  onframe: ((jpeg: ArrayBuffer) => void) | null = null;
  /** The other side connected again while this side's link stayed open (it had lost its socket). */
  onreopen: (() => void) | null = null;
  /** Why the server closed the socket (relay.ts's RELAY_CLOSE), once it has. */
  closeCode = 0;
  constructor({ url, createSocket = (u) => new WebSocket(u) as unknown as RelaySocket }: { url: string; createSocket?: CreateRelaySocket }) {
    this.live = new RelayChannel(this, LIVE_CHANNEL, LIVE_PREFIX);
    this.control = new RelayChannel(this, CONTROL_CHANNEL, CONTROL_PREFIX);
    const socket = this.socket = createSocket(url);
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => this.onsocketopen?.();
    socket.onmessage = ({ data }) => this.receive(data);
    socket.onclose = ({ code }) => { this.closeCode = code; this.ended(); };
    socket.onerror = () => {};
  }

  receive(data: unknown) {
    if (data instanceof ArrayBuffer) { this.onframe?.(data); return; }
    if (typeof data !== 'string') return;
    const kind = data[0], body = data.slice(1);
    if (kind === SERVER_PREFIX) {
      let event: unknown;
      try { event = JSON.parse(body); } catch { return; }
      if ((event as { type?: unknown } | null)?.type !== 'open') return;
      if (this.control.readyState === 'open') this.onreopen?.();
      else { this.control.opened(); this.live.opened(); }
    } else if (kind === LIVE_PREFIX || kind === CONTROL_PREFIX) {
      const channel = kind === LIVE_PREFIX ? this.live : this.control;
      // Only data is read, as from a data channel's message (hosts without MessageEvent included).
      if (channel.readyState === 'open') channel.onmessage?.({ data: body } as MessageEvent);
    }
  }

  /** Sends a preview picture (the phone); false when the link is closed or still busy with the last one. */
  sendFrame(jpeg: ArrayBuffer, maxBuffered = 32 * 1024) {
    if (this.control.readyState !== 'open' || this.socket.readyState !== OPEN || this.socket.bufferedAmount > maxBuffered) return false;
    this.socket.send(jpeg);
    return true;
  }

  close() {
    const { socket } = this;
    socket.onopen = socket.onmessage = socket.onclose = null;
    if (socket.readyState <= OPEN) socket.close(1000);
    this.ended();
  }

  ended() {
    this.live.closed();
    this.control.closed();
  }
}
