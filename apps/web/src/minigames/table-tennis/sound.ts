/*
 * Table Tennis's sounds, made on the spot (no files) on the mixer's effects channel
 * (audio/mixer.ts: the Effects slider): the pock of a paddle, the tick of the table, the net's
 * thud and the floor's tap, each as loud and as bright as the ball was fast, and from the side
 * it happened on. A hit you can hear is one you know you made, even when the picture is a frame
 * or two behind the hand.
 */

import { getMixer } from '../../audio/mixer.ts';
import type { FlightEvent } from './flight.ts';

/** Each sound: its tone's pitch (Hz) at a gentle and at a hard hit, how long it rings (s), how much of it is noise, and its loudness. */
const SOUNDS: Record<FlightEvent['type'], { from: number; to: number; ring: number; noise: number; gain: number }> = {
  paddle: { from: 620, to: 980, ring: 0.07, noise: 0.5, gain: 0.5 },
  table: { from: 1500, to: 2100, ring: 0.045, noise: 0.25, gain: 0.34 },
  net: { from: 180, to: 240, ring: 0.09, noise: 0.9, gain: 0.3 },
  floor: { from: 900, to: 1300, ring: 0.04, noise: 0.4, gain: 0.2 },
};
/** A ball this fast (m/s) is as loud as it gets. */
const LOUDEST = 9;

let noise: AudioBuffer | null = null;
/** A fifth of a second of white noise, made once. */
function noiseBuffer(ctx: AudioContext) {
  if (noise && noise.sampleRate === ctx.sampleRate) return noise;
  noise = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.2), ctx.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return noise;
}

/**
 * Plays what the ball just hit: `pan` from -1 (the left speaker) to 1. Nothing while the page's
 * audio hasn't started (before the first click or key).
 */
export function playBallSound(event: FlightEvent, pan = 0) {
  const { ctx, sfx } = getMixer();
  if (ctx.state !== 'running') return;
  const sound = SOUNDS[event.type];
  const hard = Math.min(1, Math.max(0, event.speed / LOUDEST));
  const now = ctx.currentTime;
  const out = ctx.createGain();
  out.gain.setValueAtTime(sound.gain * (0.25 + 0.75 * Math.sqrt(hard)), now);
  out.gain.exponentialRampToValueAtTime(0.0008, now + sound.ring);
  const side = ctx.createStereoPanner();
  side.pan.value = Math.min(1, Math.max(-1, pan));
  out.connect(side).connect(sfx);
  // The tone: a short falling ping.
  const pitch = sound.from + (sound.to - sound.from) * hard;
  const tone = ctx.createOscillator();
  tone.type = 'triangle';
  tone.frequency.setValueAtTime(pitch * 1.25, now);
  tone.frequency.exponentialRampToValueAtTime(pitch, now + sound.ring * 0.6);
  const toneGain = ctx.createGain();
  toneGain.gain.value = 1 - sound.noise;
  tone.connect(toneGain).connect(out);
  tone.start(now);
  tone.stop(now + sound.ring + 0.02);
  // The knock: a burst of noise round the same pitch.
  const knock = ctx.createBufferSource();
  knock.buffer = noiseBuffer(ctx);
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = pitch * 1.6;
  band.Q.value = 1.2;
  const knockGain = ctx.createGain();
  knockGain.gain.value = sound.noise * 1.6;
  knock.connect(band).connect(knockGain).connect(out);
  knock.start(now, Math.random() * 0.1, sound.ring + 0.02);
  tone.onended = () => side.disconnect();
}
