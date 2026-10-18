import { ClockSync } from '../../../packages/pairing/clock.ts';
import { CONTROL_CHANNEL, LIVE_CHANNEL, parsePhoneMessage } from '../../../packages/pairing/link.ts';
import type { GameMessage, PhoneStatus } from '../../../packages/pairing/link.ts';
import { Peer } from '../../../packages/pairing/browser/peer.ts';
import type { CreatePeerConnection } from '../../../packages/pairing/browser/peer.ts';
import { PAIRING_BASE, SignalChannel, createRoom } from '../../../packages/pairing/browser/signalChannel.ts';
import type { EventStream } from '../../../packages/pairing/browser/signalChannel.ts';
import type { CreatedRoom, PairingEvent } from '../../../packages/pairing/signals.ts';
import { isPoseModelId, poseModel } from '../../../packages/pose/browser/models.ts';
import type { PoseModelId } from '../../../packages/pose/browser/models.ts';
import type { RecordTiming } from '../../../packages/pose/browser/WebcamPoseSource.ts';
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
}
type Listener<T> = (value: T) => void;

// Poses older than this when they arrive (or that never line up with our clock) are dropped,
// like the webcam's slow results.
const STALE_MS = 500;
const PING_MS = 500;
// A connected phone that sends no poses this long goes back to 'initializing'.
const QUIET_MS = 3000;
// A connection attempt that hasn't opened in this long is given up (the phone may have gone).
const ATTEMPT_MS = 20_000;
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
  readonly video = null;
  playerCount: PlayerCount = 1;
  playing = false;
  generation = 0;
  room: CreatedRoom | null = null;
  channel: SignalChannel | null = null;
  peer: Peer | null = null;
  epoch = 0;
  live: RTCDataChannel | null = null;
  control: RTCDataChannel | null = null;
  clock = new ClockSync();
  phone: PhoneStatus | null = null;
  pings = 0;
  pingTimer: ReturnType<typeof setInterval> | undefined;
  watchdog: ReturnType<typeof setInterval> | undefined;
  lastSession = '';
  lastSeq = -1;
  lastPose = -Infinity;
  arrivals: number[] = [];
  offeredAt = -Infinity;
  constructor({ base = PAIRING_BASE, fetch: fetchFn, createStream, createConnection, now = () => performance.now(),
    origin = () => location.origin }: PhonePoseSourceOptions = {}) {
    this.base = base; this.fetch = fetchFn; this.createStream = createStream; this.createConnection = createConnection;
    this.now = now; this.origin = origin;
    const model = saved(MODEL_KEY);
    this.view = { status: 'disconnected', sourceKind: 'phone', message: 'Pair your phone to use it as the camera.', snapshot: null,
      configuring: false, model: isPoseModelId(model) ? model : 'lite', pairing: null, device: '', frame: null, stats: null,
      timing: { method: 'remote-clock-sync', uncertaintyMs: null } };
  }

  subscribe(listener: Listener<PhoneView>) { this.listeners.add(listener); listener(this.view); return () => { this.listeners.delete(listener); }; }
  subscribeRecords(listener: Listener<PoseSourceEvent>) { this.recordListeners.add(listener); return () => { this.recordListeners.delete(listener); }; }
  publish(patch: Partial<PhoneView>) { this.view = { ...this.view, ...patch }; for (const listener of this.listeners) listener(this.view); }
  emit(event: PoseSourceEvent) { for (const listener of this.recordListeners) listener(event); }

  /** Starts pairing: a new code for a phone to scan. */
  async connect() {
    this.disconnect();
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
    this.publish({ status: 'connecting', pairing: { code: room.code, url: `${this.origin()}/phone/#${room.code}` }, message: 'Scan the code with your phone’s camera.' });
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

  /** Whether a song is on; the phone dims its screen while one plays. */
  setPlaying(playing: boolean) {
    if (playing === this.playing) return;
    this.playing = playing;
    this.send({ type: 'game', playing });
  }

  onSignal(event: PairingEvent) {
    const { peer } = this;
    if (event.type === 'hello') this.offer(event.device || 'Phone');
    else if (event.type === 'answer' && peer?.epoch === event.epoch) peer.accept(event.sdp).catch(() => { if (peer === this.peer) this.lost(); });
    else if (event.type === 'ice' && peer?.epoch === event.epoch) void peer.addIce(event.candidate);
    // The phone left before the connection opened: show the code again.
    else if (event.type === 'peer' && event.left && peer && this.control?.readyState !== 'open') this.lost();
    else if (event.type === 'closed') {
      // The room is gone, but a connected phone carries on without it.
      if (this.control?.readyState === 'open') {
        this.channel = null;
        this.publish({ pairing: null });
      } else this.fail(Error(event.reason));
    }
  }

  /** A phone said hello: a fresh connection for it, replacing any earlier one. */
  offer(device: string) {
    const { room, channel } = this;
    if (!room || !channel) return;
    this.closePeer();
    let peer: Peer;
    try {
      peer = this.peer = new Peer({ epoch: ++this.epoch, iceServers: room.iceServers, createConnection: this.createConnection,
        send: (signal) => { channel.send(signal).catch(() => {}); } });
    } catch (error) {
      // An ICE server entry the browser won't take (PAIRING_ICE_SERVERS).
      this.fail(Error(`Couldn't start a connection to the phone: ${reason(error)}`));
      return;
    }
    const live = this.live = peer.pc.createDataChannel(LIVE_CHANNEL, { ordered: false, maxRetransmits: 0 });
    const control = this.control = peer.pc.createDataChannel(CONTROL_CHANNEL);
    const mine = () => peer === this.peer;
    live.onmessage = control.onmessage = ({ data }) => { if (mine()) this.onMessage(data); };
    control.onopen = () => {
      if (!mine()) return;
      this.sendConfig();
      this.send({ type: 'game', playing: this.playing });
      this.pingTimer = setInterval(() => this.send({ type: 'ping', id: ++this.pings, t0: this.now() }), PING_MS);
      this.publish({ status: 'initializing', message: `${device} connected. Starting its camera…` });
    };
    control.onclose = () => { if (mine()) this.lost(); };
    peer.pc.onconnectionstatechange = () => {
      if (mine() && ['failed', 'closed'].includes(peer.pc.connectionState)) this.lost();
    };
    this.offeredAt = this.now();
    this.publish({ status: 'initializing', device, snapshot: null, message: `Connecting to ${device}…` });
    peer.offer().catch(() => { if (mine()) this.lost(); });
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
    clearInterval(this.pingTimer);
    for (const channel of [this.live, this.control]) {
      if (!channel) continue;
      channel.onmessage = channel.onopen = channel.onclose = null;
      channel.close();
    }
    this.live = this.control = null;
    this.peer?.close();
    this.peer = null;
    this.clock.reset();
    this.phone = null;
    this.arrivals = [];
    this.lastPose = -Infinity;
  }

  send(message: GameMessage) {
    const channel = message.type === 'ping' ? this.live : this.control;
    if (channel?.readyState === 'open') channel.send(JSON.stringify(message));
  }
  sendConfig() { this.send({ type: 'config', playerCount: this.playerCount, modelId: this.view.model }); }

  onMessage(data: unknown) {
    const message = parsePhoneMessage(data);
    if (!message) return;
    if (message.type === 'pong') this.clock.add(message.t0, message.t1, this.now());
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
    if (this.peer && this.control?.readyState !== 'open' && now - this.offeredAt > ATTEMPT_MS) this.lost();
  }
}
