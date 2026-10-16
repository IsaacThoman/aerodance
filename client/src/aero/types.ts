import type * as THREE from 'three';

export type AeroQuality = 'auto' | 'high' | 'low';

export type AeroZone = 'Above the clouds' | 'Cloud layer' | 'Downtown' | 'The lake' | 'Flower meadow' | 'Skyline';

export interface AeroTelemetry {
  altitude: number;
  speedKmh: number;
  zone: AeroZone;
  /** Position around the loop, 0..1. */
  progress: number;
}

export interface AeroSettings {
  /** Flight speed multiplier. */
  speed?: number;
  quality?: AeroQuality;
  /** Starting position around the loop, 0..1. */
  start?: number;
  /** Called about four times per second. */
  onTelemetry?: ((telemetry: AeroTelemetry) => void) | null;
}

export interface AeroWorldOptions extends AeroSettings {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
}

export interface AeroWorldHandle {
  update(delta: number): void;
  render(): void;
  dispose(): void;
  setSpeed(speed: number): void;
  readonly progress: number;
}

export interface AeroBackgroundOptions extends AeroSettings {
  maxPixelRatio?: number;
}

export interface AeroBackgroundHandle {
  destroy(): void;
  setPaused(paused: boolean): void;
  setSpeed(speed: number): void;
  readonly progress: number;
}
