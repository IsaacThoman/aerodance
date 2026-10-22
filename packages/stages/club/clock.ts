import * as THREE from 'three';
import { beat, stagePlay } from '../shared/hooks.ts';

// Club-wide uniforms shared by reference across every club material, so one
// update per frame drives the floor, walls, beams and screens in sync.
export const club = {
  uTime: { value: 0 },
  uBeat: { value: 0 }, // continuous beat count
  uPulse: { value: 0 }, // 1 on the beat, decaying
  uBallPos: { value: new THREE.Vector3(0, 6.0, 0.4) },
  uBallRot: { value: 0 },
  uDots: { value: 1 }, // mirror-ball dot intensity
  uCalm: { value: 0 }, // 1 during the preview and the song: no confetti
  uSteady: { value: 0 }, // 1 in the game (preview, song and results): nothing flashes on the beat
} satisfies Record<string, THREE.IUniform>;

export const BALL_POS = club.uBallPos.value;

// The beat pulse's average over a beat, which steady lights hold instead of flashing.
const PULSE_MEAN = (1 - Math.exp(-6)) / 6;

export function tickClub(t: number, delta: number) {
  const ease = Math.min(1, delta * 4);
  club.uCalm.value += ((stagePlay.dancing ? 1 : 0) - club.uCalm.value) * ease;
  club.uSteady.value += ((stagePlay.dancing || stagePlay.celebrating ? 1 : 0) - club.uSteady.value) * ease;
  club.uTime.value = t;
  club.uBeat.value = beat.beat + beat.phase;
  club.uPulse.value = THREE.MathUtils.lerp(beat.pulse, PULSE_MEAN, club.uSteady.value);
  club.uBallRot.value = t * 0.22;
  club.uDots.value = 0.85 + 0.25 * club.uPulse.value;
}

export const beatCount = () => beat.beat + beat.phase;

// Show palette: neon on deep navy.
export const C = {
  night: '#060a26',
  aqua: '#1ee8ff',
  lime: '#9dff3a',
  magenta: '#ff3fd2',
  violet: '#8d5cff',
};

// Lime -> aqua -> blue -> violet -> magenta, ping-ponged so neighbours never
// mix into mud. Mirrors clubHue() in GLSL.
const HUES = ['#9dff3a', '#1ee8ff', '#2e8bff', '#8d5cff', '#ff3fd2'].map((c) => new THREE.Color(c));
export function hue(t: number, out: THREE.Color) {
  const s = 1 - Math.abs((((t % 1) + 1) % 1) * 2 - 1);
  const x = s * (HUES.length - 1);
  const i = Math.min(Math.floor(x), HUES.length - 2);
  const f = x - i;
  return out.copy(HUES[i]).lerp(HUES[i + 1], f * f * (3 - 2 * f));
}
