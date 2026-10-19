// Web Audio for the game (client/src/audio/): AudioContext, gain nodes with automation, buffer
// sources and decodeAudioData, over the native mixer in src/Audio.mm.
import { native } from './native.ts';

export function installAudio(_g: Record<string, unknown>) {
  void native;
}
