// Web Audio for the game (apps/web/src/audio/): AudioContext, gain nodes with automation, buffer
// sources, a pass-through DynamicsCompressor and decodeAudioData, over the native mixer
// (src/Audio.mm). The graph is mirrored natively; parameter automation is evaluated there per
// sample, and here only for AudioParam.value.
import { native } from './native.ts';
import { EventTargetShim, EventShim } from './dom.ts';

const N = native;
// Commands (src/Audio.mm).
const A = { init: 1, time: 2, create: 3, connect: 4, disconnect: 5, param: 6, start: 7, stop: 8, decode: 9, timestamp: 10, latency: 11, suspend: 12, resume: 13, createBuffer: 14, release: 15 } as const;
const NODE = { destination: 0, gain: 1, source: 2, compressor: 3 } as const;
const EV = { value: 0, set: 1, linear: 2, exponential: 3, target: 4, cancel: 5 } as const;

let nextNode = 1;
// Sources that have started and not ended yet, to fire 'ended' on. A source leaves as soon as it
// ends, so a stopped source (and its AudioBuffer) isn't kept alive here.
let ended: Map<number, AudioBufferSourceNodeShim> = new Map();
/** The native mixer reports a source that played out or was stopped. */
export function audioEnded(id: number) {
  const node = ended.get(id);
  if (!node) return;
  ended.delete(id);
  node.dispatchEvent(new EventShim('ended'));
}
// Native nodes go when their JavaScript node is collected.
const freeNode = new FinalizationRegistry<number>((id) => { N.audio(A.release, id); });

type Event = { type: number; value: number; time: number; tc: number };
export class AudioParamShim {
  _node: number; _index: number; _value: number; _events: Event[] = [];
  readonly defaultValue: number; readonly minValue = -3.4028234663852886e38; readonly maxValue = 3.4028234663852886e38;
  automationRate = 'a-rate';
  _ctx: AudioContextShim;
  constructor(ctx: AudioContextShim, node: number, index: number, value: number) { this._ctx = ctx; this._node = node; this._index = index; this._value = value; this.defaultValue = value; }
  _send(type: number, value: number, time: number, tc = 0) { N.audio(A.param, this._node, this._index, type, value, time, tc); }
  _add(e: Event) {
    let i = this._events.length;
    while (i > 0 && this._events[i - 1].time > e.time) i--;
    this._events.splice(i, 0, e);
    this._send(e.type, e.value, e.time, e.tc);
    return this;
  }
  get value() { return this._valueAt(this._ctx.currentTime); }
  set value(v: number) { this._value = v; this._events = []; this._send(EV.value, v, 0); }
  setValueAtTime(v: number, t: number) { return this._add({ type: EV.set, value: v, time: t, tc: 0 }); }
  linearRampToValueAtTime(v: number, t: number) { return this._add({ type: EV.linear, value: v, time: t, tc: 0 }); }
  exponentialRampToValueAtTime(v: number, t: number) { return this._add({ type: EV.exponential, value: v, time: t, tc: 0 }); }
  setTargetAtTime(v: number, t: number, tc: number) { return this._add({ type: EV.target, value: v, time: t, tc }); }
  setValueCurveAtTime(values: ArrayLike<number>, t: number, duration: number) {
    for (let i = 0; i < values.length; i++) this.linearRampToValueAtTime(values[i], t + (duration * i) / Math.max(1, values.length - 1));
    return this;
  }
  cancelScheduledValues(t: number) { this._events = this._events.filter((e) => e.time < t); this._send(EV.cancel, 0, t); return this; }
  cancelAndHoldAtTime(t: number) { const v = this._valueAt(t); this.cancelScheduledValues(t); return this.setValueAtTime(v, t); }
  /** The automation timeline's value at time t (the same rules as the native mixer). */
  _valueAt(t: number) {
    let v = this._value, vt = 0;
    for (let i = 0; i < this._events.length; i++) {
      const e = this._events[i];
      if (e.time > t) {
        if (e.type === EV.linear) return v + ((e.value - v) * (t - vt)) / Math.max(1e-9, e.time - vt);
        if (e.type === EV.exponential && v * e.value > 0) return v * (e.value / v) ** ((t - vt) / Math.max(1e-9, e.time - vt));
        return v;
      }
      if (e.type === EV.target) {
        const next = this._events[i + 1];
        const until = next && next.time <= t ? next.time : t;
        v = e.value + (v - e.value) * Math.exp(-(until - e.time) / Math.max(1e-9, e.tc));
      } else v = e.value;
      vt = e.time;
    }
    return v;
  }
}

export class AudioNodeShim extends EventTargetShim {
  readonly context: AudioContextShim;
  _id: number;
  numberOfInputs = 1; numberOfOutputs = 1; channelCount = 2; channelCountMode = 'max'; channelInterpretation = 'speakers';
  constructor(ctx: AudioContextShim, type: number, id = nextNode++) {
    super();
    this.context = ctx; this._id = id;
    if (type !== NODE.destination) { N.audio(A.create, id, type); freeNode.register(this, id); }
  }
  connect<T extends AudioNodeShim | AudioParamShim>(dest: T) {
    if (dest instanceof AudioNodeShim) N.audio(A.connect, this._id, dest._id);
    return dest;
  }
  disconnect(dest?: AudioNodeShim) { N.audio(A.disconnect, this._id, dest ? dest._id : -1); }
}
export class GainNodeShim extends AudioNodeShim {
  readonly gain: AudioParamShim;
  constructor(ctx: AudioContextShim) { super(ctx, NODE.gain); this.gain = new AudioParamShim(ctx, this._id, 0, 1); }
}
export class DynamicsCompressorNodeShim extends AudioNodeShim {
  readonly threshold: AudioParamShim; readonly knee: AudioParamShim; readonly ratio: AudioParamShim;
  readonly attack: AudioParamShim; readonly release: AudioParamShim; reduction = 0;
  constructor(ctx: AudioContextShim) {
    super(ctx, NODE.compressor);
    this.threshold = new AudioParamShim(ctx, this._id, 0, -24); this.knee = new AudioParamShim(ctx, this._id, 1, 30);
    this.ratio = new AudioParamShim(ctx, this._id, 2, 12); this.attack = new AudioParamShim(ctx, this._id, 3, 0.003);
    this.release = new AudioParamShim(ctx, this._id, 4, 0.25);
  }
}

export class AudioBufferShim {
  readonly sampleRate: number; readonly length: number; readonly numberOfChannels: number;
  _id: number; _channels: Float32Array[];
  constructor(options: { length: number; sampleRate: number; numberOfChannels?: number } | { _id: number; channels: ArrayBuffer[]; sampleRate: number }) {
    if ('_id' in options) {
      this._id = options._id; this.sampleRate = options.sampleRate;
      this._channels = options.channels.map((b) => new Float32Array(b));
    } else {
      this.sampleRate = options.sampleRate;
      const r = N.audio(A.createBuffer, options.numberOfChannels ?? 1, options.length, options.sampleRate) as [number, ...ArrayBuffer[]];
      this._id = r[0]; this._channels = r.slice(1).map((b) => new Float32Array(b as ArrayBuffer));
    }
    this.numberOfChannels = this._channels.length;
    this.length = this._channels[0]?.length ?? 0;
  }
  get duration() { return this.length / this.sampleRate; }
  getChannelData(c: number) { return this._channels[c]; }
  copyFromChannel(dest: Float32Array, c: number, start = 0) { dest.set(this._channels[c].subarray(start, start + dest.length)); }
  copyToChannel(src: Float32Array, c: number, start = 0) { this._channels[c].set(src, start); }
}

export class AudioBufferSourceNodeShim extends AudioNodeShim {
  buffer: AudioBufferShim | null = null;
  loop = false; loopStart = 0; loopEnd = 0;
  readonly playbackRate: AudioParamShim; readonly detune: AudioParamShim;
  onended: ((e: unknown) => void) | null = null;
  _started = false;
  constructor(ctx: AudioContextShim) {
    super(ctx, NODE.source);
    this.numberOfInputs = 0;
    this.playbackRate = new AudioParamShim(ctx, this._id, 0, 1);
    this.detune = new AudioParamShim(ctx, this._id, 1, 0);
  }
  start(when = 0, offset = 0, duration?: number) {
    if (this._started) throw new Error('InvalidStateError: start() was already called');
    this._started = true;
    ended.set(this._id, this);
    N.audio(A.start, this._id, this.buffer ? this.buffer._id : 0, when, offset, duration ?? -1, this.loop ? 1 : 0);
  }
  stop(when = 0) {
    if (!this._started) throw new Error('InvalidStateError: stop() before start()');
    // The mixer drops the buffer right away when the stop time has come, and reports 'ended'.
    N.audio(A.stop, this._id, when);
  }
}

export class AudioContextShim extends EventTargetShim {
  readonly sampleRate: number;
  readonly destination: AudioNodeShim;
  state: 'running' | 'suspended' | 'closed' = 'running';
  onstatechange: ((e: unknown) => void) | null = null;
  readonly listener = {};
  readonly audioWorklet = undefined;
  constructor() {
    super();
    this.sampleRate = N.audio(A.init) as number;
    this.destination = new AudioNodeShim(this, NODE.destination, 0);
  }
  get currentTime() { return N.audio(A.time) as number; }
  get baseLatency() { return 0.005; }
  get outputLatency() { return N.audio(A.latency) as number; }
  getOutputTimestamp() { const [contextTime, performanceTime] = N.audio(A.timestamp) as [number, number]; return { contextTime, performanceTime }; }
  _setState(s: 'running' | 'suspended' | 'closed') { if (this.state === s) return; this.state = s; this.dispatchEvent(new EventShim('statechange')); }
  resume() { N.audio(A.resume); this._setState('running'); return Promise.resolve(); }
  suspend() { N.audio(A.suspend); this._setState('suspended'); return Promise.resolve(); }
  close() { N.audio(A.suspend); this._setState('closed'); return Promise.resolve(); }
  createGain() { return new GainNodeShim(this); }
  createBufferSource() { return new AudioBufferSourceNodeShim(this); }
  createDynamicsCompressor() { return new DynamicsCompressorNodeShim(this); }
  createBuffer(numberOfChannels: number, length: number, sampleRate: number) { return new AudioBufferShim({ numberOfChannels, length, sampleRate }); }
  decodeAudioData(data: ArrayBuffer, ok?: (b: AudioBufferShim) => void, fail?: (e: Error) => void) {
    return new Promise<AudioBufferShim>((resolve, reject) => {
      N.audio(A.decode, new Uint8Array(data), (id: number, rate: number, channels: ArrayBuffer[] | null, error?: string) => {
        if (!id || !channels) { const e = new Error(`EncodingError: ${error ?? 'decode failed'}`); fail?.(e); reject(e); return; }
        const b = new AudioBufferShim({ _id: id, channels, sampleRate: rate });
        ok?.(b); resolve(b);
      });
    });
  }
}

export function installAudio(g: Record<string, unknown>) {
  Object.assign(g, {
    AudioContext: AudioContextShim, webkitAudioContext: AudioContextShim, BaseAudioContext: AudioContextShim,
    AudioNode: AudioNodeShim, GainNode: GainNodeShim, AudioParam: AudioParamShim, AudioBuffer: AudioBufferShim,
    AudioBufferSourceNode: AudioBufferSourceNodeShim, DynamicsCompressorNode: DynamicsCompressorNodeShim,
  });
  ended = new Map();
}
