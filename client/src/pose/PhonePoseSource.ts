import { ClockSync } from '../../../packages/pairing/clock.ts';
import { CONTROL_CHANNEL, LIVE_CHANNEL, parsePhoneMessage } from '../../../packages/pairing/link.ts';
import type { GameMessage, PhoneStatus } from '../../../packages/pairing/link.ts';
import { Peer } from '../../../packages/pairing/browser/peer.ts';
import type { CreatePeerConnection } from '../../../packages/pairing/browser/peer.ts';
import { RelayLink, relayUrl } from '../../../packages/pairing/browser/relay.ts';
import type { CreateRelaySocket, LinkChannel } from '../../../packages/pairing/browser/relay.ts';
import { PAIRING_BASE, SignalChannel, createRoom } from '../../../packages/pairing/browser/signalChannel.ts';
import type { EventStream } from '../../../packages/pairing/browser/signalChannel.ts';
import type { CreatedRoom, PairingEvent } from '../../../packages/pairing/signals.ts';
import { isPoseModelId, poseModel } from '../../../packages/pose/browser/models.ts';
import type { PoseModelId } from '../../../packages/pose/browser/models.ts';
import type { RecordTiming } from '../../../packages/pose/browser/WebcamPoseSource.ts';
import type { PreviewFrame, PreviewPicture } from '../../../packages/pose/browser/preview.ts';
import type { WebcamRecord } from '../../../packages/pose/webcamRecord.ts';
import type { FrameSize, PlayerCount } from '../../../packages/pose/choreography.ts';
import type { PoseInputView, PoseSource, PoseSourceEvent } from './PoseSource.ts';

/*
 * A phone as the game's camera. The phone runs the tracking itself (client/src/phone/) and
 * sends the players' poses over WebRTC; this end pairs with it, keeps the two clocks lined up
 * and hands the poses on with the game's own pose sources' contract (PoseSource).
 *
 *   connect()     gets a pairing code from the pairing server (packages/pairing/server.ts):
 *                 status 'connecting' with view.pairing = { code, url } for the QR code
 *   phone hello   the phone opened the link: offer it a connection ('initializing')
 *   poses         each record's times are moved from the phone's clock to this one
 *                 (packages/pairing/clock.ts), then it's emitted like a webcam record
 *                 ('connected')
 *   lost          the connection dropped: back to 'connecting'; the phone reconnects by
 *                 itself, or any phone can pair again with the same code
 *
 * A connected phone keeps going if the pairing server goes away (a redeploy); only pairing
 * again needs it.
 *
 * Without WebRTC (the Apple TV app), or with ?transport=relay, the two talk through the pairing
 * server's relay instead (packages/pairing/relay.ts): the same messages on stand-ins for the
 * data channels, and the preview as small JPEGs. That link does need the server throughout.
 *
 * With both (transport 'auto'), WebRTC comes first and the relay is the fallback: an attempt
 * that fails or hasn't opened in WEBRTC_OPEN_MS, or an open connection that fails or stops
 * answering pings for PONG_TIMEOUT_MS (a browser can take half a minute to say it failed), is
 * followed at once by a relayed one. Once relayed, the link stays relayed during songs. After
 * each song, a phone that can take one gets a probe: a WebRTC connection made alongside the
 * relayed link, which takes over once it has answered PROBE_PONGS pings (the game closes the
 * relayed link, and the phone moves to the probe as it sees it close). A probe that doesn't
 * get there in PROBE_MS, or a song starting, ends it, and the relay carries on as if nothing
 * happened; after MAX_PROBE_FAILURES in a row, that phone stays relayed.
 * An app that bundles the game sets globalThis.__aerodanceSite to the deployed site's origin,
 * where it pairs and where the QR code sends the phone.
 *
 * setPreview(true) while a setup preview is on screen: the phone sends a small copy of its
 * camera, and video is that picture (null without one, so previews draw the skeletons alone).
 * The skeletons come with each pose, so they can run ahead of the picture under them.
 *
 * The phone tracks with the model and player count set here (configure, setPlayerCount)
 * or on the phone itself; the view follows what the phone reports.
 */

export interface PhonePairing { code: string; url: string; }
export interface PhoneStats { poseHz: number; inferenceMs: number | null; clockUncertaintyMs: number; }
export interface PhoneView extends PoseInputView {
  sourceKind: 'phone';
  model: PoseModelId;
  snapshot: WebcamRecord | null;
  /** The code and link a phone pairs with, while connected or trying to be. */
  pairing: PhonePairing | null;
  /** What the phone calls itself, once one has said hello. */
  device: string;
  /** The frame size the phone tracks in (the preview's shape). */
  frame: FrameSize | null;
  stats: PhoneStats | null;
  timing: RecordTiming;
}
export interface PhonePoseSourceOptions {
  base?: string;
  fetch?: typeof fetch;
  createStream?: (url: string) => EventStream;
  createConnection?: CreatePeerConnection;
  now?: () => number;
  /** The site the phone opens (the QR code's link). */
  origin?: () => string;
  createVideo?: () => HTMLVideoElement;
  /** WebRTC, or the pairing server's relay; 'auto' relays where there's no RTCPeerConnection. */
  transport?: Transport;
  createSocket?: CreateRelaySocket;
  /** Decodes a relayed preview picture (JPEG bytes). */
  decodeFrame?: (jpeg: ArrayBuffer) => Promise<PreviewFrame>;
}
export type Transport = 'auto' | 'webrtc' | 'relay';
/** A WebRTC connection made beside a relayed link, to take over from it (see the top). */
interface Probe {
  peer: Peer;
  live: LinkChannel;
  control: LinkChannel;
  startedAt: number;
  pongs: number;
  /** The phone's video track, shown once the probe takes over. */
  track: MediaStreamTrack | null;
  pingTimer: ReturnType<typeof setInterval> | undefined;
}
type Listener<T> = (value: T) => void;

// An app that bundles the game (the Apple TV app) names the deployed site it pairs through.
const site = () => ((globalThis as { __aerodanceSite?: string }).__aerodanceSite ?? '').replace(/\/+$/, '');
const askedTransport = (): Transport => {
  const asked = new URLSearchParams(globalThis.location?.search ?? '').get('transport');
  return asked === 'relay' || asked === 'webrtc' ? asked : 'auto';
};
async function decodeJpeg(jpeg: ArrayBuffer): Promise<PreviewFrame> {
  const bitmap = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
  return { image: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
}
// Poses older than this when they arrive (or that never line up with our clock) are dropped,
// like the webcam's slow results.
const STALE_MS = 500;
const PING_MS = 500;
// A connected phone that sends no poses this long goes back to 'initializing'.
const QUIET_MS = 3000;
// A connection attempt that hasn't opened in this long is given up (the phone may have gone).
const ATTEMPT_MS = 20_000;
// A relay socket of this end's that hasn't connected in this long doesn't hold off a new attempt.
const RELAY_CONNECT_MS = 4000;
// Falling back to the relay: a WebRTC attempt that hasn't opened in this long, or an open
// connection that answers no pings for this long.
const WEBRTC_OPEN_MS = 8000;
const PONG_TIMEOUT_MS = 3000;
// Probing WebRTC from a relayed link between songs: pongs before it takes over, how long it
// may take to get there, and failed probes in a row before that phone isn't probed again.
const PROBE_PONGS = 6;
const PROBE_MS = 10_000;
const MAX_PROBE_FAILURES = 3;
// The phone's picture counts as showing while a frame arrived this recently.
const VIDEO_FRESH_MS = 1000;
const MODEL_KEY = 'aerodance-phone-model';
const saved = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const save = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* Private browsing. */ } };
const reason = (error: unknown) => (error instanceof Error && error.message) || 'Phone pairing failed. Try again.';

export class PhonePoseSource implements PoseSource {
  base: string;
  fetch: typeof fetch | undefined;
  createStream: ((url: string) => EventStream) | undefined;
  createConnection: CreatePeerConnection | undefined;
  now: () => number;
  origin: () => string;
  listeners = new Set<Listener<PhoneView>>();
  recordListeners = new Set<Listener<PoseSourceEvent>>();
  view: PhoneView;
  createVideo: () => HTMLVideoElement;
  /** Connecting through the pairing server's relay rather than WebRTC. */
  relayed: boolean;
  /** ...from the start (no WebRTC here, or ?transport=relay). */
  startRelayed: boolean;
  /** Both are here (transport 'auto'): WebRTC that fails falls back to the relay, and the relay probes for WebRTC between songs. */
  fallback: boolean;
  /** The phone takes probes (its hello says so); probes that failed in a row; a song ended since the last probe. */
  phoneProbes = false;
  probeFailures = 0;
  probeDue = false;
  probe: Probe | null = null;
  createSocket: CreateRelaySocket | undefined;
  decodeFrame: (jpeg: ArrayBuffer) => Promise<PreviewFrame>;
  /** The phone's picture, while it sends one, and when its last frame arrived. */
  remoteVideo: HTMLVideoElement | null = null;
  /** ...or, relayed, its latest still picture (and whether the next is still decoding). */
  remoteFrame: PreviewFrame | null = null;
  decoding = false;
  videoAt = -Infinity;
  preview = false;
  playerCount: PlayerCount = 1;
  playing = false;
  generation = 0;
  room: CreatedRoom | null = null;
  channel: SignalChannel | null = null;
  peer: Peer | null = null;
  link: RelayLink | null = null;
  epoch = 0;
  /** The relayed link's attempt (a probe since has a later one). */
  relayEpoch = 0;
  live: LinkChannel | null = null;
  control: LinkChannel | null = null;
  clock = new ClockSync();
  phone: PhoneStatus | null = null;
  pings = 0;
  pingTimer: ReturnType<typeof setInterval> | undefined;
  watchdog: ReturnType<typeof setInterval> | undefined;
  lastSession = '';
  lastSeq = -1;
  lastPose = -Infinity;
  lastPong = -Infinity;
  checkedAt = -Infinity;
  arrivals: number[] = [];
  offeredAt = -Infinity;
  constructor({ base = site() ? `${site()}/pair` : PAIRING_BASE, fetch: fetchFn, createStream, createConnection, now = () => performance.now(),
    origin = () => site() || location.origin, createVideo = () => document.createElement('video'), transport = askedTransport(), createSocket,
    decodeFrame = decodeJpeg }: PhonePoseSourceOptions = {}) {
    this.base = base; this.fetch = fetchFn; this.createStream = createStream; this.createConnection = createConnection;
    this.now = now; this.origin = origin; this.createVideo = createVideo; this.createSocket = createSocket; this.decodeFrame = decodeFrame;
    const webrtc = !!createConnection || typeof RTCPeerConnection !== 'undefined';
    this.relayed = this.startRelayed = transport === 'relay' || (transport === 'auto' && !webrtc);
    this.fallback = transport === 'auto' && webrtc;
    const model = saved(MODEL_KEY);
    this.view = { status: 'disconnected', sourceKind: 'phone', message: 'Pair your phone to use it as the camera.', snapshot: null,
      configuring: false, model: isPoseModelId(model) ? model : 'lite', pairing: null, device: '', frame: null, stats: null,
      timing: { method: 'remote-clock-sync', uncertaintyMs: null } };
  }

  subscribe(listener: Listener<PhoneView>) { this.listeners.add(listener); listener(this.view); return () => { this.listeners.delete(listener); }; }
  subscribeRecords(listener: Listener<PoseSourceEvent>) { this.recordListeners.add(listener); return () => { this.recordListeners.delete(listener); }; }
  publish(patch: Partial<PhoneView>) { this.view = { ...this.view, ...patch }; for (const listener of this.listeners) listener(this.view); }
  emit(event: PoseSourceEvent) { for (const listener of this.recordListeners) listener(event); }

  /** The phone's camera picture for a setup preview, while one is coming in. */
  get video(): PreviewPicture | null { return this.preview && this.now() - this.videoAt < VIDEO_FRESH_MS ? this.remoteFrame ?? this.remoteVideo : null; }

  /** Starts pairing: a new code for a phone to scan. */
  async connect() {
    this.disconnect();
    this.forgetPhone();
    const generation = this.generation;
    const current = () => generation === this.generation;
    this.publish({ status: 'connecting', message: 'Getting a pairing code…' });
    let room: CreatedRoom;
    try {
      room = await createRoom(this.base, this.fetch);
    } catch (error) {
      if (current()) this.fail(error);
      return;
    }
    const channel = new SignalChannel({ code: room.code, token: room.token, base: this.base, fetch: this.fetch, createStream: this.createStream,
      onEvent: (event) => { if (current()) this.onSignal(event); } });
    // Stopped while the code was on its way: give it back.
    if (!current()) { channel.leave(); return; }
    this.room = room;
    this.channel = channel;
    channel.open();
    // The code on screen says what to do.
    this.publish({ status: 'connecting', pairing: { code: room.code, url: `${this.origin()}/pair/#${room.code}` }, message: '' });
    this.watchdog = setInterval(() => this.check(), 250);
  }

  disconnect(message = 'Phone disconnected. Pair it again to resume.') {
    this.generation++;
    clearInterval(this.watchdog);
    this.closePeer();
    this.channel?.leave();
    this.channel = null;
    this.room = null;
    this.emit({ event: { type: 'source-stopped', reason: message }, receivedBrowserTimeMs: this.now() });
    this.publish({ status: 'disconnected', snapshot: null, pairing: null, device: '', frame: null, stats: null, message, timing: { method: 'remote-clock-sync', uncertaintyMs: null } });
  }

  /** A new phone may be on another network: WebRTC first again, and probed again. */
  forgetPhone() {
    this.relayed = this.startRelayed;
    this.phoneProbes = false;
    this.probeFailures = 0;
    this.probeDue = false;
  }

  fail(error: unknown) {
    const message = reason(error);
    this.disconnect(message);
    this.publish({ status: 'error', message });
  }

  /** The tracking model: the phone switches to it. */
  async configure({ modelId = this.view.model }: { modelId?: string } = {}) {
    const model = poseModel(modelId).id;
    save(MODEL_KEY, model);
    this.publish({ model });
    this.sendConfig();
  }

  async setPlayerCount(count: PlayerCount) {
    if (count === this.playerCount) return;
    this.playerCount = count;
    this.publish({ snapshot: null });
    this.sendConfig();
  }

  /** Whether a setup preview is on screen: the phone sends its picture only then. */
  setPreview(on: boolean) {
    if (on === this.preview) return;
    this.preview = on;
    this.send({ type: 'preview', on });
  }

  /** Whether a song is on; the phone dims its screen while one plays. */
  setPlaying(playing: boolean) {
    if (playing === this.playing) return;
    this.playing = playing;
    // A relayed link probes for WebRTC between songs, never during one.
    this.probeDue = !playing && !!this.link;
    if (playing) this.endProbe(false);
    this.send({ type: 'game', playing });
  }

  onSignal(event: PairingEvent) {
    const { peer } = this;
    if (event.type === 'peer' && event.left) this.forgetPhone();
    if (event.type === 'hello') { this.phoneProbes = !!event.probes; this.hello(event.device || 'Phone'); }
    else if (event.type === 'answer' && peer?.epoch === event.epoch) peer.accept(event.sdp).catch(() => { if (peer === this.peer) this.lost(); });
    else if (event.type === 'ice' && peer?.epoch === event.epoch) void peer.addIce(event.candidate);
    else if ((event.type === 'answer' || event.type === 'ice') && this.probe?.peer.epoch === event.epoch) {
      const probe = this.probe;
      if (event.type === 'ice') void probe.peer.addIce(event.candidate);
      else probe.peer.accept(event.sdp).catch(() => { if (this.probe === probe) this.endProbe(true); });
    }
    // The phone left before the connection opened: show the code again.
    else if (event.type === 'peer' && event.left && (peer || this.link) && this.control?.readyState !== 'open') this.lost();
    else if (event.type === 'closed') {
      // The room is gone, but a connected phone carries on without it.
      if (this.control?.readyState === 'open') {
        this.channel = null;
        this.publish({ pairing: null });
      } else this.fail(Error(event.reason));
    }
  }

  /**
   * A phone said hello. Relayed, a hello while the link is open (or its attempt still young)
   * gets this attempt again rather than a new one that would replace it: a phone that still
   * holds the link ignores it (the hello crossed the link on the way), and one that lost its
   * socket without the server noticing (a network change) connects to it again, which the
   * server lets replace the stale socket. Otherwise: a new connection.
   */
  hello(device: string) {
    const { link, channel } = this;
    if (link && channel && (this.control?.readyState === 'open' || this.now() - this.offeredAt < ATTEMPT_MS)) {
      if (link.socket.readyState === 1) { channel.send({ type: 'relay', epoch: this.relayEpoch }).catch(() => {}); return; }
      // This end's socket is still connecting (it tells the phone once it's there), unless it's stuck.
      if (this.now() - this.offeredAt < RELAY_CONNECT_MS) return;
    }
    this.offer(device);
  }

  /** A fresh connection for the phone, replacing any earlier one. */
  offer(device: string) {
    const { room, channel } = this;
    if (!room || !channel) return;
    this.closePeer();
    const epoch = ++this.epoch;
    let live: LinkChannel, control: LinkChannel, peer: Peer | null = null;
    if (this.relayed) {
      this.relayEpoch = epoch;
      // The link opens once the phone has connected too; it's told to once this end's socket is there.
      const link = this.link = new RelayLink({ url: relayUrl(this.base, room.code, room.token, epoch), createSocket: this.createSocket });
      link.onsocketopen = () => { if (link === this.link) channel.send({ type: 'relay', epoch }).catch(() => {}); };
      link.onframe = (jpeg) => { if (link === this.link) this.showFrame(jpeg); };
      // The phone connected to this attempt again (a new socket, maybe a reloaded page): it needs
      // the game's settings again, and its clock may have started over.
      link.onreopen = () => {
        if (link !== this.link) return;
        this.clock.reset();
        this.sendConfig();
        this.send({ type: 'game', playing: this.playing });
        this.send({ type: 'preview', on: this.preview });
      };
      ({ live, control } = link);
    } else {
      try {
        peer = this.peer = new Peer({ epoch, iceServers: room.iceServers, createConnection: this.createConnection,
          send: (signal) => { channel.send(signal).catch(() => {}); } });
      } catch (error) {
        // An ICE server entry the browser won't take (PAIRING_ICE_SERVERS).
        this.fail(Error(`Couldn't start a connection to the phone: ${reason(error)}`));
        return;
      }
      ({ live, control } = this.openChannels(peer));
      const { pc } = peer;
      pc.ontrack = ({ track }) => { if (mine() && track.kind === 'video') this.showVideo(track); };
      pc.onconnectionstatechange = () => {
        if (mine() && ['failed', 'closed'].includes(pc.connectionState)) this.dropped(device);
      };
    }
    this.live = live; this.control = control;
    const attempt = this.link ?? this.peer;
    const mine = () => (this.link ?? this.peer) === attempt;
    live.onmessage = control.onmessage = ({ data }) => { if (mine()) this.onMessage(data); };
    let opened = false;
    control.onopen = () => {
      if (!mine()) return;
      opened = true;
      this.lastPong = this.now();
      this.sendConfig();
      this.send({ type: 'game', playing: this.playing });
      this.send({ type: 'preview', on: this.preview });
      this.pingTimer = setInterval(() => this.send({ type: 'ping', id: ++this.pings, t0: this.now() }), PING_MS);
      this.publish({ status: 'initializing', message: `${device} connected. Starting its camera…` });
    };
    control.onclose = () => {
      if (!mine()) return;
      if (!this.link) { this.dropped(device); return; }
      // A probe that has opened takes over from the relayed link it was made beside (the phone's
      // end does the same), whether or not it had proved itself yet.
      if (this.probe?.control.readyState === 'open') { this.promote(); return; }
      const reattempt = opened;
      this.lost();
      // Relayed, a link that was open and dropped on this end alone (the phone may not know yet)
      // gets a new attempt at once: the server takes it as replacing the old link on both ends.
      if (reattempt && this.channel) this.offer(device);
    };
    this.offeredAt = this.now();
    this.publish({ status: 'initializing', device, snapshot: null, message: `Connecting to ${device}…` });
    peer?.offer().catch(() => { if (mine()) this.lost(); });
  }

  /** A WebRTC connection's data channels, and its video for the phone's preview picture. */
  openChannels(peer: Peer) {
    const { pc } = peer;
    const live = pc.createDataChannel(LIVE_CHANNEL, { ordered: false, maxRetransmits: 0 });
    // The phone's preview picture: offered from the start, so turning it on needs no renegotiation.
    pc.addTransceiver?.('video', { direction: 'recvonly' });
    const control = pc.createDataChannel(CONTROL_CHANNEL);
    return { live, control };
  }

  /** A WebRTC attempt failed, never opened or stopped answering: the relay next, where there's one to fall back to. */
  dropped(device: string) {
    if (!this.fallback || !this.channel) { this.lost(); return; }
    this.relayed = true;
    this.offer(device);
  }

  /** Between songs, a relayed link tries WebRTC beside it (see the top). */
  startProbe() {
    const { room, channel } = this;
    this.probeDue = false;
    if (!room || !channel) return;
    const epoch = ++this.epoch;
    let peer: Peer;
    try {
      peer = new Peer({ epoch, iceServers: room.iceServers, createConnection: this.createConnection, probe: true,
        send: (signal) => { channel.send(signal).catch(() => {}); } });
    } catch { this.probeFailures = MAX_PROBE_FAILURES; return; }
    const { live, control } = this.openChannels(peer);
    const probe: Probe = this.probe = { peer, live, control, startedAt: this.now(), pongs: 0, track: null, pingTimer: undefined };
    const { pc } = peer;
    // The phone's video track arrives with its answer, and shows once the probe has taken over.
    pc.ontrack = ({ track }) => {
      if (track.kind !== 'video') return;
      if (this.probe === probe) probe.track = track;
      else if (this.peer === peer) this.showVideo(track);
    };
    pc.onconnectionstatechange = () => {
      if (this.probe === probe && ['failed', 'closed'].includes(pc.connectionState)) this.endProbe(true);
    };
    // Until it takes over, the probe only carries pings.
    control.onopen = () => {
      if (this.probe !== probe) return;
      probe.pingTimer = setInterval(() => {
        if (live.readyState === 'open') live.send(JSON.stringify({ type: 'ping', id: ++this.pings, t0: this.now() } satisfies GameMessage));
      }, PING_MS);
    };
    live.onmessage = ({ data }) => {
      const message = parsePhoneMessage(data);
      if (this.probe !== probe || message?.type !== 'pong') return;
      this.clock.add(message.t0, message.t1, this.now());
      if (++probe.pongs >= PROBE_PONGS && !this.playing) this.promote();
    };
    control.onclose = () => { if (this.probe === probe) this.endProbe(true); };
    peer.offer().catch(() => { if (this.probe === probe) this.endProbe(true); });
  }

  /** Ends the probe, if there is one (failed: it counts towards giving up on probing this phone). */
  endProbe(failed: boolean) {
    const probe = this.probe;
    if (!probe) return;
    this.probe = null;
    if (failed) this.probeFailures++;
    clearInterval(probe.pingTimer);
    for (const channel of [probe.live, probe.control]) { channel.onmessage = channel.onopen = channel.onclose = null; channel.close(); }
    probe.peer.close();
  }

  /** The probe has proved itself (or the relayed link went while it was open): it becomes the link. */
  promote() {
    const probe = this.probe;
    if (!probe) return;
    this.probe = null;
    clearInterval(probe.pingTimer);
    // Closing the relayed link tells the phone to move over.
    for (const channel of [this.live, this.control]) if (channel) channel.onmessage = channel.onopen = channel.onclose = null;
    this.link?.close();
    this.link = null;
    this.remoteFrame?.close?.();
    this.remoteFrame = null;
    this.videoAt = -Infinity;
    this.relayed = false;
    this.probeFailures = 0;
    const { peer, live, control } = probe;
    this.peer = peer; this.live = live; this.control = control;
    const device = this.view.device || 'Phone';
    const mine = () => this.peer === peer;
    live.onmessage = control.onmessage = ({ data }) => { if (mine()) this.onMessage(data); };
    control.onclose = () => { if (mine()) this.dropped(device); };
    peer.pc.onconnectionstatechange = () => {
      if (mine() && ['failed', 'closed'].includes(peer.pc.connectionState)) this.dropped(device);
    };
    if (probe.track) this.showVideo(probe.track);
    this.lastPong = this.now();
    this.sendConfig();
    this.send({ type: 'game', playing: this.playing });
    this.send({ type: 'preview', on: this.preview });
  }

  /** The connection dropped: wait for the phone to come back (or another to pair). */
  lost() {
    this.closePeer();
    if (!this.channel) { this.fail(Error('Lost the phone. Pair it again.')); return; }
    // Its place is free, in case it never comes back (a new tab can't rejoin as it).
    this.channel.release();
    this.publish({ status: 'connecting', snapshot: null, stats: null, frame: null,
      message: 'Lost the phone. Keep aerodance open on it to reconnect, or scan the code again.' });
  }

  closePeer() {
    this.endProbe(false);
    clearInterval(this.pingTimer);
    for (const channel of [this.live, this.control]) {
      if (!channel) continue;
      channel.onmessage = channel.onopen = channel.onclose = null;
      channel.close();
    }
    this.live = this.control = null;
    this.peer?.close();
    this.peer = null;
    this.link?.close();
    this.link = null;
    this.remoteFrame?.close?.();
    this.remoteFrame = null;
    if (this.remoteVideo) { this.remoteVideo.srcObject = null; this.remoteVideo.remove?.(); }
    this.remoteVideo = null;
    this.videoAt = -Infinity;
    this.clock.reset();
    this.phone = null;
    this.arrivals = [];
    this.lastPose = -Infinity;
  }

  /** Plays the phone's video track, noting each frame as it arrives. */
  showVideo(track: MediaStreamTrack) {
    const video = this.remoteVideo ?? this.createVideo();
    this.remoteVideo = video;
    video.muted = true; video.playsInline = true; video.srcObject = new MediaStream([track]);
    if (video.style && !video.isConnected) {
      // Safari only decodes a video that's in the page.
      Object.assign(video.style, { position: 'fixed', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none' });
      video.setAttribute('aria-hidden', 'true'); document.body.append(video);
    }
    void video.play().catch(() => {});
    const frame = () => {
      if (this.remoteVideo !== video) return;
      this.videoAt = this.now();
      video.requestVideoFrameCallback(frame);
    };
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(frame);
    else video.ontimeupdate = () => { if (this.remoteVideo === video) this.videoAt = this.now(); };
  }

  /** A relayed preview picture: decoded and shown (one at a time; any that come meanwhile are skipped). */
  showFrame(jpeg: ArrayBuffer) {
    if (this.decoding || !this.preview) return;
    this.decoding = true;
    const link = this.link;
    this.decodeFrame(jpeg).then((frame) => {
      this.decoding = false;
      if (link !== this.link || !link) { frame.close?.(); return; }
      this.remoteFrame?.close?.();
      this.remoteFrame = frame;
      this.videoAt = this.now();
    }, () => { this.decoding = false; });
  }

  send(message: GameMessage) {
    const channel = message.type === 'ping' ? this.live : this.control;
    if (channel?.readyState === 'open') channel.send(JSON.stringify(message));
  }
  sendConfig() { this.send({ type: 'config', playerCount: this.playerCount, modelId: this.view.model }); }

  onMessage(data: unknown) {
    const message = parsePhoneMessage(data);
    if (!message) return;
    if (message.type === 'pong') { this.lastPong = this.now(); this.clock.add(message.t0, message.t1, this.now()); }
    else if (message.type === 'status') {
      this.phone = message;
      // The phone's own choice of model sticks here too.
      if (message.model !== this.view.model) save(MODEL_KEY, message.model);
      this.publish({ model: message.model, message: this.describe() });
    } else this.onPose(message.record);
  }

  onPose(record: WebcamRecord) {
    const now = this.now();
    // Unordered channel: anything older than the newest record so far is out of date.
    if (!this.clock.ready || record.playerCount !== this.playerCount ||
        (record.sessionId === this.lastSession && record.seq <= this.lastSeq)) return;
    const frame = Math.min(now, this.clock.toLocal(record.frameBrowserTimeMs));
    if (now - frame >= STALE_MS) return;
    this.lastSession = record.sessionId;
    this.lastSeq = record.seq;
    const local: WebcamRecord = { ...record, frameBrowserTimeMs: frame, timingMethod: 'remote-clock-sync',
      resultBrowserTimeMs: Math.min(now, Math.max(frame, this.clock.toLocal(record.resultBrowserTimeMs))) };
    const timing = { method: 'remote-clock-sync', uncertaintyMs: Math.round(this.clock.uncertaintyMs * 10) / 10 };
    this.emit({ record: local, receivedBrowserTimeMs: now, captureBrowserTimeMs: frame, timing });
    this.lastPose = now;
    this.arrivals.push(now);
    this.arrivals = this.arrivals.filter((t) => now - t <= 2000);
    const poseHz = this.arrivals.length > 1 ? (this.arrivals.length - 1) * 1000 / Math.max(1, now - this.arrivals[0]) : 0;
    this.publish({ status: 'connected', snapshot: local, frame: { width: record.input.width, height: record.input.height }, timing,
      stats: { poseHz, inferenceMs: this.phone?.inferenceMs ?? null, clockUncertaintyMs: timing.uncertaintyMs }, message: this.describe() });
  }

  /** What to tell the player: the phone's own tracker message, after its name. */
  describe() {
    const phone = this.phone;
    if (!phone) return this.view.message;
    return `${this.view.device || 'Phone'}: ${phone.message}`;
  }

  check() {
    const now = this.now();
    if (this.view.snapshot && now - this.view.snapshot.frameBrowserTimeMs >= STALE_MS) this.publish({ snapshot: null });
    if (this.view.status === 'connected' && now - this.lastPose > QUIET_MS) this.publish({ status: 'initializing', stats: null, message: this.describe() });
    const device = this.view.device || 'Phone';
    // A check that comes late (this page was busy) can't tell a quiet connection from pongs still waiting to be read.
    const late = now - this.checkedAt > 1000;
    this.checkedAt = now;
    if (this.peer && this.control?.readyState === 'open' && !late && now - this.lastPong > PONG_TIMEOUT_MS) this.dropped(device);
    else if (this.peer && this.fallback && this.control?.readyState !== 'open' && now - this.offeredAt > WEBRTC_OPEN_MS) this.dropped(device);
    else if ((this.peer || this.link) && this.control?.readyState !== 'open' && now - this.offeredAt > ATTEMPT_MS) this.lost();
    if (this.probe && now - this.probe.startedAt > PROBE_MS) this.endProbe(true);
    if (this.probeDue && !this.probe && !this.playing && this.fallback && this.phoneProbes && this.probeFailures < MAX_PROBE_FAILURES &&
        this.link && this.control?.readyState === 'open') this.startProbe();
  }
}
