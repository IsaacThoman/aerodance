// Stand-ins for the browser APIs phone pairing uses, so the game's and the phone's ends can
// talk in Node: a loopback RTCPeerConnection, an EventSource over fetch, and a pairing
// server on a free port (with its relay's WebSockets, which Node's own WebSocket can open).
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import type { TestContext } from 'node:test';
import { createPairingServer } from '../../../../packages/pairing/server.ts';
import type { EventStream } from '../../../../packages/pairing/browser/signalChannel.ts';
import type { RelaySocket } from '../../../../packages/pairing/browser/relay.ts';

/** The pairing server mounted at /pair on a free port; returns its base URL (and the server as `pairingServer.last`). */
export async function pairingServer(t: TestContext) {
  const pairing = createPairingServer();
  const server = http.createServer((req, res) => {
    req.url = (req.url || '/').replace(/^\/pair/, '') || '/';
    void pairing.handle(req, res).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } });
  });
  server.on('upgrade', (req, socket, head) => {
    req.url = (req.url || '/').replace(/^\/pair/, '') || '/';
    if (!pairing.upgrade(req, socket, head)) socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    pairing.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  pairingServer.last = pairing;
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/pair`;
}
pairingServer.last = null as ReturnType<typeof createPairingServer> | null;

/** An EventSource over fetch (Node has none): it closes for good when the stream ends. */
export function fetchEventStream(url: string): EventStream {
  const controller = new AbortController();
  const stream: EventStream = { readyState: 0, onmessage: null, onerror: null, close: () => { stream.readyState = 2; controller.abort(); } };
  void (async () => {
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok || !res.body) throw Error(`events ${res.status}`);
      stream.readyState = 1;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let i;
        while ((i = buffer.indexOf('\n\n')) >= 0) {
          const data = buffer.slice(0, i).split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
          buffer = buffer.slice(i + 2);
          if (data && stream.readyState !== 2) stream.onmessage?.(new MessageEvent('message', { data }));
        }
      }
    } catch { /* Closed or refused. */ }
    if (stream.readyState === 2 && controller.signal.aborted) return;
    stream.readyState = 2;
    stream.onerror?.(new Event('error'));
  })();
  return stream;
}

type Handler<E> = ((event: E) => void) | null;

class FakeChannel {
  label: string;
  readyState: RTCDataChannelState = 'connecting';
  bufferedAmount = 0;
  onopen: Handler<Event> = null;
  onmessage: Handler<MessageEvent> = null;
  onclose: Handler<Event> = null;
  other: FakeChannel | null = null;
  sent: unknown[] = [];
  constructor(label: string) { this.label = label; }
  send(data: string) {
    if (this.readyState !== 'open') throw Error('InvalidStateError');
    this.sent.push(data);
    const other = this.other;
    setTimeout(() => { if (other?.readyState === 'open') other.onmessage?.(new MessageEvent('message', { data })); }, 1);
  }
  open() { this.readyState = 'open'; this.onopen?.(new Event('open')); }
  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    const other = this.other;
    this.other = null;
    this.onclose?.(new Event('close'));
    other?.close();
  }
}

const offers = new Map<string, FakeConnection>();
let ids = 0;

/** A loopback RTCPeerConnection: the offer names the offering connection, and the answer joins their data channels. */
export class FakeConnection {
  id = ++ids;
  channels: FakeChannel[] = [];
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  signalingState: RTCSignalingState = 'stable';
  connectionState: RTCPeerConnectionState = 'new';
  onicecandidate: Handler<{ candidate: { toJSON(): RTCIceCandidateInit } | null }> = null;
  ondatachannel: Handler<{ channel: FakeChannel }> = null;
  onconnectionstatechange: Handler<Event> = null;
  remote: FakeConnection | null = null;
  candidates: RTCIceCandidateInit[] = [];
  static all: FakeConnection[] = [];
  constructor() { FakeConnection.all.push(this); }
  createDataChannel(label: string) { const channel = new FakeChannel(label); this.channels.push(channel); return channel; }
  async createOffer() { return { type: 'offer' as const, sdp: `fake-offer ${this.id}` }; }
  async createAnswer() { return { type: 'answer' as const, sdp: `fake-answer ${this.id}` }; }
  async setLocalDescription(description: RTCSessionDescriptionInit) {
    this.localDescription = description;
    if (description.type === 'offer') { offers.set(description.sdp ?? '', this); this.signalingState = 'have-local-offer'; }
    setTimeout(() => this.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: `candidate ${this.id}`, sdpMid: '0', sdpMLineIndex: 0 }) } }), 1);
  }
  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remoteDescription = description;
    if (description.type === 'offer') { this.remote = offers.get(description.sdp ?? '') ?? null; return; }
    // The answer: join the offerer's channels to new ones on the answering side, then open them.
    this.signalingState = 'stable';
    const answerer = FakeConnection.all.find((c) => c.localDescription?.sdp === description.sdp);
    if (!answerer) return;
    this.remote = answerer;
    for (const channel of this.channels) {
      const theirs = new FakeChannel(channel.label);
      channel.other = theirs; theirs.other = channel;
      answerer.channels.push(theirs);
      answerer.ondatachannel?.({ channel: theirs });
    }
    setTimeout(() => {
      for (const c of [this, answerer]) c.state('connected');
      for (const channel of this.channels) { channel.other?.open(); channel.open(); }
    }, 1);
  }
  async addIceCandidate(candidate: RTCIceCandidateInit) { this.candidates.push(candidate); }
  state(state: RTCPeerConnectionState) {
    if (this.connectionState === 'closed') return;
    this.connectionState = state;
    this.onconnectionstatechange?.(new Event('connectionstatechange'));
  }
  /** The network went: both ends see the connection fail. */
  fail() {
    for (const c of [this, this.remote]) {
      if (!c) continue;
      c.state('failed');
    }
  }
  close() {
    this.connectionState = 'closed';
    for (const channel of this.channels) channel.close();
  }
}
export const createFakeConnection = () => new FakeConnection() as unknown as RTCPeerConnection;

/** Polls until check() is truthy. */
export async function until<T>(check: () => T, what: string, timeoutMs = 5000): Promise<NonNullable<T>> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * A TCP proxy in front of the pairing server for relay sockets: cut() drops a connection's near
 * end and leaves the server's open and silent (a network change the server doesn't hear about),
 * and while hang is on, new connections go nowhere.
 */
export async function relayProxy(t: TestContext, base: string) {
  const serverPort = Number(new URL(base).port);
  const pairs: { client: net.Socket; upstream: net.Socket | null }[] = [];
  const state = { hang: false };
  const proxy = net.createServer((client) => {
    client.on('error', () => {});
    if (state.hang) { pairs.push({ client, upstream: null }); return; }
    const upstream = net.connect(serverPort, '127.0.0.1');
    upstream.on('error', () => {});
    client.pipe(upstream); upstream.pipe(client);
    pairs.push({ client, upstream });
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const port = (proxy.address() as AddressInfo).port;
  t.after(() => { for (const p of pairs) { p.client.destroy(); p.upstream?.destroy(); } proxy.close(); });
  return {
    state,
    /** Relay sockets through the proxy. */
    createSocket: (url: string) => new WebSocket(url.replace(`:${serverPort}/`, `:${port}/`)) as unknown as RelaySocket,
    /** Cuts the newest connection on this side; returns a function that closes the server's end too. */
    cut() {
      const pair = pairs.at(-1);
      if (!pair?.upstream) throw Error('no connection to cut');
      const { client, upstream } = pair;
      client.unpipe(upstream); upstream.unpipe(client); upstream.pause();
      client.destroy();
      return () => upstream.destroy();
    },
  };
}
