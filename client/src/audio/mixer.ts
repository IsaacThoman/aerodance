import { loadSound } from '../menu/soundSettings.ts';
import type { SoundSettings } from '../menu/soundSettings.ts';
import { onHostChange } from '../host.ts';

/*
 * One AudioContext for the page, wired like a little mixing desk:
 *
 *   menu music ─ menuMusic ─ menuDuck ─┐
 *   in-game songs (songPlayer.js) ──────┴─ music ─┐
 *   button sounds ─────────── sfx ────┴─ master ─ limiter ─ speakers
 *
 * applySound(sound) maps Settings → Sound onto it:
 *   Master     master: everything
 *   Music      music: all music, menu and in-game
 *   Effects    sfx: button sounds
 *   Menu music menuMusic: on/off for the menu's background track only
 *   Mute all   master off
 *
 * duckMenuMusic(true) fades the menu track out under a song (Song Select's preview) and back
 * in afterwards, without touching the Menu music setting.
 *
 * Browsers keep audio suspended until the first click, tap or key press; the context
 * resumes on that gesture. The same goes after an interruption: a phone call, Siri or an
 * alarm stops WebKit's context ('interrupted', a WebKit-only state, or 'suspended'), and
 * WebKit doesn't always start it again afterwards, so the next gesture does (resumeAudio).
 * In the iPhone/iPad app, the end of the interruption (host.ts) tries straight away too.
 */

export interface Mixer {
  ctx: AudioContext;
  master: GainNode;
  music: GainNode;
  menuMusic: GainNode;
  menuDuck: GainNode;
  sfx: GainNode;
}
/** The mixer inputs music plays into. */
export type MusicChannel = 'music' | 'menuMusic';

// Kept on the page rather than in the module, so a hot-reloaded copy of this file still shares it.
const KEY: unique symbol = Symbol.for('aerodance.mixer');
const page = globalThis as typeof globalThis & { [KEY]?: Mixer };

// Sliders are linear 0..1; squaring makes equal slider moves sound like equal steps.
const level = (v: number) => Math.max(0, Math.min(1, Number(v) || 0)) ** 2;

export function getMixer(): Mixer {
  const shared = page[KEY];
  if (shared) return shared;
  const ctx = new AudioContext();
  const gain = () => ctx.createGain();
  const master = gain();
  const music = gain();
  const menuMusic = gain();
  const menuDuck = gain();
  const sfx = gain();
  // Catches the odd peak when a button pop lands on a loud bar of music.
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.1;

  menuMusic.connect(menuDuck).connect(music);
  music.connect(master);
  sfx.connect(master);
  master.connect(limiter).connect(ctx.destination);
  const mixer: Mixer = { ctx, master, music, menuMusic, menuDuck, sfx };
  page[KEY] = mixer;

  const unlock = () => resumeAudio(ctx);
  for (const type of ['pointerdown', 'pointerup', 'keydown', 'touchend']) window.addEventListener(type, unlock, true);
  onHostChange((host) => { if (!host.interrupted) unlock(); });

  applySound(loadSound());
  return mixer;
}

/** Starts a suspended or interrupted context again (works from a user gesture). */
export function resumeAudio(ctx: AudioContext = getMixer().ctx) {
  // 'interrupted' isn't in TypeScript's AudioContextState, so test for what can't resume.
  if (ctx.state !== 'running' && ctx.state !== 'closed') ctx.resume().catch(() => {});
}

const set = (param: AudioParam, value: number, ctx: BaseAudioContext) => {
  // A short timed ramp (no zipper noise while a slider is dragged). Not setTargetAtTime:
  // Chrome only advances that glide while sound flows through the node, so an idle effects
  // channel would play its next button sound at the old volume.
  const now = ctx.currentTime;
  param.cancelScheduledValues(now);
  param.setValueAtTime(param.value, now);
  param.linearRampToValueAtTime(value, now + 0.03);
};

export function applySound(sound: SoundSettings) {
  const { ctx, master, music, menuMusic, sfx } = getMixer();
  set(master.gain, sound.muted ? 0 : level(sound.master), ctx);
  set(music.gain, level(sound.music), ctx);
  set(menuMusic.gain, sound.menuMusic === false ? 0 : 1, ctx);
  set(sfx.gain, level(sound.sfx), ctx);
}

export function duckMenuMusic(on: boolean) {
  const { ctx, menuDuck } = getMixer();
  const now = ctx.currentTime;
  menuDuck.gain.cancelScheduledValues(now);
  menuDuck.gain.setValueAtTime(menuDuck.gain.value, now);
  menuDuck.gain.linearRampToValueAtTime(on ? 0 : 1, now + (on ? 0.4 : 1.2));
}
