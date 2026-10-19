import { CONTROL_CHANNEL, LIVE_CHANNEL, MAX_LIVE_BUFFER, parseGameMessage, poseMessage } from '../../../packages/pairing/link.ts';
import type { Facing, PhoneMessage, PhoneStatus } from '../../../packages/pairing/link.ts';
import { Peer } from '../../../packages/pairing/browser/peer.ts';
import type { CreatePeerConnection } from '../../../packages/pairing/browser/peer.ts';
import { PAIRING_BASE, SignalChannel, joinRoom } from '../../../packages/pairing/browser/signalChannel.ts';
import type { EventStream } from '../../../packages/pairing/browser/signalChannel.ts';
import { isPairingCode } from '../../../packages/pairing/signals.ts';
import type { IceCandidate, IceServer, PairingEvent } from '../../../packages/pairing/signals.ts';
import { WebcamPoseSource } from '../../../packages/pose/browser/WebcamPoseSource.ts';
import type { WebcamRecordEvent, WebcamView } from '../../../packages/pose/browser/WebcamPoseSource.ts';
import type { PlayerCount } from '../../../packages/pose/choreography.ts';

/*
 * The phone's end of a pairing: it joins the game's room with the code, answers the game's
 * WebRTC offer, tracks the players with its own camera (the same WebcamPoseSource the game
 * uses) and sends their poses back. The game decides the player count and model (the
 * phone can change the model too) and tells the phone when a song is on.
 *
 *   code      no code yet, or the last one didn't work (view.error says why)
 *   joining   asking the pairing server for a place in the room
 *   linking   waiting for the game's offer, or for the connection to open
 *   linked    connected: the camera runs and poses flow
 *   ended     the game ended the pairing
 *
 * A connection that drops goes back to linking and says hello again until the game
 * answers (not while an answer is still connecting). A linked phone keeps going if the
 * pairing server goes away. The camera stops while the page is hidden and restarts when it
 * shows again. Once it has tracked, it also starts again by itself when it fails while linked
 * (a phone on a stand has no one to press anything), waiting longer each time it fails
 * without tracking; a camera that never worked (permission denied) waits for the player.
 *
 * const link = new PhoneLink(); link.subscribe(render); link.join('123456');
 */

export type PhoneStage = 'code' | 'joining' | 'linking' | 'linked' | 'ended';
export interface PhoneLinkView {
  stage: PhoneStage;
  /** The code being joined (or typed so far). */
  code: string;
  /** What's happening, for the linking and ended screens. */
  message: string;
  /** Why the last code didn't work. */
  error: string;
  playerCount: PlayerCount;
  /** A song is on in the game. */
  playing: boolean;
}
export interface PhoneLinkOptions {
  camera?: WebcamPoseSource;
  base?: string;
  fetch?: typeof fetch;
  createStream?: (url: string) => EventStream;
  createConnection?: CreatePeerConnection;
  now?: () => number;
  device?: string;
  /** The first wait before starting a failed camera again (doubling, up to 30 s). */
  cameraRetryMs?: number;
}
type Listener<T> = (value: T) => void;

// Asks the game again this often while it hasn't connected (it may have been reloading)...
const HELLO_MS = 4000;
// ...but gives a connection attempt this long before asking for another.
const ATTEMPT_MS = 15_000;
// The phone's stats go to the game at most this often; anything else at once.
const STATS_MS = 1000;
const MAX_CAMERA_RETRY_MS = 30_000;
const TOKEN_KEY = 'aerodance-phone-token';

/** What the game calls this phone. */
export function deviceName(ua = globalThis.navigator?.userAgent ?? '') {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  return 'Phone';
}
/** The code a link carries: /phone/#123456 (or ?code=123456). */
export function linkCode(url: URL) {
  const code = url.hash.slice(1) || url.searchParams.get('code') || '';
  return isPairingCode(code) ? code : '';
}
const stored = (code: string) => { try { return sessionStorage.getItem(`${TOKEN_KEY}-${code}`); } catch { return null; } };
const store = (code: string, token: string) => { try { sessionStorage.setItem(`${TOKEN_KEY}-${code}`, token); } catch { /* Private browsing. */ } };

export class PhoneLink {
  camera: WebcamPoseSource;
  base: string;
  fetch: typeof fetch | undefined;
  createStream: ((url: string) => EventStream) | undefined;
  createConnection: CreatePeerConnection | undefined;
  now: () => number;
  device: string;
  listeners = new Set<Listener<PhoneLinkView>>();
  view: PhoneLinkView = { stage: 'code', code: '', message: '', error: '', playerCount: 1, playing: false };
  generation = 0;
  channel: SignalChannel | null = null;
  iceServers: IceServer[] = [];
  peer: Peer | null = null;
  live: RTCDataChannel | null = null;
  control: RTCDataChannel | null = null;
  helloTimer: ReturnType<typeof setInterval> | undefined;
  /** When the game's latest offer arrived, and its attempt number. */
  offeredAt = -Infinity;
  epoch = -1;
  /** Candidates for an offer that hasn't arrived yet (signals can overtake each other). */
  early: { epoch: number; candidates: IceCandidate[] } | null = null;
  /** Why the room ended while linked (the phone carries on until the link drops). */
  endReason = '';
  /** This join, to the pairing server: a late close from an earlier join (or page) can't end it. */
  session = '';
  sentStatus = '';
  sentStatsAt = -Infinity;
  wakeLock: WakeLockSentinel | null = null;
  cameraRetryMs: number;
  /** The camera has tracked; failed starts since it last did, and the next one waiting. */
  cameraTracked = false;
  cameraRetries = 0;
  cameraRetry: ReturnType<typeof setTimeout> | undefined;
  constructor({ camera, base = PAIRING_BASE, fetch: fetchFn, createStream, createConnection, now = () => performance.now(), device = deviceName(), cameraRetryMs = 2000 }: PhoneLinkOptions = {}) {
    this.camera = camera ?? new WebcamPoseSource({ settingsKey: 'aerodance-phone', adaptToResize: true });
    this.base = base; this.fetch = fetchFn; this.createStream = createStream; this.createConnection = createConnection;
    this.now = now; this.device = device; this.cameraRetryMs = cameraRetryMs;
    // The back camera by default: it's the better one, and the phone faces the players.
    if (!this.camera.view.facing && !this.camera.view.cameraId) this.camera.publish({ facing: 'environment' });
    this.camera.subscribe((view) => this.onCamera(view));
    this.camera.subscribeRecords((event) => this.onRecord(event));
  }

  subscribe(listener: Listener<PhoneLinkView>) { this.listeners.add(listener); listener(this.view); return () => { this.listeners.delete(listener); }; }
  publish(patch: Partial<PhoneLinkView>) { this.view = { ...this.view, ...patch }; for (const listener of this.listeners) listener(this.view); }

  /** Joins the game showing this code. */
  async join(code: string) {
    this.stop();
    const generation = this.generation;
    this.session = globalThis.crypto?.randomUUID?.() ?? String(Math.random());
    this.publish({ stage: 'joining', code, error: '', message: 'Finding the game…', playing: false });
    let token: string;
    try {
      const joined = await joinRoom(code, stored(code), this.session, this.base, this.fetch);
      token = joined.token;
      this.iceServers = joined.iceServers;
    } catch (error) {
      if (generation === this.generation) this.publish({ stage: 'code', code: '', error: error instanceof Error ? error.message : 'Pairing failed. Try again.' });
      return;
    }
    const channel = new SignalChannel({ code, token, session: this.session, base: this.base, fetch: this.fetch, createStream: this.createStream,
      onEvent: (event) => { if (generation === this.generation) this.onSignal(event); } });
    // Cancelled while joining: give the place back so the next try isn't refused.
    if (generation !== this.generation) { channel.leave(); return; }
    store(code, token);
    this.channel = channel;
    this.endReason = '';
    channel.open();
    this.publish({ stage: 'linking', message: 'Connecting to the game…' });
    this.hello();
    this.helloTimer = setInterval(() => {
      const attempt = this.peer && !['failed', 'closed'].includes(this.peer.pc.connectionState);
      if (this.view.stage === 'linking' && !(attempt && this.now() - this.offeredAt < ATTEMPT_MS)) this.hello();
    }, HELLO_MS);
  }

  /** Leaves the game (the code screen again). */
  leave() {
    this.channel?.leave();
    this.channel = null;
    this.stop();
    this.publish({ stage: 'code', code: '', error: '', message: '', playing: false });
  }

  /** Stops everything without telling the game (it hears from the pairing server). */
  stop() {
    this.generation++;
    clearInterval(this.helloTimer);
    this.channel?.close();
    this.channel = null;
    this.closePeer();
    this.early = null;
    this.epoch = -1;
    clearTimeout(this.cameraRetry);
    this.cameraRetry = undefined;
    this.camera.disconnect('Camera stopped.');
    this.releaseWakeLock();
  }

  hello() { this.channel?.send({ type: 'hello', device: this.device }).catch(() => {}); }

  onSignal(event: PairingEvent) {
    if (event.type === 'offer') this.answer(event.epoch, event.sdp);
    else if (event.type === 'ice') {
      if (event.epoch === this.peer?.epoch) void this.peer.addIce(event.candidate);
      // Newer than any offer so far: keep it for that offer (older attempts' are dropped).
      else if (event.epoch > Math.max(this.epoch, this.early?.epoch ?? -1)) this.early = { epoch: event.epoch, candidates: [event.candidate] };
      else if (event.epoch === this.early?.epoch) this.early.candidates.push(event.candidate);
    } else if (event.type === 'closed') {
      // Linked: carry on without the room, and end when the link does.
      if (this.view.stage === 'linked') { this.channel = null; this.endReason = event.reason; return; }
      this.end(event.reason);
    } else if (event.type === 'peer' && !event.present && this.view.stage === 'linking') this.publish({ message: 'Waiting for the game…' });
  }

  end(reason: string) {
    this.stop();
    this.publish({ stage: 'ended', message: reason, playing: false });
  }

  answer(epoch: number, sdp: string) {
    const channel = this.channel;
    // Offers can overtake each other too: only a newer attempt replaces this one.
    if (!channel || epoch <= this.epoch || epoch < (this.early?.epoch ?? -1)) return;
    this.epoch = epoch;
    this.closePeer();
    let peer: Peer;
    try {
      peer = this.peer = new Peer({ epoch, iceServers: this.iceServers, createConnection: this.createConnection,
        send: (signal) => { channel.send(signal).catch(() => {}); } });
    } catch (error) {
      this.end(`Couldn't connect to the game: ${error instanceof Error ? error.message : 'unsupported connection settings'}`);
      return;
    }
    this.offeredAt = this.now();
    // Candidates that overtook this offer wait in the peer until it has the offer.
    if (this.early?.epoch === epoch) peer.pending.push(...this.early.candidates);
    this.early = null;
    const mine = () => peer === this.peer;
    peer.pc.ondatachannel = ({ channel: data }) => {
      if (!mine()) { data.close(); return; }
      data.onmessage = ({ data: message }) => { if (mine()) this.onMessage(message); };
      if (data.label === LIVE_CHANNEL) this.live = data;
      else if (data.label === CONTROL_CHANNEL) {
        this.control = data;
        data.onopen = () => { if (mine()) this.linked(); };
        data.onclose = () => { if (mine()) this.unlinked(); };
        if (data.readyState === 'open') this.linked();
      }
    };
    peer.pc.onconnectionstatechange = () => {
      if (mine() && ['failed', 'closed'].includes(peer.pc.connectionState)) this.unlinked();
    };
    peer.answer(sdp).catch(() => { if (mine()) this.unlinked(); });
  }

  linked() {
    this.publish({ stage: 'linked', message: '' });
    this.sentStatus = '';
    this.sendStatus(this.camera.view);
    this.resume();
  }

  /** The connection dropped: ask the game to connect again. */
  unlinked() {
    this.closePeer();
    if (this.view.stage !== 'linked' && this.view.stage !== 'linking') return;
    if (!this.channel) { this.end(this.endReason || 'Lost the game. Scan its code again.'); return; }
    this.publish({ stage: 'linking', message: 'Reconnecting to the game…' });
    this.hello();
  }

  closePeer() {
    for (const channel of [this.live, this.control]) {
      if (!channel) continue;
      channel.onmessage = channel.onopen = channel.onclose = null;
      channel.close();
    }
    this.live = this.control = null;
    this.peer?.close();
    this.peer = null;
  }

  /** Starts the camera while linked and showing (the page hidden stops it). */
  resume() {
    if (this.view.stage !== 'linked' || globalThis.document?.hidden) return;
    clearTimeout(this.cameraRetry);
    this.cameraRetry = undefined;
    if (['disconnected', 'error'].includes(this.camera.view.status)) void this.camera.connect();
    void this.keepAwake();
  }

  setFacing(facing: Facing) { return this.camera.configure({ facing, cameraId: '' }); }
  setModel(modelId: string) { return this.camera.configure({ modelId }); }

  send(channel: RTCDataChannel | null, message: PhoneMessage | string) {
    if (channel?.readyState !== 'open') return false;
    channel.send(typeof message === 'string' ? message : JSON.stringify(message));
    return true;
  }

  onMessage(data: unknown) {
    const message = parseGameMessage(data);
    if (!message) return;
    if (message.type === 'ping') this.send(this.live, { type: 'pong', id: message.id, t0: message.t0, t1: this.now() });
    else if (message.type === 'game') this.publish({ playing: message.playing });
    else {
      this.publish({ playerCount: message.playerCount });
      void this.camera.setPlayerCount(message.playerCount).catch(() => {});
      if (message.modelId !== this.camera.view.model) void this.camera.configure({ modelId: message.modelId }).catch(() => {});
    }
  }

  onRecord(event: WebcamRecordEvent) {
    const live = this.live;
    if (!('record' in event) || !live || live.bufferedAmount > MAX_LIVE_BUFFER) return;
    this.send(live, poseMessage(event.record));
  }

  onCamera(view: WebcamView) {
    if (view.status === 'connected') { this.cameraTracked = true; this.cameraRetries = 0; void this.keepAwake(); }
    // A failed camera starts again shortly, so the screen stays on meanwhile.
    // (Saying so publishes the camera again, which sends its status.)
    else if (view.status === 'error' && this.cameraTracked && this.view.stage === 'linked') { if (this.retryCamera()) return; }
    else if (view.status !== 'initializing') this.releaseWakeLock();
    this.sendStatus(view);
  }

  retryCamera() {
    if (this.cameraRetry) return false;
    const wait = Math.min(MAX_CAMERA_RETRY_MS, this.cameraRetryMs * 2 ** this.cameraRetries++);
    this.cameraRetry = setTimeout(() => { this.cameraRetry = undefined; this.resume(); }, wait);
    // What went wrong, without its advice to start the camera.
    this.camera.publish({ message: `${/^[^.]*\./.exec(this.camera.view.message)?.[0] ?? 'The camera stopped.'} Starting it again…` });
    return true;
  }

  sendStatus(view: WebcamView) {
    const status: PhoneStatus = { type: 'status', status: view.status, message: view.message, model: view.model,
      delegate: view.delegate ?? null, facing: view.facing ?? 'user', inferenceMs: view.stats ? Math.round(view.stats.inferenceMs) : null };
    // Everything but the tracking rate and timing goes out at once.
    const key = `${status.status}|${status.model}|${status.delegate}|${status.facing}|${status.message.replace(/[\d.]+ poses\/s/, '')}`;
    const now = this.now();
    if (key === this.sentStatus && now - this.sentStatsAt < STATS_MS) return;
    if (this.send(this.control, status)) { this.sentStatus = key; this.sentStatsAt = now; }
  }

  /** Keeps the screen on while the camera runs (where the browser allows it). */
  async keepAwake() {
    if (this.wakeLock || globalThis.document?.hidden || !globalThis.navigator?.wakeLock) return;
    try {
      const lock = await navigator.wakeLock.request('screen');
      if (this.wakeLock || this.view.stage !== 'linked') { void lock.release(); return; }
      this.wakeLock = lock;
      lock.addEventListener('release', () => { if (this.wakeLock === lock) this.wakeLock = null; });
    } catch { /* Not allowed here (low battery, no user gesture yet): the screen may sleep. */ }
  }
  releaseWakeLock() {
    const lock = this.wakeLock;
    this.wakeLock = null;
    void lock?.release().catch(() => {});
  }
}
