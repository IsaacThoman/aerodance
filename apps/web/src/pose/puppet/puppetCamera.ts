import { PoseSourceController } from '../../../../../packages/pose/browser/PoseSourceController.ts';
import { WebcamPoseSource } from '../../../../../packages/pose/browser/WebcamPoseSource.ts';
import type { PoseWorker } from '../../../../../packages/pose/browser/WebcamPoseSource.ts';
import type { PoseWorkerRequest, PoseWorkerResponse } from '../../../../../packages/pose/browser/pose.worker.ts';
import { CameraInput } from '../CameraInput.ts';
import { Puppet, REALISM } from './Puppet.ts';
import { PUPPET_USAGE, runPuppetCommand } from './commands.ts';

/*
 * The puppet as a camera (?input=puppet): a webcam whose picture is the puppets drawn as paper
 * dolls, and a pose worker that answers each frame with what MediaPipe would have found in it
 * (Puppet.detect), after the time tracking takes. Both plug into the real WebcamPoseSource, so
 * everything after the model runs as it does for a person in front of a webcam: frame
 * scheduling (one frame in flight, the newest waiting), the player tracker numbering people and
 * following them, the record checks, calibration, the live characters, scoring and the
 * minigames' pose API. Nothing else knows it's a puppet; the camera picker calls it Puppet camera.
 *
 * Each frame reports the puppets as they were captureMs before the browser saw it (a webcam's
 * own delay, which the browser can't measure) and arrives inferenceMs later, so latency and the
 * tracking rate are as honest as Puppet.realism makes them. Asked for the 'hands' detail, it
 * answers with world landmarks and hands from the puppets' own bodies (rig.ts), the hand model
 * taking HANDS_LOAD_MS to load.
 *
 * The page gets window.puppet: the Puppet, plus run('pose 0 tpose --ms 300') for the command
 * line (commands.ts), which `node scripts/play.ts puppet ...` sends.
 */

export const PUPPET_CAMERA = { deviceId: 'puppet', label: 'Puppet camera' } as const;
// The camera's picture: a 4:3 webcam frame, redrawn 30 times a second.
const FRAME = { width: 640, height: 480 };
const FPS = 30;
/** How long the puppet's hand model takes to load. */
export const HANDS_LOAD_MS = 250;

declare global {
  interface Window {
    /** ?input=puppet: the puppets in front of the camera (pose/puppet/). */
    puppet?: Puppet & { run(command: string | readonly string[]): unknown; help(): string };
  }
}

/** A pose worker (pose.worker.ts's protocol) that reports the puppets instead of running a model. */
export function puppetWorker(puppet: Puppet, { now = () => performance.now(), random = Math.random } = {}): PoseWorker {
  let sessionId: string | undefined;
  let looks = false;
  let closed = false;
  // The detail: world landmarks kept, the hands asked for, and whether they've loaded.
  let world = false, hands = false, handsOn = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const reply = (ms: number, response: PoseWorkerResponse) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!closed) worker.onmessage?.({ data: response } as MessageEvent<PoseWorkerResponse>);
    }, ms);
    timers.add(timer);
  };
  const worker: PoseWorker = {
    onmessage: null,
    onerror: null,
    postMessage(message: PoseWorkerRequest) {
      if (closed) return;
      if (message.type === 'initialize') {
        sessionId = message.sessionId;
        looks = !!message.looks;
        // One or two players ask for that many people; three or four a strip each (or one more in the whole picture).
        puppet.follow(message.tiles?.length ?? (message.playerCount <= 2 ? message.playerCount : message.playerCount - 1));
        reply(30, { type: 'ready', sessionId, delegate: 'GPU', fallback: '' });
      } else if (message.type === 'detail') {
        world = message.world;
        hands = !!message.hands;
        if (!hands) { handsOn = false; return; }
        // The hand model loads (unless it's turned off meanwhile), then says so.
        const timer = setTimeout(() => {
          timers.delete(timer);
          if (closed || !hands) return;
          handsOn = true;
          worker.onmessage?.({ data: { type: 'hands', sessionId, state: 'on' } } as MessageEvent<PoseWorkerResponse>);
        }, handsOn ? 0 : HANDS_LOAD_MS);
        timers.add(timer);
      } else if (message.type === 'frame') {
        message.bitmap.close?.();
        // The frame shows the puppets a camera delay ago; tracking it takes inferenceMs, give or take.
        const found = puppet.detect(now() - puppet.realism.captureMs, { world, hands: handsOn });
        const inferenceMs = puppet.realism.inferenceMs * (0.85 + random() * 0.3);
        // As the real worker: hands for the one person looked for.
        const handsFound = handsOn ? (found.landmarks.length === 1 ? found.hands : found.landmarks.map(() => [])) : undefined;
        reply(inferenceMs, { type: 'result', sessionId, seq: message.seq, landmarks: found.landmarks, inferenceMs, ...(looks ? { looks: found.looks } : {}),
          ...(world ? { world: found.world } : {}), ...(handsFound ? { hands: handsFound } : {}) });
      } else if (message.type === 'close') {
        closed = true;
      }
    },
    terminate() {
      closed = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
  return worker;
}

// The skin tone the dolls' heads and hands are drawn in.
const SKIN = '#e8b896';
const rgb = ([r, g, b]: readonly number[]) => `rgb(${r}, ${g}, ${b})`;

/** Draws the puppets as the camera would see them at t: a plain room and a paper doll each. */
export function drawPuppets(g: CanvasRenderingContext2D, puppet: Puppet, t: number) {
  const { width: w, height: h } = FRAME;
  const wall = g.createLinearGradient(0, 0, 0, h);
  wall.addColorStop(0, '#d9e4ea');
  wall.addColorStop(0.62, '#c7d3da');
  wall.addColorStop(0.62, '#a99c8d');
  wall.addColorStop(1, '#8f8274');
  g.fillStyle = wall;
  g.fillRect(0, 0, w, h);
  for (const person of puppet.people) {
    if (!puppet.inView(person.id, t)) continue;
    const { image: p } = puppet.bodyAt(person.id, t);
    const at = (i: number) => [p[i].x * w, p[i].y * h] as const;
    const torso = Math.hypot((p[11].x + p[12].x - p[23].x - p[24].x) / 2 * w, (p[11].y + p[12].y - p[23].y - p[24].y) / 2 * h);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    // Legs, then the torso and arms, then the head and hands.
    const limb = (a: number, b: number, color: string, width: number) => {
      g.strokeStyle = color;
      g.lineWidth = width;
      g.beginPath();
      g.moveTo(...at(a));
      g.lineTo(...at(b));
      g.stroke();
    };
    for (const [a, b] of [[23, 25], [25, 27], [24, 26], [26, 28], [27, 31], [28, 32]]) limb(a, b, rgb(person.trousers), torso * 0.28);
    g.fillStyle = rgb(person.shirt);
    g.beginPath();
    for (const i of [11, 12, 24, 23]) g.lineTo(...at(i));
    g.closePath();
    g.fill();
    g.strokeStyle = rgb(person.shirt);
    g.lineWidth = torso * 0.22;
    g.stroke();
    for (const [a, b] of [[11, 13], [13, 15], [12, 14], [14, 16]]) limb(a, b, rgb(person.shirt), torso * 0.2);
    g.fillStyle = SKIN;
    for (const i of [15, 16]) { g.beginPath(); g.arc(...at(i), torso * 0.11, 0, Math.PI * 2); g.fill(); }
    const [ex, ey] = [(p[7].x + p[8].x) / 2 * w, (p[7].y + p[8].y) / 2 * h];
    g.beginPath();
    g.arc(ex, ey, Math.max(torso * 0.22, Math.hypot((p[7].x - p[8].x) * w, (p[7].y - p[8].y) * h) * 0.6), 0, Math.PI * 2);
    g.fill();
  }
}

/** A camera for WebcamPoseSource: its picture shows the puppets, its frames are tracked as the puppets. */
export function createPuppetCamera(puppet: Puppet) {
  const mediaDevices: Pick<MediaDevices, 'getUserMedia' | 'enumerateDevices'> = {
    enumerateDevices: async () => [{ kind: 'videoinput', deviceId: PUPPET_CAMERA.deviceId, label: PUPPET_CAMERA.label, groupId: 'puppet', toJSON: () => ({}) } as MediaDeviceInfo],
    getUserMedia: async () => {
      const canvas = document.createElement('canvas');
      Object.assign(canvas, FRAME);
      const g = canvas.getContext('2d');
      if (!g) throw Error('2D canvas unavailable');
      const draw = () => drawPuppets(g, puppet, puppet.now() - puppet.realism.captureMs);
      draw();
      const stream = canvas.captureStream(FPS);
      const timer = setInterval(draw, 1000 / FPS);
      for (const track of stream.getVideoTracks()) {
        const stop = track.stop.bind(track), settings = track.getSettings.bind(track);
        track.stop = () => { clearInterval(timer); stop(); };
        track.getSettings = () => ({ ...settings(), deviceId: PUPPET_CAMERA.deviceId });
      }
      return stream;
    },
  };
  return { puppet, mediaDevices, createWorker: () => puppetWorker(puppet) };
}

// One puppet camera for the page, kept on it (like the mixer) so React's double-run initialisers
// and hot reloads all get the camera window.puppet poses.
const KEY: unique symbol = Symbol.for('aerodance.puppetInput');
const page = globalThis as typeof globalThis & { [KEY]?: CameraInput };

/**
 * The game's camera for ?input=puppet: CameraInput over a WebcamPoseSource on the puppet camera
 * (its own saved settings, the webcam's mode whatever was picked last). ?puppets=<0-4> places that
 * many instead of following the game's player count, and ?puppetRealism=clean|real|rough sets how
 * real the camera is. Installs window.puppet. The same one each time it's asked for on a page.
 */
export function createPuppetInput(params: URLSearchParams): CameraInput {
  const existing = page[KEY];
  if (existing) return existing;
  const realism = params.get('puppetRealism');
  const puppet = new Puppet({ realism: realism === 'clean' || realism === 'rough' ? REALISM[realism] : REALISM.real });
  const count = params.get('puppets');
  if (count !== null && /^[0-4]$/.test(count)) { puppet.auto = false; puppet.lineUp(Number(count)); }
  const camera = createPuppetCamera(puppet);
  try { localStorage.setItem('aerodance-puppet-camera', PUPPET_CAMERA.deviceId); } catch { /* Private browsing. */ }
  const webcam = new WebcamPoseSource({ mediaDevices: camera.mediaDevices, createWorker: camera.createWorker, settingsKey: 'aerodance-puppet' });
  window.puppet = Object.assign(puppet, {
    run: (command: string | readonly string[]) => runPuppetCommand(puppet, command),
    help: () => PUPPET_USAGE,
  });
  const input = new CameraInput({ webcam: new PoseSourceController({ webcam }), mode: 'webcam', webcamSupported: true });
  page[KEY] = input;
  return input;
}
