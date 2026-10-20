import { onHostChange } from '../host.ts';

/*
 * What takes a song away from the players, besides a hidden tab: the audio stopping (a phone
 * call, Siri or an alarm: WebKit's context goes 'interrupted' or 'suspended', and the iPhone/iPad
 * app says interrupted) and the camera going quiet (WebKit mutes it for a call, and iPadOS
 * whenever aerodance isn't full screen). Each calls pause(cause) as it starts; GameSession.pause()
 * only acts during the countdown or the song, and Resume (a user gesture, which also restarts
 * the audio) carries on. A camera that is still interrupted then doesn't pause it again.
 * The camera pauses only once it has been quiet for CAMERA_GRACE_MS: Chrome also mutes a camera
 * that merely stalls for a moment, which shouldn't stop the song.
 *
 * const off = watchInterruptions((cause) => session.pause(), { audio: ctx, camera });
 */

export interface InterruptionSources {
  /** The mixer's AudioContext (statechange). */
  audio?: Pick<AudioContext, 'state' | 'addEventListener' | 'removeEventListener'>;
  /** The live camera: interrupted while WebKit has muted it (WebcamPoseSource). */
  camera?: { subscribe(listener: (view: { interrupted?: boolean }) => void): () => void } | null;
  /** Where the iPhone/iPad app's 'aerodance-host' events arrive. */
  host?: EventTarget;
}

export type InterruptionCause = 'audio' | 'camera';

export const CAMERA_GRACE_MS = 1500;

export function watchInterruptions(pause: (cause: InterruptionCause) => void, { audio, camera, host }: InterruptionSources) {
  const onAudio = () => { if (audio && audio.state !== 'running' && audio.state !== 'closed') pause('audio'); };
  audio?.addEventListener('statechange', onAudio);
  const offHost = onHostChange((state) => { if (state.interrupted) pause('audio'); }, host);
  let muted: boolean | null = null;
  let grace: ReturnType<typeof setTimeout> | undefined;
  const offCamera = camera?.subscribe((view) => {
    const now = !!view.interrupted;
    // Subscribing reports the current view: only a change pauses.
    if (now && muted === false) grace = setTimeout(() => pause('camera'), CAMERA_GRACE_MS);
    if (!now) clearTimeout(grace);
    muted = now;
  });
  return () => {
    clearTimeout(grace);
    audio?.removeEventListener('statechange', onAudio);
    offHost();
    offCamera?.();
  };
}
