// The Studio's webcam: the game's own tracker (packages/pose/browser), so a routine is recorded
// through exactly the tracking its players will be scored with. One camera for the whole app;
// stations start it when they need it and it keeps running between them.
import { PoseSourceController } from '../../../../../packages/pose/browser/PoseSourceController.ts';
import type { PoseSourceView } from '../../../../../packages/pose/browser/PoseSourceController.ts';
import type { WebcamRecordEvent } from '../../../../../packages/pose/browser/WebcamPoseSource.ts';
import type { PlayerCount } from '../../../../../packages/pose/choreography.ts';

let controller: PoseSourceController | null = null;
/** The shared camera, made on first use (making it asks the browser which cameras exist). */
export function camera(): PoseSourceController { return controller ??= new PoseSourceController(); }
export const cameraOn = (view: Pick<PoseSourceView, 'status'>) => view.status === 'connected' || view.status === 'connecting' || view.status === 'initializing';
/** Starts the camera tracking `people` (1 to 4), restarting it if it was tracking a different number. */
export async function startCamera(people: PlayerCount = 1): Promise<void> {
  const cam = camera();
  if (cam.playerCount !== people) {
    const on = cameraOn(cam.view);
    if (on) cam.disconnect();
    await cam.setPlayerCount(people);
  }
  if (!cameraOn(cam.view)) await cam.connect();
}
export function stopCamera() { controller?.disconnect(); }
export type { PoseSourceView, WebcamRecordEvent };
