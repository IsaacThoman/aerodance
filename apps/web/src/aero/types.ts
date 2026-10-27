import type * as THREE from 'three';

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
  /** Starting position around the loop, 0..1. */
  start?: number;
  /** Called about four times per second. */
  onTelemetry?: ((telemetry: AeroTelemetry) => void) | null;
}

/**
 * A part of the world that diagnostics can leave out, to measure what it costs: each builder's
 * objects, plus 'shadows' (the sun's shadow map) and 'reflection' (the lake's reflection pass).
 */
export type AeroPart =
  | 'sky' | 'ground' | 'city' | 'lake' | 'lamps' | 'trees' | 'traffic' | 'grass' | 'flowers' | 'tulips'
  | 'windmills' | 'butterflies' | 'birds' | 'balloons' | 'clouds' | 'bubbles' | 'sparkles' | 'jet' | 'flare'
  | 'shadows' | 'reflection';

export interface AeroWorldOptions extends AeroSettings {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Diagnostics: parts left out. They are still built (the layout doesn't change), just not drawn or animated. */
  hide?: readonly AeroPart[];
  /** Moves the camera each frame after the drone has (walk mode), before anything follows it. */
  steer?: ((camera: THREE.PerspectiveCamera) => void) | null;
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
