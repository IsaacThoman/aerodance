import { CONTROL_CHANNEL, LIVE_CHANNEL, MAX_LIVE_BUFFER, parseGameMessage, poseMessage } from '../../../packages/pairing/link.ts';
import type { Facing, PhoneMessage, PhoneStatus } from '../../../packages/pairing/link.ts';
import { Peer } from '../../../packages/pairing/browser/peer.ts';
import type { CreatePeerConnection } from '../../../packages/pairing/browser/peer.ts';
import { RelayLink, relayUrl } from '../../../packages/pairing/browser/relay.ts';
import type { CreateRelaySocket, LinkChannel } from '../../../packages/pairing/browser/relay.ts';
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
 * While the game shows a setup preview it asks for the camera's picture: the phone puts its
 * camera on the connection's video track, scaled down to PREVIEW_LONG_SIDE at a low frame
 * rate and bitrate, and takes it off again when the preview goes.
 *
 * A game without WebRTC (the Apple TV app) answers hello with a relay signal instead of an
 * offer: the phone then connects through the pairing server's relay
 * (packages/pairing/relay.ts), with the same messages, and sends the preview as small JPEGs
 * (RELAY_PREVIEW_LONG_SIDE, RELAY_PREVIEW_FPS) since there's no video track.
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
  createSocket?: CreateRelaySocket;
  /** A JPEG of the camera's picture, its long side at most longSide (null while there's none yet). */
  captureFrame?: (video: HTMLVideoElement, longSide: number) => Promise<ArrayBuffer | null>;
}
type Listener<T> = (value: T) => void;

// Asks the game again this often while it hasn't connected (it may have been reloading)...
const HELLO_MS = 4000;
// ...but gives a connection attempt this long before asking for another.
const ATTEMPT_MS = 15_000;
// The phone's stats go to the game at most this often; anything else at once.
const STATS_MS = 1000;
const MAX_CAMERA_RETRY_MS = 30_000;
// The picture the game previews: its long side, frame rate and bitrate at most.
export const PREVIEW_LONG_SIDE = 320;
const PREVIEW_FPS = 12;
const PREVIEW_BITRATE = 250_000;
// Relayed, the preview is a JPEG this often, its long side this many pixels, at this quality.
export const RELAY_PREVIEW_LONG_SIDE = 240;
export const RELAY_PREVIEW_FPS = 8;
const RELAY_PREVIEW_QUALITY = 0.6;
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
let snapshotCanvas: HTMLCanvasElement | null = null;
/** The video's current picture as a small JPEG (one canvas, reused). */
export async function captureJpeg(video: HTMLVideoElement, longSide: number): Promise<ArrayBuffer | null> {
  const { videoWidth: w, videoHeight: h } = video;
  if (video.readyState < 2 || !w || !h) return null;
  const scale = Math.min(1, longSide / Math.max(w, h));
  const canvas = snapshotCanvas ??= document.createElement('canvas');
  canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale);
  // A canvas in memory, not on the GPU: encoding it then needs no readback from the GPU.
  canvas.getContext('2d', { willReadFrequently: true })?.drawImage(video, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', RELAY_PREVIEW_QUALITY));
  return blob ? blob.arrayBuffer() : null;
}

const stored = (code: string) => { try { return sessionStorage.getItem(`${TOKEN_KEY}-${code}`); } catch { return null; } };
const store = (code: string, token: string) => { try { sessionStorage.setItem(`${TOKEN_KEY}-${code}`, token); } catch { /* Private browsing. */ } };

export class PhoneLink {
  camera: WebcamPoseSource;
  base: string;
  fetch: typeof fetch | undefined;
  createStream: ((url: string) => EventStream) | undefined;
  createConnection: CreatePeerConnection | undefined;
  createSocket: CreateRelaySocket | undefined;
  captureFrame: (video: HTMLVideoElement, longSide: number) => Promise<ArrayBuffer | null>;
  now: () => number;
  device: string;
  listeners = new Set<Listener<PhoneLinkView>>();
  view: PhoneLinkView = { stage: 'code', code: '', message: '', error: '', playerCount: 1, playing: false };
  generation = 0;
  channel: SignalChannel | null = null;
  iceServers: IceServer[] = [];
  peer: Peer | null = null;
  /** ...or, through the relay, the link. */
  link: RelayLink | null = null;
  live: LinkChannel | null = null;
  control: LinkChannel | null = null;
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
  /** The game wants the camera's picture; where it goes, and the camera track on it. */
  previewWanted = false;
  videoSender: RTCRtpSender | null = null;
  sentTrack: MediaStreamTrack | null = null;
  /** Relayed: the timer sending JPEGs while the game previews, a capture in progress, and when the next may start. */
  frameTimer: ReturnType<typeof setInterval> | undefined;
  capturing = false;
  nextFrameAt = -Infinity;
  constructor({ camera, base = PAIRING_BASE, fetch: fetchFn, createStream, createConnection, now = () => performance.now(), device = deviceName(), cameraRetryMs = 2000,
    createSocket, captureFrame = captureJpeg }: PhoneLinkOptions = {}) {
    this.camera = camera ?? new WebcamPoseSource({ settingsKey: 'aerodance-phone', adaptToResize: true });
    this.base = base; this.fetch = fetchFn; this.createStream = createStream; this.createConnection = createConnection;
    this.createSocket = createSocket; this.captureFrame = captureFrame;
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
      const attempt = (this.peer && !['failed', 'closed'].includes(this.peer.pc.connectionState)) || (this.link && this.link.control.readyState !== 'closed');
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
    else if (event.type === 'relay') this.relayTo(event.epoch);
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
    // The game offers a video track for its preview: this side sends on it.
    const prepare = () => {
      const video = peer.pc.getTransceivers?.().find((t) => t.receiver.track.kind === 'video');
      if (!video) return;
      video.direction = 'sendonly';
      this.videoSender = video.sender;
    };
    peer.answer(sdp, prepare).catch(() => { if (mine()) this.unlinked(); });
  }

  /** The game asked to connect through the relay for this attempt. */
  relayTo(epoch: number) {
    const channel = this.channel;
    // As with offers, only a newer attempt replaces this one (the same one again only once its
    // link has gone: the game repeats the signal when a hello reached it mid-attempt).
    if (!channel || epoch < this.epoch || (epoch === this.epoch && this.link) || epoch < (this.early?.epoch ?? -1)) return;
    this.epoch = epoch;
    this.closePeer();
    this.early = null;
    this.offeredAt = this.now();
    const link = this.link = new RelayLink({ url: relayUrl(this.base, channel.code, channel.token, epoch), createSocket: this.createSocket });
    const mine = () => link === this.link;
    this.live = link.live;
    this.control = link.control;
    link.live.onmessage = link.control.onmessage = ({ data }) => { if (mine()) this.onMessage(data); };
    link.control.onopen = () => { if (mine()) this.linked(); };
    link.control.onclose = () => { if (mine()) this.unlinked(); };
  }

  linked() {
    this.publish({ stage: 'linked', message: '' });
    this.sentStatus = '';
    this.sendStatus(this.camera.view);
    this.resume();
  }

  /** The connection dropped: ask the game to connect again. */
  unlinked() {
    // A relayed attempt fails within a round trip (an overlapping hello replaced it): asking again
    // at once would replace the next one too, so only a link that had opened asks straight away.
    // Otherwise the hello timer asks, unless the attempt that replaced this one links first.
    const retry = this.view.stage === 'linked' || !this.link;
    this.closePeer();
    if (this.view.stage !== 'linked' && this.view.stage !== 'linking') return;
    if (!this.channel) { this.end(this.endReason || 'Lost the game. Scan its code again.'); return; }
    this.publish({ stage: 'linking', message: 'Reconnecting to the game…' });
    if (retry) this.hello();
  }

  /** Whether the camera's picture is going to the game. */
  get sendingVideo() { return !!this.sentTrack || !!this.frameTimer; }

  /** Puts the camera on the video track while the game previews it, and takes it off after. */
  updateVideo() {
    if (this.link) { this.updateFrames(); return; }
    const sender = this.videoSender;
    const track = (this.previewWanted && this.camera.stream?.getVideoTracks()[0]) || null;
    if (!sender || track === this.sentTrack) return;
    this.sentTrack = track;
    void sender.replaceTrack(track).then(() => { if (track && this.sentTrack === track) return this.limitVideo(sender, track); }).catch(() => {});
  }

  /** A small, slow picture: it's only for lining the players up. */
  async limitVideo(sender: RTCRtpSender, track: MediaStreamTrack) {
    const { width = 640, height = 480 } = track.getSettings();
    const params = sender.getParameters();
    if (!params.encodings?.length) return;
    Object.assign(params.encodings[0], { maxBitrate: PREVIEW_BITRATE, maxFramerate: PREVIEW_FPS,
      scaleResolutionDownBy: Math.max(1, Math.max(width, height) / PREVIEW_LONG_SIDE) });
    await sender.setParameters(params);
  }

  /** Relayed: JPEGs of the camera at RELAY_PREVIEW_FPS while the game previews it. */
  updateFrames() {
    const wanted = this.previewWanted && this.control?.readyState === 'open' && !!this.camera.stream;
    if (wanted === !!this.frameTimer) return;
    clearInterval(this.frameTimer);
    this.frameTimer = wanted ? setInterval(() => void this.sendFrame(), 1000 / RELAY_PREVIEW_FPS) : undefined;
  }

  async sendFrame() {
    const link = this.link, video = this.camera.video, start = this.now();
    if (!link || !video || this.capturing || start < this.nextFrameAt) return;
    this.capturing = true;
    try {
      const jpeg = await this.captureFrame(video, RELAY_PREVIEW_LONG_SIDE);
      // A slow link skips pictures rather than queueing them.
      if (jpeg && link === this.link) link.sendFrame(jpeg);
    } catch { /* No picture this time. */ } finally {
      this.capturing = false;
      // Tracking comes first: a phone that's slow to take pictures takes fewer (at most a fifth of its time).
      this.nextFrameAt = this.now() + 4 * (this.now() - start);
    }
  }

  closePeer() {
    clearInterval(this.frameTimer);
    this.frameTimer = undefined;
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
    this.videoSender = null;
    this.sentTrack = null;
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

  send(channel: LinkChannel | null, message: PhoneMessage | string) {
    if (channel?.readyState !== 'open') return false;
    channel.send(typeof message === 'string' ? message : JSON.stringify(message));
    return true;
  }

  onMessage(data: unknown) {
    const message = parseGameMessage(data);
    if (!message) return;
    if (message.type === 'ping') this.send(this.live, { type: 'pong', id: message.id, t0: message.t0, t1: this.now() });
    else if (message.type === 'game') this.publish({ playing: message.playing });
    else if (message.type === 'preview') { this.previewWanted = message.on; this.updateVideo(); }
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
    // A restarted camera is a new track.
    this.updateVideo();
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
