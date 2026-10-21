import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Camera } from 'three';

/** Keep a reflection texture between refreshes, but capture camera cuts immediately. */
export class ReflectionRefresh {
  private readonly interval: number;
  private next = -Infinity;
  private camera: Camera | null = null;
  private readonly position = new Vector3();
  private readonly rotation = new Quaternion();
  private readonly projection = new Matrix4();
  private lastTime = -Infinity;

  constructor(fps: number) {
    this.interval = 1 / fps;
  }

  shouldRefresh(time: number, camera: Camera): boolean {
    const cut = camera !== this.camera || time < this.lastTime
      || camera.position.distanceToSquared(this.position) > 16
      || camera.quaternion.angleTo(this.rotation) > 0.12
      || !camera.projectionMatrix.equals(this.projection);
    if (!cut && time + 1e-6 < this.next) return false;

    // Retain the fractional frame between captures instead of drifting to 20 FPS at 59 Hz.
    this.next = cut || time >= this.next + this.interval
      ? time + this.interval
      : this.next + this.interval;
    this.lastTime = time;
    this.camera = camera;
    this.position.copy(camera.position);
    this.rotation.copy(camera.quaternion);
    this.projection.copy(camera.projectionMatrix);
    return true;
  }
}
