import { isObject } from '../../../../packages/pose/choreography.ts';

const KEY = 'aerodance.sound';

/** Settings → Sound: slider levels 0..1 and the two switches (audio/mixer.ts applies them). */
export interface SoundSettings { master: number; music: number; sfx: number; menuMusic: boolean; muted: boolean; }

// muted silences everything; menuMusic: false turns off just the background music.
export const DEFAULT_SOUND: SoundSettings = { master: 0.8, music: 0.8, sfx: 0.8, menuMusic: true, muted: false };

// Saved settings come from storage: keep only the fields that have the right type.
function savedSound(saved: unknown): Partial<SoundSettings> {
  const sound: Partial<SoundSettings> = {};
  if (!isObject(saved)) return sound;
  for (const key of ['master', 'music', 'sfx'] as const) {
    const v = saved[key];
    if (typeof v === 'number') sound[key] = v;
  }
  for (const key of ['menuMusic', 'muted'] as const) {
    const v = saved[key];
    if (typeof v === 'boolean') sound[key] = v;
  }
  return sound;
}

export function loadSound(): SoundSettings {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    return saved ? { ...DEFAULT_SOUND, ...savedSound(saved) } : DEFAULT_SOUND;
  } catch {
    return DEFAULT_SOUND;
  }
}

export function saveSound(sound: SoundSettings) {
  try { localStorage.setItem(KEY, JSON.stringify(sound)); } catch { /* storage unavailable */ }
}
