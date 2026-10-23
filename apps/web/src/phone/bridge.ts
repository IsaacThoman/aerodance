/*
 * The phone camera page's link to the iPhone/iPad app (apps/ios/src/main.m), which shows the
 * page over the game when the player taps the main menu's camera bubble
 * (menu/PhoneCameraButton.tsx), or when a game's QR code is scanned with the app installed (a
 * universal link: the app opens /pair/?code=<code>).
 *
 * Page to app, through webkit.messageHandlers.aerodanceCamera:
 *   { close: true }       back to the game (the code screen's close button)
 *   { stage, dim }        the PhoneLink stage, and whether the page is dimmed: the app keeps the
 *                         screen on while the phone pairs and tracks, and darkens around a dimmed page
 *
 * The app also sets globalThis.__aerodanceSite, the deployed site the page pairs through.
 * Outside the app nothing is listening: inApp() is false and messages go nowhere.
 */

import type { PhoneStage } from './PhoneLink.ts';

interface Handler { postMessage(message: unknown): void; }
type CameraWindow = { webkit?: { messageHandlers?: { aerodanceCamera?: Handler } } };
const handler = () => (globalThis as CameraWindow).webkit?.messageHandlers?.aerodanceCamera;

/** The page runs in the iPhone/iPad app, which reads its messages. */
export const inApp = () => !!handler();

function post(message: object) {
  try { handler()?.postMessage(message); } catch { /* the app has gone */ }
}

/** Back to the game. */
export const closeCamera = () => post({ close: true });

/** What the page shows, for the app. */
export const reportStage = (stage: PhoneStage, dim: boolean) => post({ stage, dim });
